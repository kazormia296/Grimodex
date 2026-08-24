//! NIR-0 C2B pure material-basis contract RED.
//!
//! This test names the Native-only typed seam before the implementation is
//! present. It remains independent of SQLite writes, current-pointer
//! promotion, Freshness publication, and Electron transport.

use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_dependency::{
    canonicalize_dependency_selector, compute_dependency_key, compute_dependency_set_digest,
    DependencyRole, DependencySelector, DependencySetDigestEntry, DEPENDENCY_ROLE_CONTRACT_VERSION,
};
use grimodex_db::narrative_extraction::human_material_basis::{
    project_d1_declaration_set, project_v1_expectations, resolve_human_material_basis,
    validate_human_material_parent_bundle, D1ParentAuthority, HumanMaterialDerivationKind,
    HumanMaterialParentBundle, HumanMaterialResolutionContext, MaterialBasis,
    TrustedDependencyEntry, TrustedEvidenceEntry, TrustedHumanMaterialResolution,
    TrustedSourceBasisEntry, V1EdgeExpectation, V1ParentAuthority, V1PersistedEdge,
};
use grimodex_db::narrative_extraction::CreateHumanDerivedRevisionRequest;
use grimodex_db::narrative_extraction::{
    ActiveDependencyDeclarationSet, DependencyDeclarationSetState, SourceBasisRow,
    StoredDependencyDeclaration,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SCENE_SOURCE_KEY: &str = "project:scene:scene-1";
const SOURCE_REVISION_TOKEN: &str = "v0@2026-01-01T00:00:00.000Z";
const PARENT_REVISION_ID: &str = "revision-parent";
const PARENT_RUN_ID: &str = "run-parent";
const D1_PRODUCER_ID: &str = "proposal-revision-source-basis";

fn digest(value: &Value) -> String {
    canonical_json_digest(value).expect("canonical digest")
}

fn sha256_bytes(value: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value)))
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

fn refresh_material_digests(material: &mut Value) {
    let source = material["sourceBasis"].clone();
    let evidence = material["evidenceSet"].clone();
    let dependencies = material["dependencySet"].clone();
    material["dependencySetDigest"] = digest(&dependencies).into();
    material["materialBasisDigest"] = digest(&json!({
        "sourceBasis": source,
        "evidenceSet": evidence,
        "dependencySet": dependencies
    }))
    .into();
}

fn material() -> MaterialBasis {
    serde_json::from_value(material_json()).expect("typed material basis")
}

#[test]
fn material_dependency_selector_rejects_nested_unknown_and_noncanonical_fields() {
    let mut unknown_field = material_json();
    unknown_field["dependencySet"][0]["selector"]["futureField"] = json!(true);
    refresh_material_digests(&mut unknown_field);
    assert!(serde_json::from_value::<MaterialBasis>(unknown_field).is_err());

    let mut noncanonical_field = material_json();
    noncanonical_field["dependencySet"][1]["selector"]["contract_digest"] =
        json!(component_contract_digest());
    refresh_material_digests(&mut noncanonical_field);
    assert!(serde_json::from_value::<MaterialBasis>(noncanonical_field).is_err());
}

#[test]
fn evidence_quote_digest_preserves_exact_utf8_bytes_without_trimming() {
    let quote = "  Arrival.\n世界  ";
    let mut exact_quote = material_json();
    exact_quote["evidenceSet"][0]["quote"] = json!(quote);
    exact_quote["evidenceSet"][0]["quoteDigest"] = json!(sha256_bytes(quote.as_bytes()));
    refresh_material_digests(&mut exact_quote);
    let exact_quote: MaterialBasis =
        serde_json::from_value(exact_quote).expect("exact quote material");

    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent_bundle(&exact_quote),
        &resolution_context(false),
        None,
    )
    .expect("exact quote projection");
    assert_eq!(resolved.material_basis.evidence_set[0].quote, quote);
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
        project_id: "project-a".to_owned(),
        consumer_kind: "proposal-revision".to_owned(),
        consumer_key: PARENT_REVISION_ID.to_owned(),
        owning_run_id: PARENT_RUN_ID.to_owned(),
    }
}

fn source_basis_rows(material: &MaterialBasis) -> Vec<SourceBasisRow> {
    material
        .source_basis
        .iter()
        .enumerate()
        .map(|(ordinal, source)| SourceBasisRow {
            ordinal: ordinal as i64,
            source_kind: source.source_kind.clone(),
            source_key: source.source_key.clone(),
            revision_token: source.revision_token.clone(),
            observed_at: source.revision_observed_at.clone(),
        })
        .collect()
}

