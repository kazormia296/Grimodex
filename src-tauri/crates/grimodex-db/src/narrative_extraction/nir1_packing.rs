//! Native A2 to pure NIR-1 packing adapter.
//!
//! The core selector has no database dependency and no reader authority. This
//! module is the narrow boundary that consumes the exact typed Entity/Relation
//! reader plus its same-snapshot disclosure proof and turns the verified result
//! into pure selector candidates.

use anyhow::{ensure, Result};
use grimodex_core::narrative_nir1::{
    adapt_candidate_context_item, adapt_raw_context_item, estimate_nir1_context_tokens,
    pack_candidate_context, AtomicPart, CandidateContextItem, CandidatePackingRequest,
    ContextItemKind, PackedContext, PackingPurpose, ScopeBinding, MAX_PACKING_INPUT_BYTES,
    MAX_PACKING_ITEMS,
};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ops::Deref;

use super::human_material_basis::MaterialEvidenceEntry;
use super::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDecision,
    Nir1EntityRelationDisclosure, Nir1EntityRelationDisclosureRead, Nir1EntityRelationFreshness,
    Nir1EntityRelationRevision,
};
use crate::Database;

const NATIVE_ATOMIC_PART_COUNT: usize = 5;

/// Raw context supplied to the request-local Native packing boundary. Reader
/// material is always projected from the current typed reader below.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1RawContextItem {
    pub id: String,
    pub text: String,
    pub tokens: usize,
}

/// Request identity for the narrow Native A2 read -> adapt -> pack path.
/// Snapshot, candidate binding, and digest inputs deliberately cannot be
/// supplied by a caller. `atomic_group` remains for the existing request
/// shape, but typed groups derive their identity from the immutable Revision
/// and Entity/Relation IDs below.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1PackingRequest {
    pub project_id: String,
    pub revision_id: String,
    pub query_scene_id: String,
    pub budget_tokens: usize,
    pub purpose: PackingPurpose,
    pub atomic_group: String,
    pub raw_items: Vec<NativeNir1RawContextItem>,
}

/// The exact current Decision state bound to a request-local Native result.
/// This is intentionally not a renderer wire type; the raw decision payload
/// is retained only for change detection and never copied into qualification
/// text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1DecisionBinding {
    id: String,
    revision_id: String,
    decision: String,
    decision_json: String,
    created_at: String,
    created_by: String,
    actor_kind: String,
    actor_id: String,
    authority_scope: String,
    override_field_paths_json: String,
}

impl NativeNir1DecisionBinding {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn decision(&self) -> &str {
        &self.decision
    }

    pub fn decision_json(&self) -> &str {
        &self.decision_json
    }

    pub fn created_at(&self) -> &str {
        &self.created_at
    }

    pub fn created_by(&self) -> &str {
        &self.created_by
    }

    pub fn actor_kind(&self) -> &str {
        &self.actor_kind
    }

    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }

    pub fn authority_scope(&self) -> &str {
        &self.authority_scope
    }

    pub fn override_field_paths_json(&self) -> &str {
        &self.override_field_paths_json
    }
}

/// Query and material Scope tokens captured by the same typed disclosure read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1ScopeBinding {
    query_scene_id: String,
    query_scene_source_token: String,
    query_scene_incarnation_id: String,
    query_scene_scope_token: String,
    scope_authority_revision: String,
    effective_axis: String,
    axis_fallback_reason: Option<String>,
    reveal_state_token: String,
    typed_scope_bindings: Vec<ScopeBinding>,
    material_scene_proofs: Vec<super::nir1_entity_relation::Nir1EntityRelationMaterialSceneProof>,
}

impl NativeNir1ScopeBinding {
    pub fn query_scene_id(&self) -> &str {
        &self.query_scene_id
    }

    pub fn query_scene_source_token(&self) -> &str {
        &self.query_scene_source_token
    }

    pub fn query_scene_incarnation_id(&self) -> &str {
        &self.query_scene_incarnation_id
    }

    pub fn query_scene_scope_token(&self) -> &str {
        &self.query_scene_scope_token
    }

