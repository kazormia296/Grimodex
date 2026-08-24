//! NIR-0 C2B pure material-basis contract RED.
//!
//! This test names the Native-only typed seam before the implementation is
//! present. It remains independent of SQLite writes, current-pointer
//! promotion, Freshness publication, and Electron transport.

use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_db::narrative_extraction::human_material_basis::{
    project_d1_declaration_set, project_v1_expectations, resolve_human_material_basis,
    validate_d1_parent_authority, validate_v1_parent_authority, D1ParentAuthority,
    D1ParentSnapshot, HumanMaterialDerivationKind, HumanMaterialResolutionContext, MaterialBasis,
    TrustedDependencyEntry, TrustedEvidenceEntry, TrustedHumanMaterialResolution,
    TrustedSourceBasisEntry, V1EdgeExpectation, V1ParentAuthority, V1PersistedEdge,
};
use grimodex_db::narrative_extraction::CreateHumanDerivedRevisionRequest;
use serde_json::{json, Value};

const SCENE_SOURCE_KEY: &str = "project:scene:scene-1";
const SOURCE_REVISION_TOKEN: &str = "v0@2026-01-01T00:00:00.000Z";
const PARENT_REVISION_ID: &str = "revision-parent";
const PARENT_RUN_ID: &str = "run-parent";
const D1_PRODUCER_ID: &str = "proposal-revision-source-basis";

fn digest(value: &Value) -> String {
    canonical_json_digest(value).expect("canonical digest")
}

fn source_basis() -> Value {
    json!([{
        "sourceKind": "scene-body",
        "sourceKey": SCENE_SOURCE_KEY,
        "revisionToken": SOURCE_REVISION_TOKEN
    }])
}

fn evidence_set() -> Value {
    json!([{
        "evidenceRef": "anchor:arrival",
        "documentRef": "document:1",
        "quote": "Arrival.",
        "quoteDigest": "sha256:61b3366c3dc326b93fb56073b11453dea0d2db2fe6f79588ce266188edd24c67",
        "sourceKey": SCENE_SOURCE_KEY,
        "revisionToken": SOURCE_REVISION_TOKEN
    }])
}

fn component_contract_digest() -> String {
    digest(&json!({
        "schemaVersion": 1,
        "componentContractId": "chronicle.event-synthesis.prompt",
        "componentContractVersion": "1"
    }))
}

fn dependency_set() -> Value {
    json!([
        {
            "dependencyId": "dependency:evidence",
            "inputRef": SCENE_SOURCE_KEY,
            "contextIds": [],
            "role": "direct-evidence",
            "selector": {"kind": "whole-source"}
        },
        {
            "dependencyId": "dependency:component-contract",
            "inputRef": "component:chronicle.event-synthesis.prompt",
            "contextIds": [],
            "role": "component-contract",
            "selector": {
                "kind": "component-contract",
                "contractId": "chronicle.event-synthesis.prompt",
                "contractDigest": component_contract_digest()
            }
        },
        {
            "dependencyId": "dependency:scope",
            "inputRef": SCENE_SOURCE_KEY,
            "contextIds": [],
            "role": "scope-resolution",
            "selector": {"kind": "whole-source"}
        }
    ])
}

fn material_json() -> Value {
    let source = source_basis();
    let evidence = evidence_set();
    let dependencies = dependency_set();
    json!({
        "sourceBasis": source,
        "evidenceSet": evidence,
        "dependencySet": dependencies,
        "dependencySetDigest": digest(&dependencies),
        "materialBasisDigest": digest(&json!({
            "sourceBasis": source,
            "evidenceSet": evidence,
            "dependencySet": dependencies
        }))
    })
}

fn material() -> MaterialBasis {
    serde_json::from_value(material_json()).expect("typed material basis")
}

fn resolution_context(scope_override: bool) -> HumanMaterialResolutionContext {
    let parent_envelope = json!({
        "schemaVersion": 2,
        "parentRevisionId": PARENT_REVISION_ID,
        "sourceBasis": source_basis()
    });
    HumanMaterialResolutionContext {
        project_id: "project-a".to_owned(),
        parent_revision_id: PARENT_REVISION_ID.to_owned(),
        expected_parent_envelope_digest: digest(&parent_envelope),
        scene_ref: "scene:1".to_owned(),
        edited_document_ref: "document:1".to_owned(),
        secret_scope: scope_override,
    }
}

