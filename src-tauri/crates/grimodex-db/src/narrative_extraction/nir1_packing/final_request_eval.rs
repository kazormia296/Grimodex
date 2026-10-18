//! Evaluation-only observation of the packing candidate set (DP-H, K6/2
//! `nir1-final-request-packing-eval`, observation call (c-1)).
//!
//! This module exists only under the `nir1-final-request-eval` cargo feature.
//! The feature is never in `default` and is never enabled by the normal N-API
//! build or release packaging; the product path contains one call statement
//! into this module (the (c-1) site in
//! `read_and_pack_native_a2_context_in_tx_with_raw_charge`). The call receives
//! already computed values by shared reference, returns nothing, and cannot
//! fail the product path. It changes no selection, rendering, revalidation,
//! dispatch or persistence.
//!
//! The record is kept in a thread-local slot. D-final reads, packs and renders
//! on one thread, so the (c-2) call of the same request takes the record that
//! (c-1) just wrote. Other paths that reach (c-1) (the single-Revision reader)
//! are marked and never become a capture.

#[cfg(not(feature = "native-current-human-capture"))]
compile_error!(
    "nir1-final-request-eval needs the native-current-human-capture feature \
     (grimodex-node always enables it); the evaluation feature does not enable it"
);

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{ensure, Result};
use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_nir1::{
    AtomicPart, CandidateContextItem, ContextItemKind, PackedContext, PackingPurpose,
};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    add_revision_qualifications, authority_binding_digest_and_size,
    build_native_nir1_prepared_inputs, item_id, HistoryContextStage, NativeNir1AuthorityBinding,
    NativeNir1PooledPackedContext, NativeNir1PooledPackingRequest, NativeNir1PreparedInputs,
    NativeNir1RawSourceBinding, NativeNir1SelectedContextItem, RawBudgetCharge,
};
use crate::nir1_generation::{
    AcceptedChatInputCapture, InputReference, InputRole, InputTarget, InputUse, MessageVersion,
    QualificationReference,
};

/// Domain of the candidate set digest and the snapshot identity.
const CANDIDATE_SET_DIGEST_DOMAIN: &str = "nir1-final-request-eval-candidate-set@1";
const SNAPSHOT_IDENTITY_DOMAIN: &str = "nir1-final-request-eval-snapshot@1";

static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static LATEST: RefCell<Option<CandidateSetRecord>> = const { RefCell::new(None) };
}

/// One candidate item as D-final built it, in the original order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateItemRow {
    pub item_id: String,
    /// `raw`, `accepted-ir`, `graph-evidence`, `author-declared` or
    /// `unreviewed-for-review`.
    pub kind: &'static str,
    pub text: String,
    pub tokens: usize,
    /// The owner Revision (the Raw item is its own owner: its source key).
    pub owner_id: String,
    /// `sha256:` digest of the owner's authority binding (the Raw: its text).
    pub binding_digest: String,
    pub atomic_group: Option<String>,
    /// `statement`, `negation`, `attribution`, `evidence` or `qualification`.
    pub atomic_part: Option<&'static str>,
}

/// The input reference and qualification refs of one candidate Revision,
/// derived by the product function `add_revision_qualifications`. The D1 rows
/// are added by the render and are not part of this derivation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateRefRow {
    pub owner_id: String,
    pub input: InputReference,
    pub qualifications: Vec<QualificationReference>,
}

/// What (c-1) observed for one call of the packing read.
#[derive(Clone)]
pub struct CandidateSetRecord {
    /// Process-wide, strictly increasing. Identifies the request.
    pub sequence: u64,
    /// True when the call came through the D-final pooled Source path (the Raw
    /// was charged by the Source reader). The single-Revision reader charges
    /// the Raw itself and is not a D-final path.
    pub pooled_source_path: bool,
    pub project_id: String,
    pub query_scene_id: String,
    /// The Revision IDs the packing read was given, in order.
    pub revision_ids: Vec<String>,
    pub budget_tokens: usize,
    pub purpose: PackingPurpose,
    pub items: Vec<CandidateItemRow>,
    pub candidate_refs: Vec<CandidateRefRow>,
    pub candidate_set_digest: String,
    pub snapshot_identity: String,
    /// Set when a row could not be derived. The run is then a harness defect.
    pub derivation_error: Option<String>,
    // Typed material for the baseline arm (not serialized).
    candidate_items: Vec<CandidateContextItem>,
    item_owners: HashMap<String, String>,
    bindings: Vec<NativeNir1AuthorityBinding>,
}