    pub fn scope_authority_revision(&self) -> &str {
        &self.scope_authority_revision
    }

    pub fn effective_axis(&self) -> &str {
        &self.effective_axis
    }

    pub fn axis_fallback_reason(&self) -> Option<&str> {
        self.axis_fallback_reason.as_deref()
    }

    pub fn reveal_state_token(&self) -> &str {
        &self.reveal_state_token
    }

    pub fn typed_scope_bindings(&self) -> &[ScopeBinding] {
        &self.typed_scope_bindings
    }

    pub fn material_scene_proofs(
        &self,
    ) -> &[super::nir1_entity_relation::Nir1EntityRelationMaterialSceneProof] {
        &self.material_scene_proofs
    }
}

/// Immutable authority binding retained by a Native packing result. It is
/// materialized in the same SQLite read transaction as the selector summary,
/// so a caller does not need to perform a second DB read to know which exact
/// Revision, Decision, Scope, and Freshness qualified the selected text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1AuthorityBinding {
    revision: Nir1EntityRelationRevision,
    revision_id: String,
    owning_run_id: String,
    proposal_id: String,
    bundle_digest: String,
    material_basis_digest: String,
    decision_token: String,
    freshness_token: String,
    decision: NativeNir1DecisionBinding,
    freshness: Nir1EntityRelationFreshness,
    scope: NativeNir1ScopeBinding,
}

impl NativeNir1AuthorityBinding {
    pub fn revision(&self) -> &Nir1EntityRelationRevision {
        &self.revision
    }

    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn owning_run_id(&self) -> &str {
        &self.owning_run_id
    }

    pub fn proposal_id(&self) -> &str {
        &self.proposal_id
    }

    pub fn bundle_digest(&self) -> &str {
        &self.bundle_digest
    }

    pub fn material_basis_digest(&self) -> &str {
        &self.material_basis_digest
    }

    pub fn decision_token(&self) -> &str {
        &self.decision_token
    }

    pub fn freshness_token(&self) -> &str {
        &self.freshness_token
    }

    pub fn decision(&self) -> &NativeNir1DecisionBinding {
        &self.decision
    }

    pub fn freshness(&self) -> &Nir1EntityRelationFreshness {
        &self.freshness
    }

    pub fn scope(&self) -> &NativeNir1ScopeBinding {
        &self.scope
    }
}

/// One selected immutable item plus the selector's opaque group binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1SelectedContextItem {
    item: ContextItemKind,
    atomic_part: Option<AtomicPart>,
    candidate_binding: Option<[u8; 32]>,
}

impl NativeNir1SelectedContextItem {
    pub fn item(&self) -> &ContextItemKind {
        &self.item
    }

    pub fn atomic_part(&self) -> Option<AtomicPart> {
        self.atomic_part
    }

    pub fn candidate_binding(&self) -> Option<&[u8; 32]> {
        self.candidate_binding.as_ref()
    }
}

/// Native-only packing result. The pure core selector summary is preserved,
/// while the selected item projections and their exact authority binding stay
/// available without a second DB read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1PackedContext {
    packed: PackedContext,
    selected_items: Vec<NativeNir1SelectedContextItem>,
    binding: NativeNir1AuthorityBinding,
}

impl NativeNir1PackedContext {
    pub fn packed(&self) -> &PackedContext {
        &self.packed
    }

    pub fn selected_items(&self) -> &[NativeNir1SelectedContextItem] {
        &self.selected_items
    }

    pub fn binding(&self) -> &NativeNir1AuthorityBinding {
        &self.binding
    }
}

impl Deref for NativeNir1PackedContext {
    type Target = PackedContext;

    fn deref(&self) -> &Self::Target {
        &self.packed
    }
}

fn require_non_empty(value: &str, field: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty(),
        "NIR-1 Native field {field} is empty"
    );
    Ok(())
}