fn trusted_scope_resolution(
    context: &HumanMaterialResolutionContext,
) -> TrustedHumanMaterialResolution {
    TrustedHumanMaterialResolution {
        project_id: context.project_id.clone(),
        parent_revision_id: context.parent_revision_id.clone(),
        expected_parent_envelope_digest: context.expected_parent_envelope_digest.clone(),
        scene_ref: context.scene_ref.clone(),
        edited_document_ref: context.edited_document_ref.clone(),
        source_basis: vec![
            TrustedSourceBasisEntry {
                source_kind: "scene-body".to_owned(),
                source_key: SCENE_SOURCE_KEY.to_owned(),
                revision_token: SOURCE_REVISION_TOKEN.to_owned(),
                revision_observed_at: None,
            },
            TrustedSourceBasisEntry {
                source_kind: "evidence-anchor".to_owned(),
                source_key: "evidence:scope-resolution-1".to_owned(),
                revision_token: "v0@2026-01-01T00:00:01.000Z".to_owned(),
                revision_observed_at: None,
            },
        ],
        evidence_set: vec![TrustedEvidenceEntry {
            evidence_ref: "anchor:arrival".to_owned(),
            document_ref: "document:1".to_owned(),
            quote: "Arrival.".to_owned(),
            quote_digest: "sha256:61b3366c3dc326b93fb56073b11453dea0d2db2fe6f79588ce266188edd24c67"
                .to_owned(),
            source_key: SCENE_SOURCE_KEY.to_owned(),
            revision_token: SOURCE_REVISION_TOKEN.to_owned(),
        }],
        dependency_set: vec![
            TrustedDependencyEntry {
                dependency_id: "dependency:evidence".to_owned(),
                input_ref: SCENE_SOURCE_KEY.to_owned(),
                context_ids: vec![],
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::WholeSource,
            },
            TrustedDependencyEntry {
                dependency_id: "dependency:component-contract".to_owned(),
                input_ref: "component:chronicle.event-synthesis.prompt".to_owned(),
                context_ids: vec![],
                role: DependencyRole::ComponentContract,
                selector: DependencySelector::ComponentContract {
                    contract_id: "chronicle.event-synthesis.prompt".to_owned(),
                    contract_digest: component_contract_digest(),
                },
            },
            TrustedDependencyEntry {
                dependency_id: "dependency:scope".to_owned(),
                input_ref: "evidence:scope-resolution-1".to_owned(),
                context_ids: vec![],
                role: DependencyRole::ScopeResolution,
                selector: DependencySelector::WholeSource,
            },
        ],
    }
}

fn d1_parent_authority() -> D1ParentAuthority {
    D1ParentAuthority {
        project_id: "project-a".to_owned(),
        consumer_kind: "proposal-revision".to_owned(),
        consumer_key: "revision-child".to_owned(),
        producer_id: D1_PRODUCER_ID.to_owned(),
        producer_generation: 1,
    }
}

fn v1_parent_authority() -> V1ParentAuthority {
    V1ParentAuthority {
        consumer_kind: "proposal-revision".to_owned(),
        consumer_key: PARENT_REVISION_ID.to_owned(),
        owning_run_id: PARENT_RUN_ID.to_owned(),
    }
}

#[test]
fn projection_preserves_all_material_sets_and_digests() {
    let parent = material();
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent,
        &resolution_context(false),
        None,
    )
    .expect("projection-only material resolution");

    assert_eq!(resolved.material_basis.source_basis, parent.source_basis);
    assert_eq!(resolved.material_basis.evidence_set, parent.evidence_set);
    assert_eq!(
        resolved.material_basis.dependency_set,
        parent.dependency_set
    );
    assert_eq!(
        resolved.material_basis.dependency_set_digest,
        parent.dependency_set_digest
    );
    assert_eq!(
        resolved.material_basis.material_basis_digest,
        parent.material_basis_digest
    );
}