impl CandidateSetRecord {
    /// The authority bindings of every consulted Revision.
    pub fn binding_revision_ids(&self) -> Vec<&str> {
        self.bindings
            .iter()
            .map(NativeNir1AuthorityBinding::revision_id)
            .collect()
    }
}

fn kind_name(item: &ContextItemKind) -> &'static str {
    match item {
        ContextItemKind::Raw { .. } => "raw",
        ContextItemKind::AcceptedIr { .. } => "accepted-ir",
        ContextItemKind::GraphEvidence { .. } => "graph-evidence",
        ContextItemKind::AuthorDeclared { .. } => "author-declared",
        ContextItemKind::UnreviewedForReview { .. } => "unreviewed-for-review",
    }
}

fn part_name(part: AtomicPart) -> &'static str {
    match part {
        AtomicPart::Statement => "statement",
        AtomicPart::Negation => "negation",
        AtomicPart::Attribution => "attribution",
        AtomicPart::Evidence => "evidence",
        AtomicPart::Qualification => "qualification",
    }
}

fn item_parts(item: &ContextItemKind) -> (&str, &str, usize, Option<&str>) {
    match item {
        ContextItemKind::Raw { id, text, tokens } => (id, text, *tokens, None),
        ContextItemKind::AcceptedIr {
            id,
            text,
            tokens,
            atomic_group,
        }
        | ContextItemKind::GraphEvidence {
            id,
            text,
            tokens,
            atomic_group,
        }
        | ContextItemKind::AuthorDeclared {
            id,
            text,
            tokens,
            atomic_group,
        }
        | ContextItemKind::UnreviewedForReview {
            id,
            text,
            tokens,
            atomic_group,
        } => (id, text, *tokens, Some(atomic_group)),
    }
}

/// Lowercase sha256 hex of `bytes` (the scorer's `sha256Hex`). The node crate
/// has no hash dependency of its own.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn sha256_prefixed(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn row_json(row: &CandidateItemRow) -> serde_json::Value {
    json!({
        "itemId": row.item_id,
        "kind": row.kind,
        "text": row.text,
        "tokens": row.tokens,
        "ownerId": row.owner_id,
        "bindingDigest": row.binding_digest,
        "atomicGroup": row.atomic_group,
        "atomicPart": row.atomic_part,
    })
}