fn require_digest(value: &str, field: &str) -> Result<()> {
    ensure!(
        value.len() == "sha256:".len() + 64
            && value.starts_with("sha256:")
            && value["sha256:".len()..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
        "NIR-1 Native field {field} is not a canonical sha256 digest"
    );
    Ok(())
}

fn canonical_value(value: &Value) -> Result<String> {
    canonical_json_string(value).map_err(Into::into)
}

#[derive(Default)]
struct NativePackingInputBudget {
    used_bytes: usize,
}

impl NativePackingInputBudget {
    fn reserve_lengths(
        &mut self,
        id_len: usize,
        text_len: usize,
        atomic_group_len: usize,
    ) -> Result<()> {
        // Keep this formula identical to the core selector's final envelope:
        // id.len() + text.len() + atomic_group.len().
        let item_bytes = id_len
            .checked_add(text_len)
            .and_then(|bytes| bytes.checked_add(atomic_group_len))
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native packing input byte count overflow"))?;
        let next = self
            .used_bytes
            .checked_add(item_bytes)
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native packing input byte count overflow"))?;
        ensure!(
            next <= MAX_PACKING_INPUT_BYTES,
            "NIR-1 Native packing input exceeds MAX_PACKING_INPUT_BYTES {MAX_PACKING_INPUT_BYTES}"
        );
        self.used_bytes = next;
        Ok(())
    }

    fn reserve_raw(&mut self, raw: &NativeNir1RawContextItem) -> Result<()> {
        self.reserve_lengths(raw.id.len(), raw.text.len(), 0)
    }

    fn reserve_group(&mut self, group_id: &str, parts: &[(AtomicPart, String)]) -> Result<()> {
        for (part, text) in parts {
            let part_name = reader_part_name(*part);
            let id_len = group_id
                .len()
                .checked_add(1)
                .and_then(|length| length.checked_add(part_name.len()))
                .ok_or_else(|| anyhow::anyhow!("NIR-1 Native packing input byte count overflow"))?;
            self.reserve_lengths(id_len, text.len(), group_id.len())?;
        }
        Ok(())
    }
}

fn canonical_digest_bytes(value: &Value, field: &str) -> Result<[u8; 32]> {
    let digest = canonical_json_digest(value)?;
    let bytes = hex::decode(
        digest
            .strip_prefix("sha256:")
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native {field} digest has no prefix"))?,
    )?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("NIR-1 Native {field} digest has invalid length"))
}

fn item_id(item: &ContextItemKind) -> &str {
    match item {
        ContextItemKind::Raw { id, .. }
        | ContextItemKind::AcceptedIr { id, .. }
        | ContextItemKind::GraphEvidence { id, .. }
        | ContextItemKind::AuthorDeclared { id, .. }
        | ContextItemKind::UnreviewedForReview { id, .. } => id,
    }
}

fn decision_binding(
    decision: &Nir1EntityRelationDecision,
    project_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> Result<NativeNir1DecisionBinding> {
    require_non_empty(decision.id(), "decision.id")?;
    require_non_empty(decision.revision_id(), "decision.revisionId")?;
    require_non_empty(decision.decision(), "decision.value")?;
    require_non_empty(decision.decision_json(), "decision.json")?;
    require_non_empty(decision.created_at(), "decision.createdAt")?;
    require_non_empty(decision.created_by(), "decision.createdBy")?;
    require_non_empty(decision.actor_kind(), "decision.actorKind")?;
    require_non_empty(decision.actor_id(), "decision.actorId")?;
    let authority_scope = decision
        .authority_scope()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("NIR-1 Native Decision authority scope is empty"))?;
    let expected_scope =
        format!("project/{project_id}/proposal/{proposal_id}/revision/{revision_id}");
    ensure!(
        decision.revision_id() == revision_id
            && decision.decision() == "approved"
            && decision.actor_kind() == "human"
            && decision.actor_id() == "electron:human-review"
            && authority_scope == expected_scope,
        "NIR-1 Native Decision is not the exact current human approval"
    );
    let decision_json: Value = serde_json::from_str(decision.decision_json())?;
    ensure!(
        decision_json.is_object(),
        "NIR-1 Native Decision payload is not an object"
    );
    let override_field_paths: Value = serde_json::from_str(decision.override_field_paths_json())?;
    ensure!(
        override_field_paths.is_array(),
        "NIR-1 Native Decision override paths are not an array"
    );
    Ok(NativeNir1DecisionBinding {
        id: decision.id().to_owned(),
        revision_id: decision.revision_id().to_owned(),
        decision: decision.decision().to_owned(),
        decision_json: decision.decision_json().to_owned(),
        created_at: decision.created_at().to_owned(),
        created_by: decision.created_by().to_owned(),
        actor_kind: decision.actor_kind().to_owned(),
        actor_id: decision.actor_id().to_owned(),
        authority_scope: authority_scope.to_owned(),
        override_field_paths_json: decision.override_field_paths_json().to_owned(),
    })
}