fn active_dependency_set(material: &MaterialBasis) -> ActiveDependencyDeclarationSet {
    let projection = project_d1_declaration_set(material, &d1_parent_authority())
        .expect("build typed parent D1 projection");
    let declaration_set_id = "d1-set-parent";
    let entries = projection
        .declarations
        .iter()
        .enumerate()
        .map(|(index, declaration)| {
            let selector_json = canonicalize_dependency_selector(&declaration.selector)
                .expect("canonical selector");
            let selector_digest =
                digest(&serde_json::from_str(&selector_json).expect("selector JSON value"));
            let dependency_key =
                compute_dependency_key(declaration.role.as_str(), &declaration.selector)
                    .expect("dependency key");
            StoredDependencyDeclaration {
                id: format!("d1-entry-{index}"),
                declaration_set_id: declaration_set_id.to_owned(),
                source_object_identity: declaration.source_object_identity.clone(),
                dependency_key,
                dependency_role: declaration.role,
                role_contract_version: DEPENDENCY_ROLE_CONTRACT_VERSION.to_owned(),
                selector_json,
                selector_digest,
            }
        })
        .collect::<Vec<_>>();
    let digest_entries = entries
        .iter()
        .map(|entry| DependencySetDigestEntry {
            source_object_identity: entry.source_object_identity.clone(),
            dependency_key: entry.dependency_key.clone(),
            selector_digest: entry.selector_digest.clone(),
        })
        .collect::<Vec<_>>();
    ActiveDependencyDeclarationSet {
        declaration_set_id: declaration_set_id.to_owned(),
        project_id: "project-a".to_owned(),
        consumer_kind: "proposal-revision".to_owned(),
        consumer_key: PARENT_REVISION_ID.to_owned(),
        producer_id: D1_PRODUCER_ID.to_owned(),
        producer_generation: 1,
        dependency_set_digest: compute_dependency_set_digest(&digest_entries)
            .expect("dependency set digest"),
        state: DependencyDeclarationSetState::Sealed,
        entries,
    }
}

fn persisted_v1_edges(material: &MaterialBasis) -> Vec<V1PersistedEdge> {
    material
        .source_basis
        .iter()
        .map(|source| V1PersistedEdge {
            project_id: "project-a".to_owned(),
            consumer_kind: "proposal-revision".to_owned(),
            consumer_key: PARENT_REVISION_ID.to_owned(),
            source_object_identity: source.source_key.clone(),
            read_set_json: json!([source.revision_token]).to_string(),
            owning_run_id: Some(PARENT_RUN_ID.to_owned()),
            generated_by_transaction_id: None,
        })
        .collect()
}

fn parent_bundle(basis: &MaterialBasis) -> HumanMaterialParentBundle {
    let context = resolution_context(false);
    HumanMaterialParentBundle {
        project_id: context.project_id,
        consumer_kind: "proposal-revision".to_owned(),
        consumer_key: context.parent_revision_id,
        owning_run_id: PARENT_RUN_ID.to_owned(),
        expected_parent_envelope_digest: context.expected_parent_envelope_digest,
        material_basis: basis.clone(),
        source_basis: source_basis_rows(basis),
        active_dependency_declaration_set: active_dependency_set(&material()),
        persisted_v1_edges: persisted_v1_edges(basis),
    }
}

#[test]
fn projection_preserves_all_material_sets_and_digests() {
    let parent = material();
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent_bundle(&parent),
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
fn current_parent_bundle_is_cas_bound_and_rejects_foreign_parent_state() {
    let basis = material();
    let context = resolution_context(false);
    let parent = parent_bundle(&basis);
    validate_human_material_parent_bundle(&parent, &context)
        .expect("current parent bundle is valid");

    let mut wrong_project = parent.clone();
    wrong_project.project_id = "project-other".to_owned();
    assert!(validate_human_material_parent_bundle(&wrong_project, &context).is_err());

    let mut wrong_consumer = parent.clone();
    wrong_consumer.consumer_kind = "narrative-extraction-run".to_owned();
    assert!(validate_human_material_parent_bundle(&wrong_consumer, &context).is_err());

    let mut wrong_run = parent.clone();
    wrong_run.owning_run_id = "run-other".to_owned();
    assert!(validate_human_material_parent_bundle(&wrong_run, &context).is_err());

    let mut wrong_source_row = parent.clone();
    wrong_source_row.source_basis[0].revision_token = "v0@foreign".to_owned();
    assert!(validate_human_material_parent_bundle(&wrong_source_row, &context).is_err());

    let mut wrong_head_state = parent;
    wrong_head_state
        .active_dependency_declaration_set
        .dependency_set_digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_owned();
    assert!(validate_human_material_parent_bundle(&wrong_head_state, &context).is_err());
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
        &parent_bundle(&forged),
        &resolution_context(false),
        None,
    )
    .expect_err("a forged parent material digest must fail closed");
    assert!(error.to_string().to_ascii_lowercase().contains("digest"));
}