#[allow(clippy::type_complexity)] // One pass builds the rows, the refs and the digests together.
fn build_record(
    request: &NativeNir1PooledPackingRequest<'_>,
    items: &[CandidateContextItem],
    candidate_owners: &HashMap<String, String>,
    bindings: &[NativeNir1AuthorityBinding],
    raw_budget_charge: &RawBudgetCharge,
) -> CandidateSetRecord {
    let mut derivation_error = None;
    let mut note = |message: String| {
        if derivation_error.is_none() {
            derivation_error = Some(message);
        }
    };
    let mut authority_digests = HashMap::<String, String>::new();
    for binding in bindings {
        match authority_binding_digest_and_size(binding) {
            Ok((digest, _)) => {
                authority_digests.insert(
                    binding.revision_id().to_owned(),
                    format!("sha256:{}", hex::encode(digest)),
                );
            }
            Err(error) => note(format!("authority binding digest: {error}")),
        }
    }
    let mut rows = Vec::with_capacity(items.len());
    for candidate in items {
        let (id, text, tokens, group) = item_parts(candidate.item());
        let kind = kind_name(candidate.item());
        let (owner_id, binding_digest) = if kind == "raw" {
            (id.to_owned(), sha256_prefixed(text.as_bytes()))
        } else {
            match candidate_owners.get(id) {
                Some(owner) => (
                    owner.clone(),
                    authority_digests.get(owner).cloned().unwrap_or_default(),
                ),
                None => {
                    note(format!("candidate item {id} has no owner Revision"));
                    (String::new(), String::new())
                }
            }
        };
        rows.push(CandidateItemRow {
            item_id: id.to_owned(),
            kind,
            text: text.to_owned(),
            tokens,
            owner_id,
            binding_digest,
            atomic_group: group.map(str::to_owned),
            atomic_part: candidate.atomic_part().map(part_name),
        });
    }
    let mut candidate_refs = Vec::with_capacity(bindings.len());
    for binding in bindings {
        let mut qualifications = Vec::new();
        // The product function derives the refs; the ordinal is a placeholder
        // that the baseline arm and the scorer ignore.
        if let Err(error) = add_revision_qualifications(
            &mut qualifications,
            0,
            request.project_id,
            binding.revision_id(),
            binding,
            &mut || Ok(()),
        ) {
            note(format!(
                "qualification refs of {}: {error}",
                binding.revision_id()
            ));
        }
        candidate_refs.push(CandidateRefRow {
            owner_id: binding.revision_id().to_owned(),
            input: InputReference {
                role: InputRole::Context,
                target: InputTarget::AcceptedRevision {
                    revision_id: binding.revision_id().to_owned(),
                    bundle_digest: binding.bundle_digest().to_owned(),
                },
                input_use: InputUse::SelectedMaterial,
            },
            qualifications,
        });
    }
    let candidate_set_digest = canonical_json_digest(&json!({
        "domain": CANDIDATE_SET_DIGEST_DOMAIN,
        "items": rows.iter().map(row_json).collect::<Vec<_>>(),
    }))
    .unwrap_or_else(|error| {
        note(format!("candidate set digest: {error}"));
        String::new()
    });
    let raw_source_id = rows
        .iter()
        .find(|row| row.kind == "raw")
        .map(|row| row.item_id.clone());
    let snapshot_identity = canonical_json_digest(&json!({
        "domain": SNAPSHOT_IDENTITY_DOMAIN,
        "projectId": request.project_id,
        "querySceneId": request.query_scene_id,
        "revisionIds": request.revision_ids,
        "rawSourceId": raw_source_id,
        "bindings": bindings
            .iter()
            .map(|binding| json!({
                "revisionId": binding.revision_id(),
                "authorityDigest": authority_digests.get(binding.revision_id()),
            }))
            .collect::<Vec<_>>(),
        "candidateSetDigest": candidate_set_digest,
    }))
    .unwrap_or_else(|error| {
        note(format!("snapshot identity: {error}"));
        String::new()
    });
    CandidateSetRecord {
        sequence: NEXT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        pooled_source_path: matches!(raw_budget_charge, RawBudgetCharge::AlreadyCharged),
        project_id: request.project_id.to_owned(),
        query_scene_id: request.query_scene_id.to_owned(),
        revision_ids: request.revision_ids.to_vec(),
        budget_tokens: request.budget_tokens,
        purpose: request.purpose,
        items: rows,
        candidate_refs,
        candidate_set_digest,
        snapshot_identity,
        derivation_error,
        candidate_items: items.to_vec(),
        item_owners: candidate_owners.clone(),
        bindings: bindings.to_vec(),
    }
}

/// Observation call (c-1). Writes the thread-local slot and returns nothing.
pub(super) fn observe_candidate_set(
    request: &NativeNir1PooledPackingRequest<'_>,
    items: &[CandidateContextItem],
    candidate_owners: &HashMap<String, String>,
    bindings: &[NativeNir1AuthorityBinding],
    raw_budget_charge: &RawBudgetCharge,
) {
    let record = build_record(
        request,
        items,
        candidate_owners,
        bindings,
        raw_budget_charge,
    );
    LATEST.with(|slot| {
        if let Ok(mut slot) = slot.try_borrow_mut() {
            *slot = Some(record);
        }
    });
}

/// Take the record (c-1) wrote on this thread, if any.
pub fn take_candidate_set() -> Option<CandidateSetRecord> {
    LATEST.with(|slot| slot.try_borrow_mut().ok().and_then(|mut slot| slot.take()))
}

/// Drop a record that no request will take.
pub fn discard_candidate_set() {
    drop(take_candidate_set());
}