fn authority_binding(
    disclosure: &Nir1EntityRelationDisclosure,
) -> Result<NativeNir1AuthorityBinding> {
    let revision = &disclosure.revision;
    let decision = revision
        .decision
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("NIR-1 Native typed reader returned no Decision"))?;
    ensure!(
        revision.project_id == revision.bundle.project_id
            && revision.revision_id == revision.bundle.revision_id
            && revision.revision_id == disclosure.revision.revision_id,
        "NIR-1 Native typed Revision identity is inconsistent"
    );
    require_non_empty(&revision.project_id, "revision.projectId")?;
    require_non_empty(&revision.run_id, "revision.runId")?;
    require_non_empty(&revision.proposal_id, "revision.proposalId")?;
    require_non_empty(&revision.revision_id, "revision.revisionId")?;
    require_digest(&revision.bundle_digest, "revision.bundleDigest")?;
    require_digest(
        &revision.material_basis.material_basis_digest,
        "material.materialBasisDigest",
    )?;
    require_non_empty(&disclosure.decision_token, "decisionToken")?;
    require_digest(&disclosure.freshness_token, "freshnessToken")?;
    require_non_empty(
        &revision.canonical_freshness.semantic_epoch_id,
        "freshness.semanticEpochId",
    )?;
    require_non_empty(
        &revision.canonical_freshness.dependency_set_digest,
        "freshness.dependencySetDigest",
    )?;
    require_non_empty(
        &revision.canonical_freshness.declaration_set_id,
        "freshness.declarationSetId",
    )?;
    require_non_empty(
        &revision.canonical_freshness.declaration_set_digest,
        "freshness.declarationSetDigest",
    )?;
    let decision = decision_binding(
        decision,
        &revision.project_id,
        &revision.proposal_id,
        &revision.revision_id,
    )?;
    let typed_scope_bindings = revision
        .bundle
        .entities
        .iter()
        .map(|entity| entity.scope.clone())
        .collect::<Vec<_>>();
    let scope = NativeNir1ScopeBinding {
        query_scene_id: disclosure.query_scene_id.clone(),
        query_scene_source_token: disclosure.query_scene_source_token.clone(),
        query_scene_incarnation_id: disclosure.query_scene_incarnation_id.clone(),
        query_scene_scope_token: disclosure.query_scene_scope_token.clone(),
        scope_authority_revision: disclosure.scope_authority_revision.clone(),
        effective_axis: disclosure.effective_axis.clone(),
        axis_fallback_reason: disclosure.axis_fallback_reason.clone(),
        reveal_state_token: disclosure.reveal_state_token.clone(),
        typed_scope_bindings,
        material_scene_proofs: disclosure
            .material_scene_proofs
            .iter()
            .map(
                |proof| super::nir1_entity_relation::Nir1EntityRelationMaterialSceneProof {
                    scene_id: proof.scene_id.clone(),
                    scene_incarnation_id: proof.scene_incarnation_id.clone(),
                    scene_scope_token: proof.scene_scope_token.clone(),
                },
            )
            .collect(),
    };
    for (field, value) in [
        ("scope.querySceneId", scope.query_scene_id.as_str()),
        (
            "scope.querySceneSourceToken",
            scope.query_scene_source_token.as_str(),
        ),
        (
            "scope.querySceneIncarnationId",
            scope.query_scene_incarnation_id.as_str(),
        ),
        (
            "scope.querySceneScopeToken",
            scope.query_scene_scope_token.as_str(),
        ),
        (
            "scope.scopeAuthorityRevision",
            scope.scope_authority_revision.as_str(),
        ),
        ("scope.effectiveAxis", scope.effective_axis.as_str()),
        ("scope.revealStateToken", scope.reveal_state_token.as_str()),
    ] {
        require_non_empty(value, field)?;
    }
    Ok(NativeNir1AuthorityBinding {
        revision: (**revision).clone(),
        revision_id: revision.revision_id.clone(),
        owning_run_id: revision.run_id.clone(),
        proposal_id: revision.proposal_id.clone(),
        bundle_digest: revision.bundle_digest.clone(),
        material_basis_digest: revision.material_basis.material_basis_digest.clone(),
        decision_token: disclosure.decision_token.clone(),
        freshness_token: disclosure.freshness_token.clone(),
        decision,
        freshness: revision.canonical_freshness.clone(),
        scope,
    })
}

