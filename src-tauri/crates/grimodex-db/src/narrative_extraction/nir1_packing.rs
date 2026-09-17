//! Native A2 to pure NIR-1 packing adapter.
//!
//! The core selector has no database dependency and no reader authority.  This
//! module is the narrow boundary that consumes the typed, one-transaction
//! retrieval eligibility result and turns it into pure selector candidates.
//! Renderer-shaped labels and copied strings never enter this path.

use anyhow::{ensure, Result};
use grimodex_core::narrative_nir1::{
    adapt_candidate_context_item, estimate_nir1_context_tokens, pack_candidate_context, AtomicPart,
    CandidateContextItem, CandidatePackingRequest, ContextItemKind, PackedContext, PackingPurpose,
};
use serde_json::{json, Value};

use super::human_material_basis::MaterialEvidenceEntry;
use super::retrieval_admission::{
    read_revision_retrieval_eligibility, RevisionEligibilityRead, RevisionEligibilitySnapshot,
};
use crate::Database;
use sha2::{Digest, Sha256};

/// Raw context supplied to the request-local Native packing boundary. Reader
/// material is always projected from the current reader below.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1RawContextItem {
    pub id: String,
    pub text: String,
    pub tokens: usize,
}

/// Request identity for the narrow Native A2 read -> adapt -> pack path.
/// Snapshot, candidate binding, and digest inputs deliberately cannot be
/// supplied by a caller.
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

fn require_non_empty(value: &str, field: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty(),
        "NIR-1 A2 reader field {field} is empty"
    );
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn require_digest(value: &str, field: &str) -> Result<()> {
    ensure!(
        value.len() == "sha256:".len() + 64
            && value.starts_with("sha256:")
            && value["sha256:".len()..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
        "NIR-1 A2 reader field {field} is not a canonical sha256 digest"
    );
    Ok(())
}

fn statement_payload(reader: &RevisionEligibilitySnapshot) -> Result<Value> {
    let value: Value = serde_json::from_str(&reader.document().serialized_statement)?;
    ensure!(
        value.is_object(),
        "NIR-1 A2 reader statement is not a JSON object"
    );
    Ok(value)
}

fn statement_field(reader: &RevisionEligibilitySnapshot, field: &str) -> Result<String> {
    let value = statement_payload(reader)?;
    let text = value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("NIR-1 A2 reader statement field {field} is empty"))?;
    Ok(text.to_owned())
}

fn expected_part_text(
    reader: &RevisionEligibilitySnapshot,
    atomic_part: AtomicPart,
) -> Result<String> {
    match atomic_part {
        // The complete serialized statement is the approved ordered text. It
        // keeps the statement's summary/actuality/attribution/frame tuple
        // content-bound instead of trusting a caller label.
        AtomicPart::Statement => Ok(reader.document().serialized_statement.clone()),
        AtomicPart::Negation => statement_field(reader, "actuality"),
        AtomicPart::Attribution => statement_field(reader, "attribution"),
        // Evidence text is the exact ordered persisted Evidence set, including
        // quote digests and source revision bindings.
        AtomicPart::Evidence => Ok(serde_json::to_string(reader.evidence())?),
        // The qualification label is the exact stored Decision payload.
        AtomicPart::Qualification => Ok(reader.current_decision().decision_json().to_owned()),
    }
}

fn item_text_and_group(item: &ContextItemKind) -> (&str, Option<&str>) {
    match item {
        ContextItemKind::Raw { text, .. } => (text, None),
        ContextItemKind::AcceptedIr {
            text, atomic_group, ..
        }
        | ContextItemKind::GraphEvidence {
            text, atomic_group, ..
        }
        | ContextItemKind::AuthorDeclared {
            text, atomic_group, ..
        }
        | ContextItemKind::UnreviewedForReview {
            text, atomic_group, ..
        } => (text, Some(atomic_group)),
    }
}