#[test]
fn forged_material_digest_is_rejected_separately_from_positive_projection() {
    let mut forged_json = material_json();
    forged_json["materialBasisDigest"] =
        json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let forged: MaterialBasis =
        serde_json::from_value(forged_json).expect("digest forgery is structurally typed");

    let error = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &forged,
        &resolution_context(false),
        None,
    )
    .expect_err("a forged parent material digest must fail closed");
    assert!(error.to_string().contains("digest"));
}

#[test]
fn scope_override_rejects_unexpected_sidecar_and_replaces_only_scope_dependency() {
    let mut unexpected = material_json();
    unexpected["materialSidecar"] = json!({"clientOwned": true});
    assert!(
        serde_json::from_value::<MaterialBasis>(unexpected).is_err(),
        "the client-shaped material basis must reject an unexpected sidecar"
    );

    let parent = material();
    let context = resolution_context(true);
    assert!(resolve_human_material_basis(
        HumanMaterialDerivationKind::ScopeOverride,
        &parent,
        &context,
        None,
    )
    .is_err());

    let trusted = trusted_scope_resolution(&context);
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ScopeOverride,
        &parent,
        &context,
        Some(&trusted),
    )
    .expect("scope override material resolution");
    assert!(resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent,
        &resolution_context(false),
        Some(&trusted),
    )
    .is_err());

    assert_eq!(resolved.material_basis.evidence_set, parent.evidence_set);

    let parent_dependencies =
        serde_json::to_value(&parent.dependency_set).expect("parent dependency set JSON");
    let child_dependencies = serde_json::to_value(&resolved.material_basis.dependency_set)
        .expect("child dependency set JSON");
    let without_scope = |value: &Value| {
        value
            .as_array()
            .expect("dependency array")
            .iter()
            .filter(|entry| entry.get("role").and_then(Value::as_str) != Some("scope-resolution"))
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(
        without_scope(&child_dependencies),
        without_scope(&parent_dependencies)
    );
    assert_ne!(child_dependencies, parent_dependencies);
    assert_ne!(
        resolved.material_basis.dependency_set_digest,
        parent.dependency_set_digest
    );
    assert!(child_dependencies
        .as_array()
        .expect("dependency array")
        .iter()
        .any(
            |entry| entry.get("role").and_then(Value::as_str) == Some("scope-resolution")
                && entry.get("inputRef").and_then(Value::as_str)
                    == Some("evidence:scope-resolution-1")
        ));
    let child_sources = serde_json::to_value(&resolved.material_basis.source_basis)
        .expect("child source basis JSON");
    let parent_sources =
        serde_json::to_value(&parent.source_basis).expect("parent source basis JSON");
    let child_non_scope_sources = child_sources
        .as_array()
        .expect("source basis array")
        .iter()
        .filter(|entry| entry.get("sourceKind").and_then(Value::as_str) != Some("evidence-anchor"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(Value::Array(child_non_scope_sources), parent_sources);
    assert!(child_sources
        .as_array()
        .expect("source basis array")
        .iter()
        .any(
            |entry| entry.get("sourceKind").and_then(Value::as_str) == Some("scene-body")
                && entry.get("sourceKey").and_then(Value::as_str) == Some(SCENE_SOURCE_KEY)
        ));
    assert!(child_sources
        .as_array()
        .expect("source basis array")
        .iter()
        .any(
            |entry| entry.get("sourceKind").and_then(Value::as_str) == Some("evidence-anchor")
                && entry.get("sourceKey").and_then(Value::as_str)
                    == Some("evidence:scope-resolution-1")
        ));
}

#[test]
fn d1_projection_requires_direct_and_component_declarations_and_parent_parity() {
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &material(),
        &resolution_context(false),
        None,
    )
    .expect("projection-only material resolution");
    let authority = d1_parent_authority();
    let projection = project_d1_declaration_set(&resolved.material_basis, &authority)
        .expect("D1 declaration projection");

    assert!(projection
        .declarations
        .iter()
        .any(|declaration| declaration.role == DependencyRole::DirectEvidence));
    assert!(projection
        .declarations
        .iter()
        .any(|declaration| declaration.role == DependencyRole::ComponentContract));
    let snapshot = D1ParentSnapshot {
        project_id: authority.project_id.clone(),
        consumer_kind: authority.consumer_kind.clone(),
        consumer_key: authority.consumer_key.clone(),
        producer_id: authority.producer_id.clone(),
        producer_generation: authority.producer_generation,
        declarations: projection.declarations.clone(),
    };
    validate_d1_parent_authority(&projection, &snapshot).expect("parent D1 authority parity");

    let mut missing_component = snapshot.clone();
    missing_component
        .declarations
        .retain(|declaration| declaration.role != DependencyRole::ComponentContract);
    assert!(validate_d1_parent_authority(&projection, &missing_component).is_err());

    let mut wrong_generation = snapshot;
    wrong_generation.producer_generation = 0;
    assert!(validate_d1_parent_authority(&projection, &wrong_generation).is_err());
}

#[test]
fn v1_projection_is_source_basis_only_and_rejects_shape_or_owner_drift() {
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &material(),
        &resolution_context(false),
        None,
    )
    .expect("projection-only material resolution");
    let authority = v1_parent_authority();
    let expected = project_v1_expectations(&resolved.material_basis, &authority)
        .expect("V1 compatibility expectation projection");
    assert_eq!(
        expected,
        vec![V1EdgeExpectation {
            source_object_identity: SCENE_SOURCE_KEY.to_owned(),
            revision_token: SOURCE_REVISION_TOKEN.to_owned(),
            owning_run_id: PARENT_RUN_ID.to_owned(),
        }]
    );
    let persisted = vec![V1PersistedEdge {
        source_object_identity: SCENE_SOURCE_KEY.to_owned(),
        read_set_json: json!([SOURCE_REVISION_TOKEN]).to_string(),
        owning_run_id: Some(PARENT_RUN_ID.to_owned()),
    }];
    validate_v1_parent_authority(&expected, &persisted, &authority).expect("V1 parent parity");

    let mut object_shaped = persisted.clone();
    object_shaped[0].read_set_json = json!({"token": SOURCE_REVISION_TOKEN}).to_string();
    assert!(validate_v1_parent_authority(&expected, &object_shaped, &authority).is_err());

    let mut multi_token = persisted.clone();
    multi_token[0].read_set_json = json!([SOURCE_REVISION_TOKEN, "v1@later"]).to_string();
    assert!(validate_v1_parent_authority(&expected, &multi_token, &authority).is_err());

    let mut wrong_owner = persisted;
    wrong_owner[0].owning_run_id = Some("run-other".to_owned());
    assert!(validate_v1_parent_authority(&expected, &wrong_owner, &authority).is_err());
}