fn authority_binding_value(binding: &NativeNir1AuthorityBinding) -> Result<Value> {
    Ok(json!({
        "revision": serde_json::to_value(&binding.revision)?,
        "revisionId": binding.revision_id,
        "owningRunId": binding.owning_run_id,
        "proposalId": binding.proposal_id,
        "bundleDigest": binding.bundle_digest,
        "materialBasisDigest": binding.material_basis_digest,
        "decisionToken": binding.decision_token,
        "freshnessToken": binding.freshness_token,
        "decision": {
            "id": binding.decision.id,
            "revisionId": binding.decision.revision_id,
            "decision": binding.decision.decision,
            "decisionJson": binding.decision.decision_json,
            "createdAt": binding.decision.created_at,
            "createdBy": binding.decision.created_by,
            "actorKind": binding.decision.actor_kind,
            "actorId": binding.decision.actor_id,
            "authorityScope": binding.decision.authority_scope,
            "overrideFieldPathsJson": binding.decision.override_field_paths_json,
        },
        "freshness": serde_json::to_value(&binding.freshness)?,
        "scope": {
            "querySceneId": binding.scope.query_scene_id,
            "querySceneSourceToken": binding.scope.query_scene_source_token,
            "querySceneIncarnationId": binding.scope.query_scene_incarnation_id,
            "querySceneScopeToken": binding.scope.query_scene_scope_token,
            "scopeAuthorityRevision": binding.scope.scope_authority_revision,
            "effectiveAxis": binding.scope.effective_axis,
            "axisFallbackReason": binding.scope.axis_fallback_reason,
            "revealStateToken": binding.scope.reveal_state_token,
            "typedScopeBindings": serde_json::to_value(&binding.scope.typed_scope_bindings)?,
            "materialSceneProofs": binding
                .scope
                .material_scene_proofs
                .iter()
                .map(|proof| {
                    json!({
                        "sceneId": proof.scene_id,
                        "sceneIncarnationId": proof.scene_incarnation_id,
                        "sceneScopeToken": proof.scene_scope_token,
                    })
                })
                .collect::<Vec<_>>(),
        },
    }))
}

fn authority_binding_digest(binding: &NativeNir1AuthorityBinding) -> Result<[u8; 32]> {
    canonical_digest_bytes(&authority_binding_value(binding)?, "authority binding")
}

fn candidate_binding_digest(
    authority_digest: [u8; 32],
    group_id: &str,
    parts: &[(AtomicPart, String)],
) -> Result<[u8; 32]> {
    let value = json!({
        "kind": "nir1.native.accepted-ir@1",
        "groupId": group_id,
        "authorityDigest": format!("sha256:{}", hex::encode(authority_digest)),
        // Keep the exact ordered five-part material bytes in the binding.
        // The selector's opaque token then changes if any selected text or
        // its atomic position changes, while every item in one atomic group
        // continues to share the same binding.
        "parts": parts
            .iter()
            .map(|(part, text)| {
                json!({
                    "atomicPart": reader_part_name(*part),
                    "text": text,
                })
            })
            .collect::<Vec<_>>(),
    });
    canonical_digest_bytes(&value, "candidate")
}