/// Check that a record belongs to the projection D-final rendered: it came
/// through the D-final pooled Source path, and its project, Scene, Raw source
/// and Revisions match. Returns a reason when it does not.
pub fn check_record_matches_projection(
    record: &CandidateSetRecord,
    projection: &NativeNir1PreparedInputs,
) -> std::result::Result<(), String> {
    if !record.pooled_source_path {
        return Err("the candidate set came from a path other than D-final".into());
    }
    if record.project_id != projection.project_id()
        || record.query_scene_id != projection.query_scene_id()
    {
        return Err("the candidate set belongs to another project or Scene".into());
    }
    let source_key = &projection.raw_source_binding().binding().source_key;
    if !record
        .items
        .iter()
        .any(|row| row.kind == "raw" && &row.item_id == source_key)
    {
        return Err("the candidate set does not hold the rendered Raw source".into());
    }
    let known = record.binding_revision_ids();
    if projection
        .authority_bindings()
        .iter()
        .any(|binding| !known.contains(&binding.revision_id()))
    {
        return Err("a rendered Revision is not in the candidate set".into());
    }
    Ok(())
}

/// The parts of the rendered projection that do not depend on the selection.
/// The baseline arm builds its own `NativeNir1PreparedInputs` from these and
/// the candidate set.
#[derive(Clone)]
pub struct RenderBase {
    capture: AcceptedChatInputCapture,
    project_id: String,
    query_scene_id: String,
    user_message_version: MessageVersion,
    user_message: String,
    raw_source_binding: NativeNir1RawSourceBinding,
    history_context: HistoryContextStage,
}

pub fn render_base(projection: &NativeNir1PreparedInputs) -> RenderBase {
    RenderBase {
        capture: projection.capture.clone(),
        project_id: projection.project_id.clone(),
        query_scene_id: projection.query_scene_id.clone(),
        user_message_version: projection.user_message_version.clone(),
        user_message: projection.user_message.clone(),
        raw_source_binding: projection.raw_source_binding.clone(),
        history_context: projection.history_context.clone(),
    }
}

/// Build the renderer input of a baseline selection with the product function
/// that D-final uses (`build_native_nir1_prepared_inputs`): the kept items in
/// their original order, ordinals assigned in that order, and the input
/// reference and qualification refs of the kept Revisions derived by
/// `add_revision_qualifications`. Items whose id is not in the candidate set
/// are an error.
pub fn prepared_inputs_for_baseline(
    set: &CandidateSetRecord,
    base: &RenderBase,
    kept_item_ids: &[String],
) -> Result<NativeNir1PreparedInputs> {
    let kept = kept_item_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    ensure!(
        kept.len() == kept_item_ids.len(),
        "NIR1_EVAL_BASELINE_KEPT_ITEM_DUPLICATED"
    );
    let selected_items = set
        .candidate_items
        .iter()
        .filter(|candidate| kept.contains(item_id(candidate.item())))
        .map(|candidate| NativeNir1SelectedContextItem {
            item: candidate.item().clone(),
            atomic_part: candidate.atomic_part(),
            candidate_binding: candidate.candidate_binding().copied(),
            owner_revision_id: set.item_owners.get(item_id(candidate.item())).cloned(),
        })
        .collect::<Vec<_>>();
    ensure!(
        selected_items.len() == kept.len(),
        "NIR1_EVAL_BASELINE_KEPT_ITEM_UNKNOWN"
    );
    let selected_ids = selected_items
        .iter()
        .map(|selected| item_id(&selected.item).to_owned())
        .collect::<Vec<_>>();
    let omitted_ids = set
        .candidate_items
        .iter()
        .map(|candidate| item_id(candidate.item()))
        .filter(|id| !kept.contains(id))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let used_tokens = set
        .candidate_items
        .iter()
        .filter(|candidate| kept.contains(item_id(candidate.item())))
        .map(|candidate| item_parts(candidate.item()).2)
        .sum::<usize>();
    let pooled = NativeNir1PooledPackedContext {
        packed: PackedContext {
            selected_ids,
            omitted_ids,
            used_tokens,
            remaining_tokens: set.budget_tokens.saturating_sub(used_tokens),
        },
        selected_items,
        bindings: set.bindings.clone(),
        raw_source_binding: Some(base.raw_source_binding.clone()),
        excluded: Vec::new(),
    };
    build_native_nir1_prepared_inputs(
        base.capture.clone(),
        base.project_id.clone(),
        base.query_scene_id.clone(),
        base.user_message_version.clone(),
        base.user_message.clone(),
        pooled,
        base.history_context.clone(),
        &mut || Ok(()),
    )
}

#[cfg(test)]
mod tests;
