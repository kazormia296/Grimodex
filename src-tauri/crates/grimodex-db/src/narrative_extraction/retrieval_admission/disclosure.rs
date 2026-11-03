use std::collections::HashSet;

use anyhow::Result;
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_core::{canonical_json_digest, narrative_ir::validate_narrative_scope_v2};
use serde_json::{json, Value};

use super::super::material_membership::RevisionMaterialMembership;
use super::{QueryIdentityState, RetrievalQueryContext, RevisionEligibilityReason as Reason};

/// (stage, contract id, version, component contract digest) reviewed as
/// non-story static input. Event Synthesis v2 and v3 are both accepted so
/// existing v2 extraction results stay eligible (user decision 2026-11-03).
const REVIEWED_STATIC_CONTRACTS: [(&str, &str, &str, &str); 3] = [
    (
        "narrative_observation_extract",
        "chronicle.observation-extraction.prompt",
        "5",
        "sha256:c41c79347c0e96851e06e14de2c05d1519d1ad0e2a4f2e5ae886e94eb28e1c22",
    ),
    (
        "narrative_event_synthesize",
        "chronicle.event-synthesis.prompt",
        "2",
        "sha256:5e63b1a1c4c3a3aba76689732e3876deae5ea230f15d961d74932e16b3b876ff",
    ),
    (
        "narrative_event_synthesize",
        "chronicle.event-synthesis.prompt",
        "3",
        "sha256:c5365b446a2f7bf85081b67174beb5001df51963b3b2a515860938ddefd406f7",
    ),
];

/// One receipt's (stage, digest) is classified only when it is a reviewed entry
/// and the frozen accepted contract bytes reproduce that exact digest.
fn reviewed_static_contract(stage: &str, digest: &str) -> Result<bool> {
    let Some((_, id, version, expected)) =
        REVIEWED_STATIC_CONTRACTS
            .iter()
            .find(|(reviewed_stage, _, _, reviewed_digest)| {
                *reviewed_stage == stage && *reviewed_digest == digest
            })
    else {
        return Ok(false);
    };
    let Some(contract) =
        super::super::material_membership_root::accepted_static_contract(stage, digest)?
    else {
        return Ok(false);
    };
    Ok(contract["contractId"] == *id
        && contract["contractVersion"] == *version
        && canonical_json_digest(
            &json!({"schemaVersion":1,"contextSetVersion":"chronicle.context-set/1",
            "stageId":stage,"componentContract":contract}),
        )? == *expected)
}