fn preflight_projected_item_count(
    raw_item_count: usize,
    entity_count: usize,
    relation_count: usize,
) -> Result<()> {
    let group_count = entity_count
        .checked_add(relation_count)
        .ok_or_else(|| anyhow::anyhow!("NIR-1 Native projected item count overflow"))?;
    let candidate_count = group_count
        .checked_mul(NATIVE_ATOMIC_PART_COUNT)
        .ok_or_else(|| anyhow::anyhow!("NIR-1 Native projected item count overflow"))?;
    let projected_count = raw_item_count
        .checked_add(candidate_count)
        .ok_or_else(|| anyhow::anyhow!("NIR-1 Native projected item count overflow"))?;
    ensure!(
        projected_count <= MAX_PACKING_ITEMS,
        "NIR-1 Native projected item count {projected_count} exceeds MAX_PACKING_ITEMS {MAX_PACKING_ITEMS}"
    );
    Ok(())
}

fn material_evidence_map(
    evidence_set: &[MaterialEvidenceEntry],
) -> Result<HashMap<String, MaterialEvidenceEntry>> {
    let mut map = HashMap::with_capacity(evidence_set.len());
    for evidence in evidence_set {
        require_non_empty(&evidence.evidence_ref, "material.evidenceRef")?;
        require_non_empty(&evidence.document_ref, "material.documentRef")?;
        require_non_empty(&evidence.quote, "material.quote")?;
        require_digest(&evidence.quote_digest, "material.quoteDigest")?;
        ensure!(
            format!(
                "sha256:{}",
                hex::encode(Sha256::digest(evidence.quote.as_bytes()))
            ) == evidence.quote_digest,
            "NIR-1 Native material Evidence quote digest does not match"
        );
        ensure!(
            map.insert(evidence.evidence_ref.clone(), evidence.clone())
                .is_none(),
            "NIR-1 Native material Evidence IDs are not unique"
        );
    }
    Ok(map)
}

fn material_evidence_for_ids(
    ids: &[String],
    by_id: &HashMap<String, MaterialEvidenceEntry>,
) -> Result<Vec<MaterialEvidenceEntry>> {
    ensure!(!ids.is_empty(), "NIR-1 Native candidate Evidence is empty");
    // The source record keeps its original Evidence IDs. Only this resolved
    // material projection deduplicates references, in stable first-seen order.
    let mut unique_ids = HashSet::with_capacity(ids.len());
    ids.iter()
        .filter(|id| unique_ids.insert(id.as_str()))
        .map(|id| {
            by_id
                .get(id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("NIR-1 Native Evidence ID is not in Material Basis"))
        })
        .collect()
}

fn closed_marker(part: AtomicPart) -> Result<String> {
    canonical_value(&json!({
        "status": "not-represented-by-this-family",
        "family": "nir1.entity-relation@1",
        "atomicPart": reader_part_name(part),
    }))
}

fn qualification_text(
    binding: &NativeNir1AuthorityBinding,
    entity_or_relation_id: &str,
) -> Result<String> {
    // This is the closed Native projection. The complete decision_json stays
    // in `binding` for change detection, but arbitrary notes and renderer
    // fields never become model-visible qualification text.
    canonical_value(&json!({
        "approval": "human-approved",
        "decision": binding.decision.decision,
        "decisionId": binding.decision.id,
        "actorKind": binding.decision.actor_kind,
        "actorId": binding.decision.actor_id,
        "authorityScope": binding.decision.authority_scope,
        "proposalId": binding.proposal_id,
        "revisionId": binding.revision_id,
        "recordId": entity_or_relation_id,
    }))
}

fn reader_part_name(part: AtomicPart) -> &'static str {
    match part {
        AtomicPart::Statement => "statement",
        AtomicPart::Negation => "negation",
        AtomicPart::Attribution => "attribution",
        AtomicPart::Evidence => "evidence",
        AtomicPart::Qualification => "qualification",
    }
}