#[test]
fn scope_registry_and_order_oracle_source_kinds_fail_closed() {
    for source_kind in ["scope-registry", "order-oracle"] {
        let mut candidate = material_json();
        candidate["sourceBasis"][0]["sourceKind"] = json!(source_kind);
        let source = candidate["sourceBasis"].clone();
        let evidence = candidate["evidenceSet"].clone();
        let dependencies = candidate["dependencySet"].clone();
        candidate["materialBasisDigest"] = digest(&json!({
            "sourceBasis": source,
            "evidenceSet": evidence,
            "dependencySet": dependencies
        }))
        .into();
        let candidate: MaterialBasis =
            serde_json::from_value(candidate).expect("unknown source kind remains typed");
        assert!(
            resolve_human_material_basis(
                HumanMaterialDerivationKind::ProjectionOnly,
                &candidate,
                &resolution_context(false),
                None,
            )
            .is_err(),
            "unsupported scope/oracle source kind must fail closed: {source_kind}"
        );
    }
}

#[test]
fn human_revision_request_rejects_unexposed_material_sidecar() {
    let request = json!({
        "proposalId": "proposal-1",
        "expectedCurrentRevisionId": PARENT_REVISION_ID,
        "parentRevisionId": PARENT_REVISION_ID,
        "expectedParentEnvelopeDigest": digest(&json!({"parent": PARENT_REVISION_ID})),
        "proposalPayload": {"title": "Arrival"},
        "adapter": {"id": "chronicle.scene-event", "version": "1"},
        "surfaceId": "chronicle-review",
        "materialSidecar": {"dependencySet": []}
    });
    assert!(serde_json::from_value::<CreateHumanDerivedRevisionRequest>(request).is_err());
}