fn static_contracts(membership: &RevisionMaterialMembership) -> Result<bool> {
    if membership.verified_receipts.is_empty() {
        return Ok(false);
    }
    for receipt in &membership.verified_receipts {
        if !reviewed_static_contract(&receipt.stage_id, &receipt.component_contract_digest)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn control_classified(
    membership: &RevisionMaterialMembership,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    envelope: &Value,
) -> bool {
    if membership.active_scope_controls.len() > 1 {
        return false;
    }
    let controls = &membership.active_scope_controls;
    for source in &membership.material_basis.source_basis {
        match source.source_kind.as_str() {
            "snapshot-document"
                if source.source_key == format!("snapshot:{}", membership.run_id) => {}
            "scene-body" => {}
            "project-scope-authority" | "scope-dependency-projection-v1"
                if controls.iter().any(|c| c == source) => {}
            _ => return false,
        }
    }
    let dependencies = membership
        .material_basis
        .dependency_set
        .iter()
        .filter(|d| d.role == DependencyRole::ScopeResolution)
        .collect::<Vec<_>>();
    if controls.is_empty() {
        return dependencies.is_empty();
    }
    let control = &controls[0];
    let current_matches = match control.source_kind.as_str() {
        "project-scope-authority" => {
            control.source_key == authority.source.source_key
                && control.revision_token == authority.source.revision_token
        }
        "scope-dependency-projection-v1" => {
            use grimodex_core::narrative_scope_dependency_projection::{
                projection_revision, ScopeDependencyIdentity,
            };
            ScopeDependencyIdentity::from_source_key(&control.source_key)
                .ok()
                .is_some_and(|identity| {
                    identity.project_id == authority.project_id
                        && identity.run_id == membership.run_id
                        && !identity.secret
                        && identity.anchor_scene_ref
                            == envelope["assertion"]["scope"]["scene"]["ref"]
                                .as_str()
                                .unwrap_or("")
                        && projection_revision(&identity, authority).ok().as_deref()
                            == Some(control.revision_token.as_str())
                })
        }
        _ => false,
    };
    if !current_matches || dependencies.len() != 1 {
        return false;
    }
    let d = dependencies[0];
    if d.dependency_id != "dependency:scope-resolution"
        || d.input_ref != control.source_key
        || d.context_ids != ["context:chronicle-scope-resolver"]
        || !matches!(d.selector, DependencySelector::WholeSource)
        || membership
            .materials
            .iter()
            .any(|m| m.source_key == control.source_key)
        || membership
            .material_basis
            .evidence_set
            .iter()
            .any(|e| e.source_key == control.source_key)
        || membership
            .material_basis
            .dependency_set
            .iter()
            .any(|d| d.input_ref == control.source_key && d.role != DependencyRole::ScopeResolution)
    {
        return false;
    }
    let Some(contexts) = envelope["revisionBasis"]["derivationContextSet"].as_array() else {
        return false;
    };
    let mut count = 0;
    for context in contexts {
        if context["inputRef"] != control.source_key {
            continue;
        }
        count += 1;
        if context["contextId"] != "context:chronicle-scope-resolver"
            || context["stageId"] != "chronicle_scene_event_scope_resolver"
            || context["exposure"] != "deterministic-stage"
            || context["selector"] != json!({"kind":"whole-source"})
        {
            return false;
        }
    }
    count > 0
}

fn matches_constraint(constraint: &Value, identity: &QueryIdentityState) -> bool {
    constraint["kind"] == "any"
        || matches!(identity, QueryIdentityState::Resolved(reference)
        if constraint["kind"] == "exact" && constraint["ref"] == *reference)
}

/// Compact verified material kept only in a Native build proof. No constructor
/// or serialization grants authority outside this reader.
#[derive(Debug)]
pub(in crate::narrative_extraction) struct VerifiedDisclosureMaterial {
    scope: Value,
    story_source_keys: Vec<String>,
}

pub(in crate::narrative_extraction) fn prepare(
    membership: &RevisionMaterialMembership,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    envelope: &Value,
    payload: &Value,
) -> Result<std::result::Result<VerifiedDisclosureMaterial, Reason>> {
    if payload["disclosure"]["secret"] != false {
        return Ok(Err(Reason::Secret));
    }
    if !static_contracts(membership)? {
        return Ok(Err(Reason::StaticContractUnclassified));
    }
    if !control_classified(membership, authority, envelope) {
        return Ok(Err(Reason::ScopeControlUnclassified));
    }
    if membership.materials.is_empty() {
        return Ok(Err(Reason::MaterialAuthorityUnavailable));
    }
    let source_keys = membership
        .material_basis
        .source_basis
        .iter()
        .filter(|s| s.source_kind == "scene-body")
        .map(|s| s.source_key.as_str())
        .collect::<HashSet<_>>();
    let material_keys = membership
        .materials
        .iter()
        .map(|m| m.source_key.as_str())
        .collect::<HashSet<_>>();
    if source_keys != material_keys
        || membership.materials.iter().any(|m| {
            !["span", "context"].contains(&m.kind)
                || !authority
                    .mappings
                    .iter()
                    .any(|a| a.source_key == m.source_key)
        })
    {
        return Ok(Err(Reason::MaterialAuthorityUnavailable));
    }
    let scope = &envelope["assertion"]["scope"];
    if scope
        .as_object()
        .is_some_and(|s| s.values().any(|v| v["kind"] == "unresolved"))
    {
        return Ok(Err(Reason::ScopeUnresolved));
    }
    if validate_narrative_scope_v2(scope).is_err()
        || scope["scene"]["kind"] != "exact"
        || scope["readingOrder"]["kind"] != "any"
        || scope["storyTime"]["kind"] != "any"
    {
        return Ok(Err(Reason::ScopeUnsupported));
    }
    if membership.material_basis.evidence_set.is_empty() {
        return Ok(Err(Reason::EvidenceMismatch));
    }
    for evidence in &membership.material_basis.evidence_set {
        let Some(mapping) = authority
            .mappings
            .iter()
            .find(|m| m.source_key == evidence.source_key)
        else {
            return Ok(Err(Reason::EvidenceMismatch));
        };
        if !material_keys.contains(evidence.source_key.as_str())
            || scope["scene"]["ref"] != mapping.scene_ref
            || !membership.materials.iter().any(|material| {
                material.source_key == evidence.source_key
                    && material.document_ref == evidence.document_ref
            })
        {
            return Ok(Err(Reason::EvidenceMismatch));
        }
    }
    let mut story_source_keys = material_keys
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    story_source_keys.sort();
    Ok(Ok(VerifiedDisclosureMaterial {
        scope: scope.clone(),
        story_source_keys,
    }))
}

impl VerifiedDisclosureMaterial {
    pub(in crate::narrative_extraction) fn check_query(
        &self,
        query: &RetrievalQueryContext,
    ) -> Option<Reason> {
        if query.allow_secrets {
            return Some(Reason::Secret);
        }
        for source in &self.story_source_keys {
            let Some(mapping) = query
                .authority
                .mappings
                .iter()
                .find(|m| m.source_key == *source)
            else {
                return Some(Reason::MaterialAuthorityUnavailable);
            };
            if mapping.scene_ref == query.query_scene_ref
                || mapping.reading_rank >= query.query_reading_rank
            {
                return Some(Reason::SourceNotBeforeQuery);
            }
        }
        for (field, identity) in [
            ("audience", &query.audience),
            ("viewpoint", &query.viewpoint),
            ("knowledgeHolder", &query.knowledge_holder),
            ("timeline", &query.timeline),
            ("worldline", &query.worldline),
            ("narrativeLayer", &query.narrative_layer),
        ] {
            if !matches_constraint(&self.scope[field], identity) {
                return Some(Reason::ScopeUnsupported);
            }
        }
        None
    }
}

pub(super) fn check(
    membership: &RevisionMaterialMembership,
    query: &RetrievalQueryContext,
    envelope: &Value,
    payload: &Value,
) -> Result<Option<Reason>> {
    Ok(
        match prepare(membership, &query.authority, envelope, payload)? {
            Ok(material) => material.check_query(query),
            Err(reason) => Some(reason),
        },
    )
}

#[cfg(test)]
mod static_contract_tests {
    use super::*;

    const V2: &str = "sha256:5e63b1a1c4c3a3aba76689732e3876deae5ea230f15d961d74932e16b3b876ff";
    const V3: &str = "sha256:c5365b446a2f7bf85081b67174beb5001df51963b3b2a515860938ddefd406f7";

    #[test]
    fn event_synthesis_v2_and_v3_are_both_reviewed_static_inputs() {
        assert!(reviewed_static_contract("narrative_event_synthesize", V2).expect("v2"));
        assert!(reviewed_static_contract("narrative_event_synthesize", V3).expect("v3"));
        assert!(reviewed_static_contract(
            "narrative_observation_extract",
            "sha256:c41c79347c0e96851e06e14de2c05d1519d1ad0e2a4f2e5ae886e94eb28e1c22",
        )
        .expect("observation"));
    }

    #[test]
    fn unknown_digest_version_or_stage_is_not_reviewed() {
        for (stage, digest) in [
            ("narrative_event_synthesize", "sha256:unknown"),
            // A reviewed digest never classifies under another stage.
            ("narrative_observation_extract", V3),
            ("narrative_structured_repair", V2),
        ] {
            assert!(!reviewed_static_contract(stage, digest).expect("digest"));
        }
        // A frozen v1 contract is absent, so no v1 digest can be reproduced.
        let mut v1 = super::super::super::material_membership_root::accepted_static_contract(
            "narrative_event_synthesize",
            V2,
        )
        .expect("lookup")
        .expect("v2 contract");
        v1["contractVersion"] = json!("1");
        let v1_digest = canonical_json_digest(&json!({"schemaVersion":1,
            "contextSetVersion":"chronicle.context-set/1",
            "stageId":"narrative_event_synthesize","componentContract":v1}))
        .expect("v1 digest");
        assert!(!reviewed_static_contract("narrative_event_synthesize", &v1_digest).expect("v1"));
    }
}