#[test]
fn material_evidence_and_source_coverage_invariants_fail_closed() {
    let mut wrong_evidence_token = material_json();
    wrong_evidence_token["evidenceSet"][0]["revisionToken"] = json!("v0@later");
    refresh_material_digests(&mut wrong_evidence_token);
    let wrong_evidence_token: MaterialBasis =
        serde_json::from_value(wrong_evidence_token).expect("typed evidence token drift");
    assert!(resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent_bundle(&wrong_evidence_token),
        &resolution_context(false),
        None,
    )
    .is_err());

    let mut missing_direct_evidence = material_json();
    missing_direct_evidence["dependencySet"][0]["inputRef"] = json!("project:scene:scene-2");
    refresh_material_digests(&mut missing_direct_evidence);
    let missing_direct_evidence: MaterialBasis =
        serde_json::from_value(missing_direct_evidence).expect("typed dependency drift");
    assert!(resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent_bundle(&missing_direct_evidence),
        &resolution_context(false),
        None,
    )
    .is_err());

    let mut orphan_source = material_json();
    orphan_source["sourceBasis"]
        .as_array_mut()
        .expect("source basis array")
        .push(json!({
            "sourceKind": "scene-body",
            "sourceKey": "project:scene:scene-2",
            "revisionToken": "v0@2026-01-02T00:00:00.000Z"
        }));
    refresh_material_digests(&mut orphan_source);
    let orphan_source: MaterialBasis =
        serde_json::from_value(orphan_source).expect("typed orphan source");
    assert!(resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent_bundle(&orphan_source),
        &resolution_context(false),
        None,
    )
    .is_err());
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
        &parent_bundle(&parent),
        &context,
        None,
    )
    .is_err());

    let trusted = trusted_scope_resolution(&context);
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ScopeOverride,
        &parent_bundle(&parent),
        &context,
        Some(&trusted),
    )
    .expect("scope override material resolution");
    assert!(resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent_bundle(&parent),
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
fn d1_projection_requires_direct_and_component_declarations_and_child_authority() {
    let parent = parent_bundle(&material());
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent,
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
    let mut wrong_consumer = authority.clone();
    wrong_consumer.consumer_kind = "narrative-extraction-run".to_owned();
    assert!(project_d1_declaration_set(&resolved.material_basis, &wrong_consumer).is_err());
}

#[test]
fn v1_projection_is_source_basis_only_and_rejects_shape_or_owner_drift() {
    let parent = parent_bundle(&material());
    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent,
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
    validate_human_material_parent_bundle(&parent, &resolution_context(false))
        .expect("current V1 parent parity");

    let mut object_shaped = parent.clone();
    object_shaped.persisted_v1_edges[0].read_set_json =
        json!({"token": SOURCE_REVISION_TOKEN}).to_string();
    assert!(
        validate_human_material_parent_bundle(&object_shaped, &resolution_context(false)).is_err()
    );

    let mut multi_token = parent.clone();
    multi_token.persisted_v1_edges[0].read_set_json =
        json!([SOURCE_REVISION_TOKEN, "v1@later"]).to_string();
    assert!(
        validate_human_material_parent_bundle(&multi_token, &resolution_context(false)).is_err()
    );

    let mut wrong_owner = parent.clone();
    wrong_owner.owning_run_id = "run-other".to_owned();
    for edge in &mut wrong_owner.persisted_v1_edges {
        edge.owning_run_id = Some("run-other".to_owned());
    }
    assert!(
        validate_human_material_parent_bundle(&wrong_owner, &resolution_context(false)).is_err()
    );

    let mut generated_transaction = parent;
    generated_transaction.persisted_v1_edges[0].generated_by_transaction_id =
        Some("tx-current-revision".to_owned());
    assert!(validate_human_material_parent_bundle(
        &generated_transaction,
        &resolution_context(false)
    )
    .is_err());
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
                &parent_bundle(&candidate),
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