fn accepted_ir_group(
    binding: &NativeNir1AuthorityBinding,
    authority_digest: [u8; 32],
    input_budget: &mut NativePackingInputBudget,
    group_id: &str,
    record_id: &str,
    projection: Value,
    evidence: Value,
) -> Result<Vec<CandidateContextItem>> {
    let parts = [
        (AtomicPart::Statement, canonical_value(&projection)?),
        (AtomicPart::Negation, closed_marker(AtomicPart::Negation)?),
        (
            AtomicPart::Attribution,
            closed_marker(AtomicPart::Attribution)?,
        ),
        (AtomicPart::Evidence, canonical_value(&evidence)?),
        (
            AtomicPart::Qualification,
            qualification_text(binding, record_id)?,
        ),
    ];
    input_budget.reserve_group(group_id, &parts)?;
    let candidate_binding = candidate_binding_digest(authority_digest, group_id, &parts)?;
    parts
        .into_iter()
        .map(|(part, text)| {
            let item = ContextItemKind::AcceptedIr {
                id: format!("{group_id}:{}", reader_part_name(part)),
                tokens: estimate_nir1_context_tokens(&text),
                text,
                atomic_group: group_id.to_owned(),
            };
            adapt_candidate_context_item(item, part, candidate_binding).map_err(Into::into)
        })
        .collect()
}

fn adapt_typed_revision_candidates(
    disclosure: &Nir1EntityRelationDisclosure,
    authority_digest: [u8; 32],
    binding: &NativeNir1AuthorityBinding,
    input_budget: &mut NativePackingInputBudget,
    candidates: &mut Vec<CandidateContextItem>,
) -> Result<()> {
    let revision = &disclosure.revision;
    let evidence_by_id = material_evidence_map(&revision.material_basis.evidence_set)?;
    let entities_by_id = revision
        .bundle
        .entities
        .iter()
        .map(|entity| (entity.entity_id.as_str(), entity))
        .collect::<HashMap<_, _>>();
    ensure!(
        entities_by_id.len() == revision.bundle.entities.len(),
        "NIR-1 Native typed Entity IDs are not unique"
    );
    for entity in &revision.bundle.entities {
        let evidence = material_evidence_for_ids(
            &entity
                .evidence
                .iter()
                .map(|item| item.evidence_id.clone())
                .collect::<Vec<_>>(),
            &evidence_by_id,
        )?;
        let group_id = format!(
            "nir1:accepted-ir:{}:entity:{}",
            revision.revision_id, entity.entity_id
        );
        candidates.extend(accepted_ir_group(
            binding,
            authority_digest,
            input_budget,
            &group_id,
            &entity.entity_id,
            json!({
                "family": "nir1.entity-relation@1",
                "kind": "entity",
                "entity": entity,
                "materialEvidence": evidence.clone(),
            }),
            json!({
                "family": "nir1.entity-relation@1",
                "kind": "entity-evidence",
                "entityId": entity.entity_id,
                "materialEvidence": evidence,
            }),
        )?);
    }
    for relation in &revision.bundle.relations {
        let from = entities_by_id
            .get(relation.from_entity_id.as_str())
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native relation source Entity is missing"))?;
        let to = entities_by_id
            .get(relation.to_entity_id.as_str())
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native relation target Entity is missing"))?;
        // Resolve relation evidence against the global Material Basis map,
        // rather than only looking at endpoint-local evidence lists.
        let relation_evidence = material_evidence_for_ids(&relation.evidence_ids, &evidence_by_id)?;
        let from_evidence = material_evidence_for_ids(
            &from
                .evidence
                .iter()
                .map(|item| item.evidence_id.clone())
                .collect::<Vec<_>>(),
            &evidence_by_id,
        )?;
        let to_evidence = material_evidence_for_ids(
            &to.evidence
                .iter()
                .map(|item| item.evidence_id.clone())
                .collect::<Vec<_>>(),
            &evidence_by_id,
        )?;
        let group_id = format!(
            "nir1:accepted-ir:{}:relation:{}",
            revision.revision_id, relation.edge_id
        );
        candidates.extend(accepted_ir_group(
            binding,
            authority_digest,
            input_budget,
            &group_id,
            &relation.edge_id,
            json!({
                "family": "nir1.entity-relation@1",
                "kind": "relation",
                "relation": relation,
                "from": {
                    "entity": from,
                    "materialEvidence": from_evidence,
                },
                "to": {
                    "entity": to,
                    "materialEvidence": to_evidence,
                },
                "materialEvidence": relation_evidence.clone(),
            }),
            json!({
                "family": "nir1.entity-relation@1",
                "kind": "relation-evidence",
                "relationId": relation.edge_id,
                "materialEvidence": relation_evidence,
            }),
        )?);
    }
    Ok(())
}