fn validate_reader_snapshot(reader: &RevisionEligibilitySnapshot) -> Result<()> {
    require_non_empty(reader.revision_id(), "revisionId")?;
    require_non_empty(reader.owning_run_id(), "owningRunId")?;
    require_non_empty(reader.proposal_id(), "proposalId")?;
    require_digest(reader.envelope_digest(), "envelopeDigest")?;
    require_non_empty(reader.current_decision_id(), "decisionId")?;
    require_digest(reader.material_basis_digest(), "materialBasisDigest")?;
    let decision = reader.current_decision();
    require_non_empty(decision.id(), "decision.id")?;
    require_non_empty(decision.revision_id(), "decision.revisionId")?;
    require_non_empty(decision.decision(), "decision.value")?;
    require_non_empty(decision.decision_json(), "decision.json")?;
    require_non_empty(decision.actor_kind(), "decision.actorKind")?;
    require_non_empty(decision.actor_id(), "decision.actorId")?;
    let expected_authority_scope = format!(
        "project/{}/proposal/{}/revision/{}",
        reader.query_context().project_id,
        reader.proposal_id(),
        reader.revision_id()
    );
    ensure!(
        decision.id() == reader.current_decision_id()
            && decision.revision_id() == reader.revision_id()
            && decision.decision() == "approved"
            && decision.actor_kind() == "human"
            && decision.actor_id() == "electron:human-review"
            && decision.authority_scope() == Some(expected_authority_scope.as_str()),
        "NIR-1 A2 reader Decision is not the exact current human approval"
    );
    let decision_json: Value = serde_json::from_str(decision.decision_json())?;
    ensure!(
        decision_json.is_object(),
        "NIR-1 A2 reader Decision payload is not an object"
    );
    ensure!(
        reader.document().revision_id == reader.revision_id(),
        "NIR-1 A2 reader document revision does not match the current revision"
    );
    ensure!(
        reader.document().envelope_digest == reader.envelope_digest(),
        "NIR-1 A2 reader document envelope does not match the current revision"
    );
    require_non_empty(reader.document().serializer_ref, "document.serializerRef")?;
    require_non_empty(
        &reader.document().serialized_statement,
        "document.serializedStatement",
    )?;
    require_non_empty(
        &reader.document().serialized_statement_digest,
        "document.serializedStatementDigest",
    )?;
    require_digest(
        &reader.document().serialized_statement_digest,
        "document.serializedStatementDigest",
    )?;
    ensure!(
        digest(reader.document().serialized_statement.as_bytes())
            == reader.document().serialized_statement_digest,
        "NIR-1 A2 reader serialized statement digest does not match its bytes"
    );

    require_non_empty(
        &reader.canonical_freshness().revision_id,
        "freshness.revisionId",
    )?;
    ensure!(
        reader.canonical_freshness().revision_id == reader.revision_id(),
        "NIR-1 A2 reader Freshness revision does not match the current revision"
    );
    require_non_empty(
        &reader.canonical_freshness().semantic_epoch_id,
        "freshness.semanticEpochId",
    )?;
    require_non_empty(
        &reader.canonical_freshness().dependency_set_digest,
        "freshness.dependencySetDigest",
    )?;
    require_non_empty(
        &reader.canonical_freshness().declaration_set_id,
        "freshness.declarationSetId",
    )?;
    require_non_empty(
        &reader.canonical_freshness().declaration_set_digest,
        "freshness.declarationSetDigest",
    )?;

    require_non_empty(&reader.query_context().project_id, "query.projectId")?;
    require_non_empty(&reader.query_context().query_scene_id, "query.sceneId")?;
    require_non_empty(
        &reader.query_context().query_source.source_key,
        "source.sourceKey",
    )?;
    require_non_empty(
        &reader.query_context().query_source.revision_token,
        "source.sourceRevisionToken",
    )?;
    require_non_empty(
        &reader.query_context().scope_authority_source_key,
        "scopeAuthoritySourceKey",
    )?;
    require_non_empty(
        &reader.query_context().scope_authority_revision_token,
        "scopeAuthorityRevisionToken",
    )?;
    ensure!(
        !reader.dependency_ids().is_empty(),
        "NIR-1 A2 reader dependency set is empty"
    );
    for (index, dependency_id) in reader.dependency_ids().iter().enumerate() {
        require_non_empty(dependency_id, &format!("dependencySet[{index}].id"))?;
    }

    ensure!(
        !reader.evidence().is_empty(),
        "NIR-1 A2 reader Evidence set is empty"
    );
    for (index, evidence) in reader.evidence().iter().enumerate() {
        validate_evidence(evidence, index)?;
    }
    let _ = statement_payload(reader)?;
    Ok(())
}