fn selected_items(
    items: &[CandidateContextItem],
    packed: &PackedContext,
) -> Result<Vec<NativeNir1SelectedContextItem>> {
    let selected_ids = packed
        .selected_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let selected = items
        .iter()
        .filter(|candidate| selected_ids.contains(item_id(candidate.item())))
        .map(|candidate| NativeNir1SelectedContextItem {
            item: candidate.item().clone(),
            atomic_part: candidate.atomic_part(),
            candidate_binding: candidate.candidate_binding().copied(),
        })
        .collect::<Vec<_>>();
    ensure!(
        selected.len() == packed.selected_ids.len(),
        "NIR-1 Native selector result lost a selected item"
    );
    ensure!(
        selected
            .iter()
            .map(|item| item_id(&item.item))
            .eq(packed.selected_ids.iter().map(String::as_str)),
        "NIR-1 Native selector result changed selected item order"
    );
    Ok(selected)
}

/// Read the exact current typed A2 result, evaluate query Scope/reveal, and
/// pack it in the same SQLite read transaction. The public boundary accepts
/// only request identity and Raw material; stale snapshots, candidate items,
/// caller labels, and caller digests cannot bypass the Native reader.
pub fn read_and_pack_native_a2_context(
    database: &Database,
    request: NativeNir1PackingRequest,
) -> Result<NativeNir1PackedContext> {
    ensure!(
        !request.project_id.trim().is_empty()
            && !request.revision_id.trim().is_empty()
            && !request.query_scene_id.trim().is_empty(),
        "NIR-1 Native packing request identity is incomplete"
    );
    ensure!(
        !request.raw_items.is_empty(),
        "NIR-1 Native packing requires at least one Raw context item"
    );
    let mut input_budget = NativePackingInputBudget::default();
    for raw in &request.raw_items {
        input_budget.reserve_raw(raw)?;
    }
    database.with_read_transaction(|conn| {
        // The disclosure evaluator starts with the exact typed A2 reader and
        // only then adds query-specific Scope/reveal admission in this same
        // snapshot. Chronicle retrieval eligibility is intentionally not used.
        let disclosure = match evaluate_nir1_entity_relation_disclosure(
            conn,
            &request.project_id,
            &request.revision_id,
            &request.query_scene_id,
        )? {
            Nir1EntityRelationDisclosureRead::Eligible(disclosure) => disclosure,
            Nir1EntityRelationDisclosureRead::Unavailable { reason } => {
                anyhow::bail!("NIR1_NATIVE_A2_UNAVAILABLE:{reason}")
            }
        };
        preflight_projected_item_count(
            request.raw_items.len(),
            disclosure.revision.bundle.entities.len(),
            disclosure.revision.bundle.relations.len(),
        )?;
        let binding = authority_binding(&disclosure)?;
        let authority_digest = authority_binding_digest(&binding)?;
        let mut items = request
            .raw_items
            .iter()
            .map(|raw| {
                adapt_raw_context_item(ContextItemKind::Raw {
                    id: raw.id.clone(),
                    text: raw.text.clone(),
                    tokens: raw.tokens,
                })
                .map_err(anyhow::Error::from)
            })
            .collect::<Result<Vec<_>>>()?;
        adapt_typed_revision_candidates(
            &disclosure,
            authority_digest,
            &binding,
            &mut input_budget,
            &mut items,
        )?;
        let packed = pack_candidate_context(CandidatePackingRequest {
            budget_tokens: request.budget_tokens,
            purpose: request.purpose,
            items: items.clone(),
        })
        .map_err(anyhow::Error::from)?;
        let selected_items = selected_items(&items, &packed)?;
        Ok(NativeNir1PackedContext {
            packed,
            selected_items,
            binding,
        })
    })
}