fn validate_evidence(evidence: &MaterialEvidenceEntry, index: usize) -> Result<()> {
    require_non_empty(
        &evidence.evidence_ref,
        &format!("evidence[{index}].evidenceRef"),
    )?;
    require_non_empty(
        &evidence.document_ref,
        &format!("evidence[{index}].documentRef"),
    )?;
    require_non_empty(&evidence.quote, &format!("evidence[{index}].quote"))?;
    require_non_empty(
        &evidence.quote_digest,
        &format!("evidence[{index}].quoteDigest"),
    )?;
    require_non_empty(
        &evidence.source_key,
        &format!("evidence[{index}].sourceKey"),
    )?;
    require_non_empty(
        &evidence.revision_token,
        &format!("evidence[{index}].sourceRevisionToken"),
    )?;
    require_digest(
        &evidence.quote_digest,
        &format!("evidence[{index}].quoteDigest"),
    )?;
    ensure!(
        digest(evidence.quote.as_bytes()) == evidence.quote_digest,
        "NIR-1 A2 reader Evidence quote digest does not match its bytes"
    );
    Ok(())
}

/// Consume the actual Native A2 current-reader result and emit a pure core
/// item.  `RevisionEligibilitySnapshot` is transient and non-deserializable;
/// its private verification marker is supplied only by the DB reader.
fn adapt_native_a2_candidate_item(
    reader: &RevisionEligibilitySnapshot,
    item: ContextItemKind,
    atomic_part: AtomicPart,
) -> Result<CandidateContextItem> {
    validate_reader_snapshot(reader)?;
    let (text, group) = item_text_and_group(&item);
    let group = group
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("NIR-1 A2 candidate requires an atomic group"))?;
    let expected_text = expected_part_text(reader, atomic_part)?;
    ensure!(
        text == expected_text,
        "NIR-1 A2 candidate text does not exactly match the current reader part"
    );
    let binding = serde_json::to_string(&json!({
        "revisionId": reader.revision_id(),
        "owningRunId": reader.owning_run_id(),
        "proposalId": reader.proposal_id(),
        "envelopeDigest": reader.envelope_digest(),
        "decisionId": reader.current_decision_id(),
        "materialBasisDigest": reader.material_basis_digest(),
        "atomicGroup": group,
        "query": {
            "projectId": reader.query_context().project_id,
            "sceneId": reader.query_context().query_scene_id,
            "effectiveAxis": reader.query_context().effective_axis,
            "scopeAuthorityRevisionToken": reader.query_context().scope_authority_revision_token,
            "sourceKey": reader.query_context().query_source.source_key,
            "sourceRevisionToken": reader.query_context().query_source.revision_token,
        },
        "dependencies": reader.dependency_ids(),
        "freshness": {
            "revisionId": reader.canonical_freshness().revision_id,
            "semanticEpochId": reader.canonical_freshness().semantic_epoch_id,
            "dependencySetDigest": reader.canonical_freshness().dependency_set_digest,
            "declarationSetId": reader.canonical_freshness().declaration_set_id,
            "declarationSetDigest": reader.canonical_freshness().declaration_set_digest,
        },
        "document": {
            "revisionId": reader.document().revision_id,
            "envelopeDigest": reader.document().envelope_digest,
            "serializerRef": reader.document().serializer_ref,
            "serializedStatement": reader.document().serialized_statement,
            "serializedStatementDigest": reader.document().serialized_statement_digest,
        },
        "evidence": reader.evidence(),
        "decision": {
            "id": reader.current_decision().id(),
            "revisionId": reader.current_decision().revision_id(),
            "decision": reader.current_decision().decision(),
            "decisionJson": reader.current_decision().decision_json(),
            "actorKind": reader.current_decision().actor_kind(),
            "actorId": reader.current_decision().actor_id(),
            "authorityScope": reader.current_decision().authority_scope(),
        },
    }))?;
    let digest = Sha256::digest(binding.as_bytes());
    let mut binding_digest = [0_u8; 32];
    binding_digest.copy_from_slice(&digest);
    adapt_candidate_context_item(item, atomic_part, binding_digest).map_err(Into::into)
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

fn reader_part_tokens(text: &str) -> usize {
    estimate_nir1_context_tokens(text)
}

fn adapt_current_reader_group(
    reader: &RevisionEligibilitySnapshot,
    atomic_group: &str,
) -> Result<Vec<CandidateContextItem>> {
    [
        AtomicPart::Statement,
        AtomicPart::Negation,
        AtomicPart::Attribution,
        AtomicPart::Evidence,
        AtomicPart::Qualification,
    ]
    .into_iter()
    .map(|part| {
        let text = expected_part_text(reader, part)?;
        let item = ContextItemKind::GraphEvidence {
            id: format!("nir1:{atomic_group}:{}", reader_part_name(part)),
            tokens: reader_part_tokens(&text),
            text,
            atomic_group: atomic_group.to_owned(),
        };
        adapt_native_a2_candidate_item(reader, item, part)
    })
    .collect()
}

/// Read the exact current A2 result and pack it in the same SQLite read
/// transaction. The public boundary accepts only request identity and Raw
/// material; stale snapshots, candidate items, and caller digests cannot
/// bypass the reader's Decision/Freshness/Scope/Source checks.
pub fn read_and_pack_native_a2_context(
    database: &Database,
    request: NativeNir1PackingRequest,
) -> Result<PackedContext> {
    ensure!(
        !request.project_id.trim().is_empty()
            && !request.revision_id.trim().is_empty()
            && !request.query_scene_id.trim().is_empty()
            && !request.atomic_group.trim().is_empty(),
        "NIR-1 Native packing request identity is incomplete"
    );
    ensure!(
        !request.raw_items.is_empty(),
        "NIR-1 Native packing requires at least one Raw context item"
    );
    database.with_read_transaction(|conn| {
        let reader = match read_revision_retrieval_eligibility(
            conn,
            &request.project_id,
            &request.revision_id,
            &request.query_scene_id,
        )? {
            RevisionEligibilityRead::Eligible(reader) => reader,
            RevisionEligibilityRead::Unavailable { reason } => {
                anyhow::bail!("NIR1_NATIVE_A2_UNAVAILABLE:{reason:?}")
            }
        };
        let mut items = request
            .raw_items
            .iter()
            .map(|raw| {
                grimodex_core::narrative_nir1::adapt_raw_context_item(ContextItemKind::Raw {
                    id: raw.id.clone(),
                    text: raw.text.clone(),
                    tokens: raw.tokens,
                })
                .map_err(anyhow::Error::from)
            })
            .collect::<Result<Vec<_>>>()?;
        items.extend(adapt_current_reader_group(&reader, &request.atomic_group)?);
        pack_candidate_context(CandidatePackingRequest {
            budget_tokens: request.budget_tokens,
            purpose: request.purpose,
            items,
        })
        .map_err(anyhow::Error::from)
    })
}
