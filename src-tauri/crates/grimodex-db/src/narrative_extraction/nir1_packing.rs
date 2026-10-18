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
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(feature = "native-current-human-capture")]
use std::collections::{BTreeMap, BTreeSet};
use std::collections::{HashMap, HashSet};
use std::ops::Deref;
#[cfg(feature = "native-current-human-capture")]
use std::time::Instant;

use super::human_material_basis::MaterialEvidenceEntry;
use super::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDecision,
    Nir1EntityRelationDisclosure, Nir1EntityRelationDisclosureRead, Nir1EntityRelationFreshness,
    Nir1EntityRelationRevision,
};
#[cfg(feature = "native-current-human-capture")]
use super::nir1_graph::read_nir1_graph_seal;
use super::nir1_history_adoption::{
    adopt_history_turns, AdoptedTurn, AdoptionLimits, HistoryAdoptionRequest,
};
#[cfg(feature = "native-current-human-capture")]
use super::nir1_history_budget::{parent_read_cost_in_tx, reauthorize_turn_history_in_tx};
#[cfg(feature = "native-current-human-capture")]
use super::nir1_history_context::{
    build_history_context_stage, finish_history_draft, HistoryContextStage, NativeNir1HistoryDraft,
    TurnHistoryRange,
};
#[cfg(feature = "native-current-human-capture")]
use super::retrieval_admission::read_retrieval_scene_source_bounded;
#[cfg(feature = "native-current-human-capture")]
use super::retrieval_admission::{RetrievalSceneSourceBinding, RetrievalSceneSourceRead};
#[cfg(feature = "native-current-human-capture")]
use crate::narrative_maintenance_connection::ParticipantSqlOperationBudget;
#[cfg(feature = "native-current-human-capture")]
use crate::nir1_generation::history_context::HistorySendClassification;
#[cfg(feature = "native-current-human-capture")]
use crate::nir1_generation::GenerationPurpose;
#[cfg(feature = "native-current-human-capture")]
use crate::nir1_generation::{
    check_attempt_completeness, d1_selection_digest, d1_selection_reference,
    read_attempt_scene_binding_in_tx, read_current_chat_input_capture_in_tx,
    read_expected_scope_in_tx, scope_identity, AcceptedChatInputCapture, AttemptSceneBinding,
    CompletenessContext, CompletenessViolation, D1SelectionParameters, InputReference, InputRole,
    InputTarget, InputUse, MessageVersion, Nir1ExpectedScope, NotApplicableReason,
    QualificationBody, QualificationKind, QualificationReference, ScopeRole, TypedTarget,
    D1_SELECTION_IDENTITY,
};
#[cfg(feature = "native-current-human-capture")]
use crate::nir1_generation_history::{
    CandidateDisposition, SessionCandidateKind, SessionHistoryOutcome,
};
#[cfg(feature = "native-current-human-capture")]
use crate::state::ActiveWorkspaceSnapshot;
use crate::Database;

#[cfg(feature = "nir1-final-request-eval")]
pub mod final_request_eval;
#[cfg(feature = "native-current-human-capture")]
pub mod graph_candidates;
#[cfg(feature = "native-current-human-capture")]
pub use graph_candidates::{
    graph_evidence_ref, graph_index_reference, read_nir1_graph_seed, read_nir1_graph_seed_in_tx,
    NativeNir1GraphBinding, NativeNir1GraphExclusion, NativeNir1GraphGroup, NativeNir1GraphInput,
    NativeNir1GraphOutcome, Nir1GraphCandidateBinding, Nir1GraphCandidateEdge, Nir1GraphCandidates,
    Nir1GraphDropReason, Nir1GraphExclusionReason, Nir1GraphSeedRead, GRAPH_EVIDENCE_REF_FORM,
    GRAPH_INDEX_REF_FORM, NATIVE_ATTEMPT_MAX_REFERENCES, NATIVE_ATTEMPT_MAX_REFERENCE_BYTES,
};

const NATIVE_ATOMIC_PART_COUNT: usize = 5;

/// Raw context supplied to the request-local Native packing boundary. Reader
/// material is always projected from the current typed reader below.
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
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
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
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
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
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
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub struct NativeNir1SelectedContextItem {
    item: ContextItemKind,
    atomic_part: Option<AtomicPart>,
    candidate_binding: Option<[u8; 32]>,
    owner_revision_id: Option<String>,
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
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
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

/// Internal request, deliberately separate from a renderer/final-payload DTO.
/// Raw items retain the legacy diagnostic contract and confer no Source authority.
pub(super) struct NativeNir1PooledPackingRequest<'a> {
    pub project_id: &'a str,
    pub revision_ids: &'a [String],
    pub query_scene_id: &'a str,
    pub budget_tokens: usize,
    pub purpose: PackingPurpose,
    pub raw_items: &'a [NativeNir1RawContextItem],
    /// Text-free Graph candidates (DI-1a). Only the Native selection attaches
    /// them; the pooled reader requalifies them in its own snapshot.
    #[cfg(feature = "native-current-human-capture")]
    pub graph: Option<&'a Nir1GraphCandidates>,
}

/// Internal request for the product-side candidate composition. It has no
/// caller-supplied Raw field; the query Scene Source reader supplies that item.
#[cfg(feature = "native-current-human-capture")]
pub(super) struct NativeNir1SourcePooledPackingRequest<'a> {
    pub project_id: &'a str,
    pub revision_ids: &'a [String],
    pub query_scene_id: &'a str,
    pub budget_tokens: usize,
    pub purpose: PackingPurpose,
    pub graph: Option<&'a Nir1GraphCandidates>,
}

/// Request-local reference to a persisted Scene Source. The binding is the
/// complete Source identity observed by the caller; a token or renderer label
/// alone cannot authorize the body.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NativeNir1RawSourceRef<'a> {
    pub project_id: &'a str,
    pub scene_id: &'a str,
    pub binding: &'a RetrievalSceneSourceBinding,
}

/// Exact query Source identity retained beside the selected Raw item so that a
/// later Native boundary can reauthorize the body before direct input use.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1RawSourceBinding {
    pub(super) project_id: String,
    pub(super) scene_id: String,
    pub(super) binding: RetrievalSceneSourceBinding,
}

#[cfg(feature = "native-current-human-capture")]
impl NativeNir1RawSourceBinding {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn scene_id(&self) -> &str {
        &self.scene_id
    }

    pub fn binding(&self) -> &RetrievalSceneSourceBinding {
        &self.binding
    }
}

pub(super) struct NativeNir1PooledPackedContext {
    pub packed: PackedContext,
    pub selected_items: Vec<NativeNir1SelectedContextItem>,
    // All consulted unique Revisions, including omitted groups. These are
    // observations; downstream direct input references must follow selected_items.
    pub bindings: Vec<NativeNir1AuthorityBinding>,
    #[cfg(feature = "native-current-human-capture")]
    pub raw_source_binding: Option<NativeNir1RawSourceBinding>,
    /// Candidates the Native selection left out because A2 or A3 reported them
    /// unavailable, in candidate order. They are not in `bindings`, the
    /// candidate items or the packed context. Empty under `Reject`.
    #[cfg(feature = "native-current-human-capture")]
    pub excluded: Vec<NativeNir1ExcludedRevision>,
    /// What the Graph candidates did in this snapshot; `None` when the request
    /// carried none.
    #[cfg(feature = "native-current-human-capture")]
    pub graph: Option<NativeNir1GraphOutcome>,
}

/// What the pooled reader does with a Revision that A2 or A3 reports
/// unavailable (DI-1c R-1).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RevisionUnavailablePolicy {
    /// The whole request fails with `NIR1_NATIVE_A2_UNAVAILABLE:<reason>`. The
    /// caller-supplied Revision list, the single-Revision wrapper and the
    /// DP-H rejection variant use this.
    Reject,
    /// The candidate alone is left out, with a closed reason. Only the Native
    /// selection uses this. An unknown reason, a request-level reason, a SQL
    /// error, a cancel and a budget stop still fail the whole request.
    #[cfg(feature = "native-current-human-capture")]
    Exclude,
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
pub(super) struct NativePackingInputBudget {
    used_bytes: usize,
    retained_binding_bytes: usize,
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

    /// Preflight the bounded Source reader's temporary peak without charging
    /// the final selector envelope. The reader reports a monotonic peak for
    /// persisted columns, parser/output work, and retained Source metadata;
    /// the returned Raw item is charged exactly once by `reserve_raw`.
    #[cfg(feature = "native-current-human-capture")]
    fn preflight_source_peak(&self, peak_bytes: usize) -> Result<()> {
        let remaining = MAX_PACKING_INPUT_BYTES.saturating_sub(self.used_bytes);
        ensure!(
            peak_bytes <= remaining,
            "NIR1_NATIVE_RAW_SOURCE_PEAK_LIMIT {MAX_PACKING_INPUT_BYTES}"
        );
        Ok(())
    }

    /// Charge `bytes` more if the shared envelope still holds them; otherwise
    /// charge nothing. The Graph swap uses this: a Graph group replaces an
    /// accepted IR group that is already charged and only adds the difference.
    #[cfg(feature = "native-current-human-capture")]
    fn try_reserve_additional(&mut self, bytes: usize) -> bool {
        match self.used_bytes.checked_add(bytes) {
            Some(next) if next <= MAX_PACKING_INPUT_BYTES => {
                self.used_bytes = next;
                true
            }
            _ => false,
        }
    }

    /// Give back bytes `try_reserve_additional` charged.
    #[cfg(feature = "native-current-human-capture")]
    fn release_additional(&mut self, bytes: usize) {
        self.used_bytes = self.used_bytes.saturating_sub(bytes);
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RawBudgetCharge {
    Charge,
    #[cfg(feature = "native-current-human-capture")]
    AlreadyCharged,
}

/// Read one Raw body from the canonical persisted Scene Source. This is an
/// internal adapter only: it does not change the existing public wrapper or
/// expose a renderer/IPC DTO. The scalar SQLite length check intentionally
/// happens before the bounded Source reader materializes any stored body.
/// The Source reader and this adapter borrow the caller's transaction and
/// therefore inherit its existing progress owner; no nested hook is installed.
#[cfg(feature = "native-current-human-capture")]
fn read_nir1_current_source_raw_context_item_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    expected: Option<NativeNir1RawSourceRef<'_>>,
    input_budget: &mut NativePackingInputBudget,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<(NativeNir1RawContextItem, NativeNir1RawSourceBinding)> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_NATIVE_RAW_SOURCE_REQUIRES_READ_TRANSACTION"
    );
    ensure!(
        !project_id.is_empty() && project_id.trim() == project_id,
        "NIR1_NATIVE_RAW_SOURCE_PROJECT_ID_INVALID"
    );
    ensure!(
        !scene_id.is_empty() && scene_id.trim() == scene_id,
        "NIR1_NATIVE_RAW_SOURCE_SCENE_ID_INVALID"
    );
    if let Some(source_ref) = expected {
        ensure!(
            source_ref.project_id == project_id && source_ref.scene_id == scene_id,
            "NIR1_NATIVE_RAW_SOURCE_IDENTITY_MISMATCH"
        );
        ensure!(
            source_ref.binding.source_key == format!("project:scene:{scene_id}")
                && !source_ref.binding.revision_token.trim().is_empty(),
            "NIR1_NATIVE_RAW_SOURCE_IDENTITY_MISMATCH"
        );
    }
    let source = match read_retrieval_scene_source_bounded(
        conn,
        project_id,
        scene_id,
        MAX_PACKING_INPUT_BYTES,
        MAX_PACKING_INPUT_BYTES,
        checkpoint,
        &mut |peak_bytes| input_budget.preflight_source_peak(peak_bytes),
    )? {
        RetrievalSceneSourceRead::Available(source) => source,
        RetrievalSceneSourceRead::Unavailable { .. } => {
            anyhow::bail!("NIR1_NATIVE_RAW_SOURCE_UNAVAILABLE")
        }
    };
    ensure!(
        source.project_id == project_id
            && source.scene_id == scene_id
            && source.query_source.source_key == format!("project:scene:{scene_id}"),
        "NIR1_NATIVE_RAW_SOURCE_IDENTITY_MISMATCH"
    );
    if let Some(source_ref) = expected {
        ensure!(
            source.query_source == *source_ref.binding,
            "NIR1_NATIVE_RAW_SOURCE_STALE"
        );
    }
    ensure!(!source.archived, "NIR1_NATIVE_RAW_SOURCE_ARCHIVED");
    checkpoint()?;

    let raw_source_binding = NativeNir1RawSourceBinding {
        project_id: project_id.to_owned(),
        scene_id: scene_id.to_owned(),
        binding: source.query_source.clone(),
    };
    let text = source.canonical_source_text;
    ensure!(!text.is_empty(), "NIR1_NATIVE_RAW_SOURCE_EMPTY");
    ensure!(
        text.len() <= MAX_PACKING_INPUT_BYTES,
        "NIR1_NATIVE_RAW_SOURCE_OUTPUT_LIMIT {MAX_PACKING_INPUT_BYTES}"
    );
    let raw = NativeNir1RawContextItem {
        id: source.query_source.source_key,
        tokens: estimate_nir1_context_tokens(&text),
        text,
    };
    input_budget.reserve_raw(&raw)?;
    checkpoint()?;
    Ok((raw, raw_source_binding))
}

#[cfg(feature = "native-current-human-capture")]
pub(super) fn read_nir1_source_raw_context_item(
    conn: &Connection,
    source_ref: NativeNir1RawSourceRef<'_>,
    input_budget: &mut NativePackingInputBudget,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1RawContextItem> {
    read_nir1_current_source_raw_context_item_in_tx(
        conn,
        source_ref.project_id,
        source_ref.scene_id,
        Some(source_ref),
        input_budget,
        checkpoint,
    )
    .map(|(raw, _)| raw)
}

/// Read and pool the exact query Scene Raw plus typed Revision candidates in
/// one caller-owned read transaction. Only the query Scene Source is accepted;
/// Graph target bodies and caller-provided Raw labels/text are not inputs.
/// Source reading charges its Raw bytes here, and the pooled selector skips a
/// second Raw reservation while still using the same cumulative budget.
#[cfg(all(test, feature = "native-current-human-capture"))]
pub(super) fn read_and_pack_native_a2_context_with_source_raw_in_tx(
    conn: &Connection,
    request: NativeNir1SourcePooledPackingRequest<'_>,
    source_ref: NativeNir1RawSourceRef<'_>,
    input_budget: &mut NativePackingInputBudget,
    reserve_retained_binding: &mut impl FnMut(usize) -> Result<()>,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1PooledPackedContext> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_NATIVE_PACKING_REQUIRES_READ_TRANSACTION"
    );
    ensure!(
        source_ref.project_id == request.project_id,
        "NIR1_NATIVE_RAW_SOURCE_PROJECT_MISMATCH"
    );
    ensure!(
        source_ref.scene_id == request.query_scene_id,
        "NIR1_NATIVE_RAW_SOURCE_QUERY_SCENE_MISMATCH"
    );

    let (raw, raw_source_binding) = read_nir1_current_source_raw_context_item_in_tx(
        conn,
        request.project_id,
        request.query_scene_id,
        Some(source_ref),
        input_budget,
        checkpoint,
    )?;
    pool_native_source_and_context(
        conn,
        request,
        raw,
        raw_source_binding,
        RevisionUnavailablePolicy::Reject,
        input_budget,
        reserve_retained_binding,
        checkpoint,
    )
}

#[cfg(all(test, feature = "native-current-human-capture"))]
pub(super) fn read_and_pack_native_a2_context_with_current_source_in_tx(
    conn: &Connection,
    request: NativeNir1SourcePooledPackingRequest<'_>,
    input_budget: &mut NativePackingInputBudget,
    reserve_retained_binding: &mut impl FnMut(usize) -> Result<()>,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1PooledPackedContext> {
    read_and_pack_native_a2_context_with_current_source_and_policy_in_tx(
        conn,
        request,
        RevisionUnavailablePolicy::Reject,
        input_budget,
        reserve_retained_binding,
        checkpoint,
    )
}

#[cfg(feature = "native-current-human-capture")]
pub(super) fn read_and_pack_native_a2_context_with_current_source_and_policy_in_tx(
    conn: &Connection,
    request: NativeNir1SourcePooledPackingRequest<'_>,
    policy: RevisionUnavailablePolicy,
    input_budget: &mut NativePackingInputBudget,
    reserve_retained_binding: &mut impl FnMut(usize) -> Result<()>,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1PooledPackedContext> {
    let (raw, raw_source_binding) = read_nir1_current_source_raw_context_item_in_tx(
        conn,
        request.project_id,
        request.query_scene_id,
        None,
        input_budget,
        checkpoint,
    )?;
    pool_native_source_and_context(
        conn,
        request,
        raw,
        raw_source_binding,
        policy,
        input_budget,
        reserve_retained_binding,
        checkpoint,
    )
}

#[cfg(feature = "native-current-human-capture")]
#[allow(clippy::too_many_arguments)] // The Raw read, its binding and the policy are separate values.
fn pool_native_source_and_context(
    conn: &Connection,
    request: NativeNir1SourcePooledPackingRequest<'_>,
    raw: NativeNir1RawContextItem,
    raw_source_binding: NativeNir1RawSourceBinding,
    policy: RevisionUnavailablePolicy,
    input_budget: &mut NativePackingInputBudget,
    reserve_retained_binding: &mut impl FnMut(usize) -> Result<()>,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1PooledPackedContext> {
    let pooled_request = NativeNir1PooledPackingRequest {
        project_id: request.project_id,
        revision_ids: request.revision_ids,
        query_scene_id: request.query_scene_id,
        budget_tokens: request.budget_tokens,
        purpose: request.purpose,
        raw_items: std::slice::from_ref(&raw),
        graph: request.graph,
    };
    let mut packed = read_and_pack_native_a2_context_in_tx_with_raw_charge(
        conn,
        pooled_request,
        input_budget,
        RawBudgetCharge::AlreadyCharged,
        policy,
        reserve_retained_binding,
        checkpoint,
    )?;
    packed.raw_source_binding = Some(raw_source_binding);
    Ok(packed)
}

/// One Native-renderable item adopted by the selector. Its ordinal points to
/// the exact direct InputReference that authorizes this text.
#[cfg(feature = "native-current-human-capture")]
pub struct NativeNir1PreparedContextItem {
    input_ordinal: usize,
    text: String,
}

#[cfg(feature = "native-current-human-capture")]
impl NativeNir1PreparedContextItem {
    pub fn input_ordinal(&self) -> usize {
        self.input_ordinal
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

/// Why D-final left one accepted Revision out of the request (K4/3 section
/// 3, rule 2; DI-1c R-1). The set is closed; the other inputs and the attempt
/// context are kept.
///
/// `MaterialBasisSourceTokenConflict` is decided from a Revision that A2 and
/// A3 already accepted. Every other variant is one `reason` that the A2
/// current reader or the A3 disclosure check reports for a single candidate
/// (`Nir1EntityRelationDisclosureRead::Unavailable`), with the same code
/// string. Only the Native selection excludes on them; a caller-supplied
/// Revision list still rejects the whole request. A reason that has no
/// variant here, and the four query-Scene reasons of
/// [`REQUEST_LEVEL_UNAVAILABLE_REASONS`], fail the whole request.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeNir1RevisionExclusionReason {
    /// The sealed material basis (`source_basis` and `evidence_set`) holds the
    /// same source key with two different revision tokens.
    MaterialBasisSourceTokenConflict,
    // A2: identity, approval, restore, payload and envelope.
    RevisionNotFound,
    RevisionNotCurrent,
    RevisionKindMismatch,
    RevisionNotHumanApproved,
    RevisionDecisionAmbiguous,
    RevisionRestoreInvalidated,
    RevisionPayloadInvalid,
    RevisionPayloadBindingInvalid,
    RevisionEnvelopeInvalid,
    // A2: material contract, live sources and Freshness.
    RevisionMaterialContractSuperseded,
    RevisionMaterialContractMixed,
    RevisionMaterialContractUnsupported,
    SourceRevisionChanged,
    RevisionMaterialMismatch,
    RevisionMaterialAuthorityMismatch,
    CanonicalFreshnessUnavailable,
    // A3: Scope authority, reading order and material Scenes.
    A3ScopeAuthorityStale,
    A3ReadingScopeUnavailable,
    A3ReadingBeforeQueryViolation,
    A3MaterialScopeUnavailable,
    A3MaterialScopeMismatch,
    // A3: axes, reveal, POV and phase.
    A3ScopeAxisUnavailable,
    A3StoryScopeUnavailable,
    A3StoryScopeFuture,
    A3AutoScopeUnavailable,
    A3AutoScopeFuture,
    A3RevealUnavailable,
    A3PovUnavailable,
    A3PovMismatch,
    A3PhaseUnavailable,
    A3PhaseAmbiguous,
    A3PhaseAnchorUnavailable,
    A3PhaseStoryUnavailable,
    A3PhaseFuture,
    A3PhaseContextUnavailable,
}

/// The A3 reasons that are about the query Scene, not about the candidate
/// (`load_a3_query_context`): every candidate meets the same one. They are not
/// exclusions; the request fails with the reason, as the caller-list entry
/// does.
#[cfg(feature = "native-current-human-capture")]
const REQUEST_LEVEL_UNAVAILABLE_REASONS: [&str; 4] = [
    "a3-query-scene-unavailable",
    "a3-query-axis-unavailable",
    "a3-query-scope-unavailable",
    "a3-query-viewpoint-unavailable",
];

#[cfg(feature = "native-current-human-capture")]
impl NativeNir1RevisionExclusionReason {
    /// Every variant, in declaration order.
    pub const ALL: [Self; 36] = [
        Self::MaterialBasisSourceTokenConflict,
        Self::RevisionNotFound,
        Self::RevisionNotCurrent,
        Self::RevisionKindMismatch,
        Self::RevisionNotHumanApproved,
        Self::RevisionDecisionAmbiguous,
        Self::RevisionRestoreInvalidated,
        Self::RevisionPayloadInvalid,
        Self::RevisionPayloadBindingInvalid,
        Self::RevisionEnvelopeInvalid,
        Self::RevisionMaterialContractSuperseded,
        Self::RevisionMaterialContractMixed,
        Self::RevisionMaterialContractUnsupported,
        Self::SourceRevisionChanged,
        Self::RevisionMaterialMismatch,
        Self::RevisionMaterialAuthorityMismatch,
        Self::CanonicalFreshnessUnavailable,
        Self::A3ScopeAuthorityStale,
        Self::A3ReadingScopeUnavailable,
        Self::A3ReadingBeforeQueryViolation,
        Self::A3MaterialScopeUnavailable,
        Self::A3MaterialScopeMismatch,
        Self::A3ScopeAxisUnavailable,
        Self::A3StoryScopeUnavailable,
        Self::A3StoryScopeFuture,
        Self::A3AutoScopeUnavailable,
        Self::A3AutoScopeFuture,
        Self::A3RevealUnavailable,
        Self::A3PovUnavailable,
        Self::A3PovMismatch,
        Self::A3PhaseUnavailable,
        Self::A3PhaseAmbiguous,
        Self::A3PhaseAnchorUnavailable,
        Self::A3PhaseStoryUnavailable,
        Self::A3PhaseFuture,
        Self::A3PhaseContextUnavailable,
    ];

    pub fn code(self) -> &'static str {
        match self {
            Self::MaterialBasisSourceTokenConflict => "material-basis-source-token-conflict",
            Self::RevisionNotFound => "revision-not-found",
            Self::RevisionNotCurrent => "revision-not-current",
            Self::RevisionKindMismatch => "revision-kind-mismatch",
            Self::RevisionNotHumanApproved => "revision-not-human-approved",
            Self::RevisionDecisionAmbiguous => "revision-decision-ambiguous",
            Self::RevisionRestoreInvalidated => "revision-restore-invalidated",
            Self::RevisionPayloadInvalid => "revision-payload-invalid",
            Self::RevisionPayloadBindingInvalid => "revision-payload-binding-invalid",
            Self::RevisionEnvelopeInvalid => "revision-envelope-invalid",
            Self::RevisionMaterialContractSuperseded => "revision-material-contract-superseded",
            Self::RevisionMaterialContractMixed => "revision-material-contract-mixed",
            Self::RevisionMaterialContractUnsupported => "revision-material-contract-unsupported",
            Self::SourceRevisionChanged => "source-revision-changed",
            Self::RevisionMaterialMismatch => "revision-material-mismatch",
            Self::RevisionMaterialAuthorityMismatch => "revision-material-authority-mismatch",
            Self::CanonicalFreshnessUnavailable => "canonical-freshness-unavailable",
            Self::A3ScopeAuthorityStale => "a3-scope-authority-stale",
            Self::A3ReadingScopeUnavailable => "a3-reading-scope-unavailable",
            Self::A3ReadingBeforeQueryViolation => "a3-reading-before-query-violation",
            Self::A3MaterialScopeUnavailable => "a3-material-scope-unavailable",
            Self::A3MaterialScopeMismatch => "a3-material-scope-mismatch",
            Self::A3ScopeAxisUnavailable => "a3-scope-axis-unavailable",
            Self::A3StoryScopeUnavailable => "a3-story-scope-unavailable",
            Self::A3StoryScopeFuture => "a3-story-scope-future",
            Self::A3AutoScopeUnavailable => "a3-auto-scope-unavailable",
            Self::A3AutoScopeFuture => "a3-auto-scope-future",
            Self::A3RevealUnavailable => "a3-reveal-unavailable",
            Self::A3PovUnavailable => "a3-pov-unavailable",
            Self::A3PovMismatch => "a3-pov-mismatch",
            Self::A3PhaseUnavailable => "a3-phase-unavailable",
            Self::A3PhaseAmbiguous => "a3-phase-ambiguous",
            Self::A3PhaseAnchorUnavailable => "a3-phase-anchor-unavailable",
            Self::A3PhaseStoryUnavailable => "a3-phase-story-unavailable",
            Self::A3PhaseFuture => "a3-phase-future",
            Self::A3PhaseContextUnavailable => "a3-phase-context-unavailable",
        }
    }

    /// The variant for one A2/A3 `Unavailable` reason, or `None` for a reason
    /// that is not a closed per-candidate reason (the caller then fails the
    /// request). The material-basis variant is not an A2/A3 reason.
    fn from_a2_a3_code(code: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .filter(|reason| *reason != Self::MaterialBasisSourceTokenConflict)
            .find(|reason| reason.code() == code)
    }
}

/// An accepted Revision that D-final did not adopt, with its closed reason.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1ExcludedRevision {
    revision_id: String,
    reason: NativeNir1RevisionExclusionReason,
}

#[cfg(feature = "native-current-human-capture")]
impl NativeNir1ExcludedRevision {
    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn reason(&self) -> NativeNir1RevisionExclusionReason {
        self.reason
    }
}

/// The final qualification rows of a prepared request: the producer's rows
/// plus the D1 selection references, with the parameters the selection digest
/// was computed from (K4/3 section 2; a history slot stores these fields).
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1FinalQualifications {
    pub qualifications: Vec<QualificationReference>,
    pub d1_selection: D1SelectionParameters,
    pub d1_selection_digest: String,
}

/// What Native supplies for the history of one turn (DI1B-3). A caller that
/// passes `None` asks for no history: the prepared inputs then hold the
/// Human, the Raw and the Revisions only, byte for byte as before history.
///
/// * `now_ms` is the Native clock's value for the turn. This crate reads no
///   wall clock; the 30-day validity of a past turn is decided against it.
/// * `message_envelope_tokens` is what one chat message costs besides its
///   text. The history is counted in the same budget as the context (it
///   takes the tokens the selector's budget leaves after the Raw and the
///   accepted IR), so the envelope of each history message is part of it.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeNir1HistoryRequest {
    pub now_ms: i64,
    pub message_envelope_tokens: usize,
}

/// One adopted history message, in the order it is rendered (oldest first).
/// The text is the body the run read and authenticated; it is request-local
/// like the Human body, with no Debug or Serialize.
#[cfg(feature = "native-current-human-capture")]
pub struct NativeNir1PreparedHistoryMessage {
    input_ordinal: usize,
    role: InputRole,
    text: String,
    tokens: usize,
}

#[cfg(feature = "native-current-human-capture")]
impl NativeNir1PreparedHistoryMessage {
    /// The ordinal of the message's input row.
    pub fn input_ordinal(&self) -> usize {
        self.input_ordinal
    }

    /// `User` for a past Human, `Assistant` for a generated output.
    pub fn role(&self) -> &InputRole {
        &self.role
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The tokens the message takes in the request: its text and its envelope.
    pub fn tokens(&self) -> usize {
        self.tokens
    }
}

/// What the history of a turn came to, without any text or identifier: for
/// tests and evidence.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NativeNir1HistoryObservation {
    pub adopted_turns: usize,
    pub adopted_messages: usize,
    pub tokens: usize,
    /// Adopted replies written against a Scene body that has since changed.
    pub changed_body_replies: usize,
    /// The closed code of why the whole turn went on without history.
    pub without_history: Option<&'static str>,
    /// The closed code of every qualified turn that was not adopted, newest
    /// first.
    pub not_adopted: Vec<&'static str>,
}

/// The adopted history of a prepared request and what is needed to confirm it
/// again before the request is sent.
#[cfg(feature = "native-current-human-capture")]
struct PreparedHistory {
    purpose: GenerationPurpose,
    send_classification: HistorySendClassification,
    turns: Vec<AdoptedTurn>,
    messages: Vec<NativeNir1PreparedHistoryMessage>,
    observation: NativeNir1HistoryObservation,
}

#[cfg(feature = "native-current-human-capture")]
impl PreparedHistory {
    fn tokens(&self) -> usize {
        self.messages.iter().map(|message| message.tokens).sum()
    }
}

/// Request-local DB projection. It is neither a wire DTO nor a dispatch or
/// attempt capability. Private prompt/context text has no Debug/Serialize
/// implementation and is dropped with the preparing owner.
#[cfg(feature = "native-current-human-capture")]
pub struct NativeNir1PreparedInputs {
    capture: AcceptedChatInputCapture,
    project_id: String,
    query_scene_id: String,
    user_message_version: MessageVersion,
    user_message: String,
    input_references: Vec<InputReference>,
    qualifications: Vec<QualificationReference>,
    context_items: Vec<NativeNir1PreparedContextItem>,
    raw_source_binding: NativeNir1RawSourceBinding,
    authority_bindings: Vec<NativeNir1AuthorityBinding>,
    excluded_revisions: Vec<NativeNir1ExcludedRevision>,
    /// What the Graph candidates did in this snapshot (None when the request
    /// carried none). It is a record of the read, not an input of the request.
    graph_outcome: Option<NativeNir1GraphOutcome>,
    /// B's seal and the Graph-derived inputs this request adopted, with the
    /// Index reference recorded for each (None when it adopted none).
    graph_binding: Option<NativeNir1GraphBinding>,
    /// The history turn context built in the same snapshot, without the D1
    /// fields (K4/3 section 2). `history_draft` completes it.
    history_context: HistoryContextStage,
    /// The history turns adopted after the Raw and the Revisions (DI1B-3).
    /// `None` when the caller asked for none.
    history: Option<PreparedHistory>,
}

#[cfg(feature = "native-current-human-capture")]
impl NativeNir1PreparedInputs {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn query_scene_id(&self) -> &str {
        &self.query_scene_id
    }

    pub fn chat_session_id(&self) -> &str {
        self.capture.chat_session_id()
    }

    pub fn user_message_version(&self) -> &MessageVersion {
        &self.user_message_version
    }

    pub fn user_message(&self) -> &str {
        &self.user_message
    }

    pub fn input_references(&self) -> &[InputReference] {
        &self.input_references
    }

    pub fn qualifications(&self) -> &[QualificationReference] {
        &self.qualifications
    }

    pub fn context_items(&self) -> &[NativeNir1PreparedContextItem] {
        &self.context_items
    }

    pub fn raw_source_binding(&self) -> &NativeNir1RawSourceBinding {
        &self.raw_source_binding
    }

    pub fn authority_bindings(&self) -> &[NativeNir1AuthorityBinding] {
        &self.authority_bindings
    }

    /// The adopted history messages, oldest first: the order they are rendered
    /// between the system message and the current Human. Empty when there is
    /// no history.
    pub fn history_messages(&self) -> &[NativeNir1PreparedHistoryMessage] {
        self.history
            .as_ref()
            .map_or(&[], |history| history.messages.as_slice())
    }

    /// What the history came to, or `None` when the caller asked for none.
    pub fn history_observation(&self) -> Option<&NativeNir1HistoryObservation> {
        self.history.as_ref().map(|history| &history.observation)
    }

    /// Accepted Revisions that were consulted but not adopted, each with its
    /// closed reason. Their input rows, references and context are absent.
    pub fn excluded_revisions(&self) -> &[NativeNir1ExcludedRevision] {
        &self.excluded_revisions
    }

    /// What the Graph candidates did in the D-final snapshot, if the request
    /// carried any: the groups that took the place of their accepted IR
    /// groups, the Revisions left out with a closed reason, and a whole-Graph
    /// drop reason.
    pub fn graph_outcome(&self) -> Option<&NativeNir1GraphOutcome> {
        self.graph_outcome.as_ref()
    }

    /// B's seal and the Graph-derived inputs this request adopted, each with
    /// its Index reference. `None` when the request adopted no Graph group.
    pub fn graph_binding(&self) -> Option<&NativeNir1GraphBinding> {
        self.graph_binding.as_ref()
    }

    /// The `(kind, target)` set that the current state derives for every
    /// adopted input, including the D1 selection of the non-current inputs.
    /// It is derived from the bindings and the Human version, not from the
    /// qualification rows, so a producer that drops or collapses a reference
    /// is detected (K4/3 section 3, rule 3).
    pub fn expected_qualification_targets(&self) -> Result<BTreeMap<usize, BTreeSet<TypedTarget>>> {
        let bindings: Vec<&NativeNir1AuthorityBinding> = self.authority_bindings.iter().collect();
        expected_targets_for_inputs(
            &self.project_id,
            &self.query_scene_id,
            &self.input_references,
            &bindings,
            self.graph_binding.as_ref(),
        )
    }

    /// Detect a D-final output that breaks the completeness rule (K4/3
    /// section 3). A violation means the history slot of the attempt is
    /// `d-final-incomplete`; this function writes no slot.
    pub fn check_completeness(
        &self,
        qualifications: &[QualificationReference],
    ) -> std::result::Result<(), CompletenessViolation> {
        let expected =
            self.expected_qualification_targets()
                .map_err(|_| CompletenessViolation {
                    input_ordinal: None,
                    kind: None,
                    scope_role: None,
                    reason: crate::nir1_generation::CompletenessReason::UnsupportedInput,
                })?;
        check_attempt_completeness(
            &self.input_references,
            qualifications,
            &CompletenessContext {
                target_scene_id: &self.query_scene_id,
                expected_targets: Some(&expected),
            },
        )
    }

    /// The history slot of this request (K4/3 section 2), completed with the
    /// D1 selection fields of `final_qualifications`. A final output that
    /// breaks the completeness rule (`check_completeness`, which includes the
    /// expected `(kind, target)` set of rule 3), or D1 fields that do not
    /// recompute the selection digest from the input rows, make the slot
    /// `d-final-incomplete`. `finalize_qualifications` already refuses an
    /// incomplete output, so this is the second line of defense for a final
    /// output built another way. The draft carries no `eligibleUntilMs` (the
    /// storage writer derives it) and no authority.
    pub fn history_draft(
        &self,
        final_qualifications: &NativeNir1FinalQualifications,
    ) -> NativeNir1HistoryDraft {
        finish_history_draft(
            &self.history_context,
            self.check_completeness(&final_qualifications.qualifications)
                .is_ok(),
            &final_qualifications.d1_selection,
            &final_qualifications.d1_selection_digest,
            &self.input_references,
        )
    }

    /// Add the D1 selection references once the rendered usage is known and
    /// check the complete output against the rule. `selector_budget_tokens` is
    /// the context budget the selector was given; the usage is the estimate of
    /// the adopted context texts, which is what the selector counted, and the
    /// adopted history messages with their envelopes, which took their tokens
    /// from what the selector left. An
    /// incomplete output is refused (`NIR1_NATIVE_PREPARED_QUALIFICATION_INCOMPLETE`).
    pub fn finalize_qualifications(
        &self,
        selector_budget_tokens: usize,
    ) -> Result<NativeNir1FinalQualifications> {
        let mut used_tokens = 0usize;
        for item in &self.context_items {
            used_tokens = used_tokens
                .checked_add(estimate_nir1_context_tokens(&item.text))
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_D1_USAGE_OVERFLOW"))?;
        }
        // The history shares the selector's budget: what it takes is used.
        if let Some(history) = &self.history {
            used_tokens = used_tokens
                .checked_add(history.tokens())
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_D1_USAGE_OVERFLOW"))?;
        }
        let remaining_tokens = selector_budget_tokens
            .checked_sub(used_tokens)
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_D1_USAGE_EXCEEDS_BUDGET"))?;
        let d1_selection = D1SelectionParameters {
            estimator_version: grimodex_core::narrative_nir1::NIR1_CONTEXT_TOKEN_ESTIMATOR_VERSION
                .to_owned(),
            selector_budget_tokens: u64::try_from(selector_budget_tokens)?,
            used_tokens: u64::try_from(used_tokens)?,
            remaining_tokens: u64::try_from(remaining_tokens)?,
        };
        let digest = d1_selection_digest(&d1_selection, &self.input_references)?;
        let mut qualifications = self.qualifications.clone();
        for (ordinal, input) in self.input_references.iter().enumerate() {
            if input.input_use != InputUse::CurrentTurn {
                qualifications.push(d1_selection_reference(ordinal, &digest));
            }
        }
        self.check_completeness(&qualifications)
            .map_err(|violation| {
                anyhow::anyhow!("NIR1_NATIVE_PREPARED_QUALIFICATION_INCOMPLETE: {violation}")
            })?;
        Ok(NativeNir1FinalQualifications {
            qualifications,
            d1_selection,
            d1_selection_digest: digest,
        })
    }
}

/// The `(kind, target)` set that the current state derives for every input
/// (K4/3 section 3, rule 3). `bindings` are the authority bindings of the
/// accepted Revisions among `inputs`. D-final calls it for the inputs it
/// adopted; the history requalifier (HC1-3) calls it for the inputs of a
/// stored attempt with the bindings of the current A3 evaluations, so the two
/// derive the expected set by one function (the D-final output is unchanged).
#[cfg(feature = "native-current-human-capture")]
pub(super) fn expected_targets_for_inputs(
    project_id: &str,
    query_scene_id: &str,
    input_references: &[InputReference],
    bindings: &[&NativeNir1AuthorityBinding],
    graph: Option<&NativeNir1GraphBinding>,
) -> Result<BTreeMap<usize, BTreeSet<TypedTarget>>> {
    let scope_target = |role: ScopeRole, components: &[&str]| TypedTarget {
        kind: QualificationKind::Scope,
        scope_role: Some(role),
        components: components.iter().map(|part| (*part).to_owned()).collect(),
    };
    let plain = |kind: QualificationKind, identity: &str| TypedTarget {
        kind,
        scope_role: None,
        components: vec![identity.to_owned()],
    };
    let scene_scopes = |targets: &mut BTreeSet<TypedTarget>| {
        for role in [ScopeRole::QuerySceneScope, ScopeRole::QuerySceneIncarnation] {
            targets.insert(scope_target(role, &[query_scene_id]));
        }
    };
    // The targets of a Revision's authority. An accepted Revision input and a
    // Graph-derived input of that Revision share them: the Graph adds the
    // Index target only.
    let revision_targets = |targets: &mut BTreeSet<TypedTarget>, revision_id: &str| -> Result<()> {
        let binding = bindings
            .iter()
            .copied()
            .find(|binding| binding.revision_id() == revision_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING"))?;
        targets.insert(plain(QualificationKind::Revision, revision_id));
        targets.insert(plain(QualificationKind::Decision, binding.decision().id()));
        targets.insert(plain(QualificationKind::Freshness, revision_id));
        let basis = &binding.revision().material_basis;
        for key in basis
            .source_basis
            .iter()
            .map(|source| &source.source_key)
            .chain(
                basis
                    .evidence_set
                    .iter()
                    .map(|evidence| &evidence.source_key),
            )
        {
            targets.insert(plain(QualificationKind::Source, key));
        }
        let scope = binding.scope();
        let scene = scope.query_scene_id();
        targets.insert(scope_target(ScopeRole::ProjectAuthority, &[project_id]));
        for role in [
            ScopeRole::QuerySceneScope,
            ScopeRole::QuerySceneSource,
            ScopeRole::QuerySceneIncarnation,
            ScopeRole::RevealState,
            ScopeRole::ScopeAxis,
        ] {
            targets.insert(scope_target(role, &[scene]));
        }
        for index in 0..scope.typed_scope_bindings().len() {
            targets.insert(scope_target(
                ScopeRole::TypedScope,
                &[revision_id, &index.to_string()],
            ));
        }
        for proof in scope.material_scene_proofs() {
            targets.insert(scope_target(
                ScopeRole::MaterialSceneProof,
                &[&proof.scene_id, &proof.scene_incarnation_id],
            ));
        }
        Ok(())
    };
    let mut expected = BTreeMap::new();
    for (ordinal, input) in input_references.iter().enumerate() {
        let mut targets = BTreeSet::new();
        match &input.target {
            InputTarget::Message { version_id, .. } => {
                targets.insert(plain(QualificationKind::Source, version_id));
                scene_scopes(&mut targets);
            }
            InputTarget::RawSource { source_key, .. } => {
                targets.insert(plain(QualificationKind::Source, source_key));
                scene_scopes(&mut targets);
            }
            InputTarget::AcceptedRevision { revision_id, .. } => {
                revision_targets(&mut targets, revision_id)?;
            }
            InputTarget::GraphEvidence { .. } => {
                // The Revision and the Index come from the adopted Graph
                // input of this ordinal, never from the stored rows. The
                // history requalifier passes no Graph binding: a
                // Graph-derived input is Pending there and never reaches
                // this function.
                let adopted = graph
                    .and_then(|graph| {
                        graph
                            .inputs
                            .iter()
                            .find(|adopted| adopted.input_ordinal == ordinal)
                    })
                    .ok_or_else(|| {
                        anyhow::anyhow!("NIR1_NATIVE_PREPARED_UNSUPPORTED_SELECTED_MATERIAL")
                    })?;
                revision_targets(&mut targets, &adopted.revision_id)?;
                targets.insert(plain(QualificationKind::Index, &adopted.index_identity));
            }
            InputTarget::Artifact { .. } => {
                anyhow::bail!("NIR1_NATIVE_PREPARED_UNSUPPORTED_SELECTED_MATERIAL")
            }
        }
        if input.input_use != InputUse::CurrentTurn {
            targets.insert(plain(QualificationKind::D1, D1_SELECTION_IDENTITY));
        }
        expected.insert(ordinal, targets);
    }
    Ok(expected)
}

/// Read the exact Human version, current Scene Source, accepted typed
/// revisions, and their adopted references in one participant-owned WAL
/// snapshot. The Native-owned callback computes remaining context capacity
/// from the re-read Human body and the current fixed route/prompt budget.
///
/// The Revisions are the caller's list, and one that A2 or A3 reports
/// unavailable fails the whole request (the DP-H rejection variant). The
/// Native selection is [`read_and_pack_native_nir1_selected_inputs`].
///
/// `history` (DI1B-3) asks for the turn's history in the same snapshot, the
/// way the Native selection does: the function is shared, so a caller's list
/// of Revisions gets the same history as the Native selection. `None` asks for
/// none.
#[cfg(feature = "native-current-human-capture")]
#[allow(clippy::too_many_arguments)] // One explicit value per input of the D-final snapshot.
pub fn read_and_pack_native_nir1_prepared_inputs(
    workspace: &ActiveWorkspaceSnapshot,
    purpose: PackingPurpose,
    send_classification: HistorySendClassification,
    history: Option<NativeNir1HistoryRequest>,
    expected_session_id: &str,
    capture: &AcceptedChatInputCapture,
    query_scene_id: &str,
    revision_ids: &[String],
    sql_budget: ParticipantSqlOperationBudget,
    context_budget_for_user: impl FnOnce(&str) -> Result<usize>,
) -> Result<NativeNir1PreparedInputs> {
    require_non_empty(expected_session_id, "sessionId")?;
    require_non_empty(query_scene_id, "querySceneId")?;
    ensure!(
        capture.chat_session_id() == expected_session_id,
        "NIR1_CHAT_CAPTURE_SESSION_MISMATCH"
    );
    ensure!(
        capture.scene_id() == query_scene_id,
        "NIR1_CHAT_CAPTURE_SCOPE_MISMATCH"
    );
    ensure!(
        revision_ids.len() > 0 && revision_ids.len() <= MAX_PACKING_ITEMS,
        "NIR1_NATIVE_PREPARED_REVISION_COUNT_INVALID"
    );
    let mut revision_id_bytes = 0usize;
    let mut seen_revision_ids = HashSet::with_capacity(revision_ids.len());
    let mut unique_revision_ids = Vec::with_capacity(revision_ids.len());
    for revision_id in revision_ids {
        require_non_empty(revision_id, "revisionId")?;
        ensure!(
            revision_id.trim() == revision_id,
            "NIR1_NATIVE_PREPARED_REVISION_ID_INVALID"
        );
        // Match the common pooled reader: retain each exact Revision once, in first-seen order.
        if seen_revision_ids.insert(revision_id.as_str()) {
            unique_revision_ids.push(revision_id.clone());
        }
        revision_id_bytes = revision_id_bytes
            .checked_add(revision_id.len())
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BYTES_OVERFLOW"))?;
    }
    ensure!(
        revision_id_bytes <= MAX_PACKING_INPUT_BYTES,
        "NIR1_NATIVE_PREPARED_REVISION_BYTES_LIMIT"
    );

    read_prepared_inputs_in_snapshot(
        workspace,
        purpose,
        send_classification,
        capture,
        query_scene_id,
        RevisionSelection::Caller(&unique_revision_ids),
        None,
        history,
        sql_budget,
        context_budget_for_user,
    )
    .map(|(prepared, _)| prepared)
}

/// The D-final inputs of a Native-selected request, with the values a later
/// create and claim compare, all read in the one snapshot (DI-1c R-1, R-5).
///
/// `scene_binding` is the exact target Scene incarnation (the value the
/// attempt binding carries). `expected_scope` is the target Scene's Scope
/// binding token and the project's restore epoch as the rows hold them: it is
/// read whether or not the history slot could be built, so an attempt that
/// stores no context is checked the same way. Neither is a send authority.
#[cfg(feature = "native-current-human-capture")]
pub struct NativeNir1SelectedInputs {
    prepared: NativeNir1PreparedInputs,
    scene_binding: AttemptSceneBinding,
    expected_scope: Nir1ExpectedScope,
}

#[cfg(feature = "native-current-human-capture")]
impl NativeNir1SelectedInputs {
    pub fn prepared(&self) -> &NativeNir1PreparedInputs {
        &self.prepared
    }

    pub fn scene_binding(&self) -> &AttemptSceneBinding {
        &self.scene_binding
    }

    pub fn expected_scope(&self) -> &Nir1ExpectedScope {
        &self.expected_scope
    }

    pub fn into_parts(
        self,
    ) -> (
        NativeNir1PreparedInputs,
        AttemptSceneBinding,
        Nir1ExpectedScope,
    ) {
        (self.prepared, self.scene_binding, self.expected_scope)
    }
}

/// The Native selection of D-final (DI-1c R-1; DSN section 5.1: the trusted
/// Native chooses the Revisions). Inside the one participant read snapshot it
/// lists the project's current human-approved typed Revisions (at most
/// `MAX_PACKING_ITEMS`, read as N and N+1, in Revision ID order), evaluates
/// each with A2 and A3, and leaves out one that is unavailable with a closed
/// reason (`excluded_revisions`) while the others continue. The request fails
/// as a whole for a SQL error, a cancel or a budget stop, an unknown or
/// query-level reason, more than `MAX_PACKING_ITEMS` candidates, or when no
/// accepted IR remains (`NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING`). The
/// caller supplies no Revision ID.
///
/// `graph` is the text-free candidate set of a worker's Graph (DI-1a). The
/// snapshot requalifies it (B's seal, A2 and A3, the binding tokens) and the
/// groups that pass become Graph-derived inputs of the request; `None` is a
/// request without a Graph.
#[cfg(feature = "native-current-human-capture")]
#[allow(clippy::too_many_arguments)] // One explicit value per input of the D-final snapshot.
pub fn read_and_pack_native_nir1_selected_inputs(
    workspace: &ActiveWorkspaceSnapshot,
    purpose: PackingPurpose,
    send_classification: HistorySendClassification,
    history: Option<NativeNir1HistoryRequest>,
    expected_session_id: &str,
    capture: &AcceptedChatInputCapture,
    query_scene_id: &str,
    graph: Option<&Nir1GraphCandidates>,
    sql_budget: ParticipantSqlOperationBudget,
    context_budget_for_user: impl FnOnce(&str) -> Result<usize>,
) -> Result<NativeNir1SelectedInputs> {
    require_non_empty(expected_session_id, "sessionId")?;
    require_non_empty(query_scene_id, "querySceneId")?;
    ensure!(
        capture.chat_session_id() == expected_session_id,
        "NIR1_CHAT_CAPTURE_SESSION_MISMATCH"
    );
    ensure!(
        capture.scene_id() == query_scene_id,
        "NIR1_CHAT_CAPTURE_SCOPE_MISMATCH"
    );
    let (prepared, expectations) = read_prepared_inputs_in_snapshot(
        workspace,
        purpose,
        send_classification,
        capture,
        query_scene_id,
        RevisionSelection::Native,
        graph,
        history,
        sql_budget,
        context_budget_for_user,
    )?;
    let (scene_binding, expected_scope) =
        expectations.ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_EXPECTATIONS_MISSING"))?;
    Ok(NativeNir1SelectedInputs {
        prepared,
        scene_binding,
        expected_scope,
    })
}

/// Where the Revisions of one D-final read come from.
#[cfg(feature = "native-current-human-capture")]
enum RevisionSelection<'a> {
    /// The caller's validated, de-duplicated list. A2/A3 `Unavailable` rejects.
    Caller(&'a [String]),
    /// Listed inside the snapshot. A2/A3 `Unavailable` excludes the candidate.
    Native,
}

/// The values the Native selection reads beside the inputs, in the same
/// snapshot.
#[cfg(feature = "native-current-human-capture")]
type SnapshotExpectations = (AttemptSceneBinding, Nir1ExpectedScope);

/// The current human-approved typed Revisions of the project that the Native
/// selection takes as candidates, in Revision ID order. The set is the one
/// the capacity diagnostics count (`current_revision_id` of the typed
/// Entity/Relation review surface) narrowed to the proposals the A2 reader
/// accepts as approved (`proposal.status = 'approved'`); a Revision that is
/// not approved is not a candidate and is not counted as excluded. The read is
/// bounded as N and N+1: more than `MAX_PACKING_ITEMS` candidates is refused,
/// never silently cut.
#[cfg(feature = "native-current-human-capture")]
fn list_native_revision_candidates_in_tx(
    conn: &Connection,
    project_id: &str,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<String>> {
    use super::nir1_entity_relation::{
        NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
    };

    ensure!(
        !conn.is_autocommit(),
        "NIR1_NATIVE_PACKING_REQUIRES_READ_TRANSACTION"
    );
    let limit = i64::try_from(MAX_PACKING_ITEMS + 1)?;
    let mut statement = conn.prepare(
        "SELECT DISTINCT proposal.current_revision_id
           FROM narrative_proposal_sets proposal_set
           JOIN narrative_extraction_runs extraction_run
             ON extraction_run.id = proposal_set.run_id
            AND extraction_run.project_id = proposal_set.project_id
           JOIN narrative_proposals proposal ON proposal.proposal_set_id = proposal_set.id
          WHERE proposal_set.project_id = ?1
            AND proposal_set.set_kind = ?2
            AND extraction_run.surface_path_id = ?3
            AND proposal.current_revision_id IS NOT NULL
            AND proposal.status = 'approved'
          ORDER BY proposal.current_revision_id ASC
          LIMIT ?4",
    )?;
    let mut rows = statement.query(rusqlite::params![
        project_id,
        NIR1_ENTITY_RELATION_SET_KIND,
        NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
        limit,
    ])?;
    let mut ids = Vec::new();
    let mut id_bytes = 0usize;
    while let Some(row) = rows.next()? {
        checkpoint()?;
        let id: String = row.get(0)?;
        ensure!(
            !id.is_empty() && id.trim() == id,
            "NIR1_NATIVE_PREPARED_REVISION_ID_INVALID"
        );
        id_bytes = id_bytes
            .checked_add(id.len())
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BYTES_OVERFLOW"))?;
        ensure!(
            id_bytes <= MAX_PACKING_INPUT_BYTES,
            "NIR1_NATIVE_PREPARED_REVISION_BYTES_LIMIT"
        );
        ids.push(id);
        // The N+1st row is the proof that the set exceeds the limit.
        ensure!(
            ids.len() <= MAX_PACKING_ITEMS,
            "NIR1_NATIVE_PREPARED_REVISION_CANDIDATES_LIMIT {MAX_PACKING_ITEMS}"
        );
    }
    checkpoint()?;
    Ok(ids)
}

#[cfg(feature = "native-current-human-capture")]
#[allow(clippy::too_many_arguments)] // One explicit value per input of the D-final snapshot.
fn read_prepared_inputs_in_snapshot(
    workspace: &ActiveWorkspaceSnapshot,
    purpose: PackingPurpose,
    send_classification: HistorySendClassification,
    capture: &AcceptedChatInputCapture,
    query_scene_id: &str,
    selection: RevisionSelection<'_>,
    graph: Option<&Nir1GraphCandidates>,
    history: Option<NativeNir1HistoryRequest>,
    sql_budget: ParticipantSqlOperationBudget,
    context_budget_for_user: impl FnOnce(&str) -> Result<usize>,
) -> Result<(NativeNir1PreparedInputs, Option<SnapshotExpectations>)> {
    let mut input_budget = NativePackingInputBudget::default();
    let checkpoint_budget = sql_budget.clone();
    workspace.db().with_participant_read_transaction_bounded(
        workspace.participant(),
        sql_budget,
        |conn| {
            let mut checkpoint = || checkpoint_budget.check(workspace.participant());
            checkpoint()?;
            let (user_message_version, user_message) = read_current_chat_input_capture_in_tx(
                conn,
                capture,
                capture.owner(),
                |version_id_bytes, body_bytes| {
                    input_budget.reserve_lengths(version_id_bytes, body_bytes, 0)
                },
            )?;
            checkpoint()?;
            let project_id = user_message_version.project_id.clone();
            let context_budget_tokens = context_budget_for_user(&user_message)?;
            checkpoint()?;
            ensure!(
                context_budget_tokens > 0,
                "NIR1_NATIVE_PREPARED_CONTEXT_BUDGET_EMPTY"
            );
            let mut reserve_retained_binding = |bytes| {
                ensure!(
                    bytes <= MAX_PACKING_INPUT_BYTES,
                    "NIR1_NATIVE_PREPARED_RETAINED_BINDING_LIMIT"
                );
                Ok(())
            };
            let listed;
            let (revision_ids, policy) = match &selection {
                RevisionSelection::Caller(ids) => (*ids, RevisionUnavailablePolicy::Reject),
                RevisionSelection::Native => {
                    listed =
                        list_native_revision_candidates_in_tx(conn, &project_id, &mut checkpoint)?;
                    (listed.as_slice(), RevisionUnavailablePolicy::Exclude)
                }
            };
            let pooled = read_and_pack_native_a2_context_with_current_source_and_policy_in_tx(
                conn,
                NativeNir1SourcePooledPackingRequest {
                    project_id: &project_id,
                    revision_ids,
                    query_scene_id,
                    budget_tokens: context_budget_tokens,
                    purpose,
                    graph,
                },
                policy,
                &mut input_budget,
                &mut reserve_retained_binding,
                &mut checkpoint,
            )?;
            checkpoint()?;
            // The history context is read in this same snapshot; the route's
            // send classification is decided by the caller and only passed on.
            let history_context = build_history_context_stage(
                conn,
                &project_id,
                query_scene_id,
                workspace.durable_workspace_identity(),
                send_classification,
            )?;
            checkpoint()?;
            // The Native selection also reads, in this snapshot, what a create
            // and a claim compare. The Scope token and the restore epoch are
            // read even when the history slot is unavailable. A request for
            // history needs the same Scene binding (its incarnation names the
            // range of the history), so it is read once for both.
            let scene_binding =
                if history.is_some() || matches!(selection, RevisionSelection::Native) {
                    let scene_binding =
                        read_attempt_scene_binding_in_tx(conn, &project_id, query_scene_id)?;
                    checkpoint()?;
                    Some(scene_binding)
                } else {
                    None
                };
            let expectations = match (&selection, &scene_binding) {
                (RevisionSelection::Native, Some(scene_binding)) => {
                    let expected_scope =
                        read_expected_scope_in_tx(conn, &project_id, query_scene_id)?;
                    checkpoint()?;
                    Some((scene_binding.clone(), expected_scope))
                }
                _ => None,
            };
            let mut prepared = build_native_nir1_prepared_inputs(
                capture.clone(),
                project_id,
                query_scene_id.to_owned(),
                user_message_version,
                user_message,
                pooled,
                history_context,
                &mut checkpoint,
            )?;
            // The history comes last: it takes what the selector's budget
            // leaves after the Raw and the accepted IR, so the Raw and the IR
            // are the same with and without it (DI1B-3).
            if let (Some(request), Some(scene_binding)) = (history, &scene_binding) {
                attach_history_in_snapshot(
                    conn,
                    &mut prepared,
                    scene_binding,
                    purpose,
                    send_classification,
                    request,
                    context_budget_tokens,
                    &checkpoint_budget,
                    &mut checkpoint,
                )?;
            }
            Ok((prepared, expectations))
        },
    )
}

/// The generation purpose of a packing purpose: the history of a turn is the
/// history of the same purpose (a Review turn adopts Review history only).
#[cfg(feature = "native-current-human-capture")]
fn generation_purpose_of(purpose: PackingPurpose) -> GenerationPurpose {
    match purpose {
        PackingPurpose::Writing => GenerationPurpose::Writing,
        PackingPurpose::Review => GenerationPurpose::Review,
    }
}

/// Run the history re-authorization in the D-final snapshot and append the
/// adopted turns to the prepared inputs (DI1B-3; K4/3 sections 3, 6 and 8).
///
/// * The range is the capture's session and the Scene incarnation this
///   snapshot read (`TurnHistoryRange::from_snapshot`); nothing of it comes
///   from the caller.
/// * The history takes the tokens the selector's budget leaves after the Raw
///   and the accepted IR (`context_budget_tokens` less the tokens of the
///   adopted context items), each message with its envelope. The selector's
///   own result is not touched, so a request with no adopted history is the
///   request it was before history.
/// * The input rows come after the Human, the Raw and the Revisions, oldest
///   turn first, so no earlier ordinal moves. Each message gets the rows of
///   K4/3 section 3: its message version and body digest as Source, the
///   target Scene's Scope token and incarnation, and typed N/A for the
///   Revision, Decision, Freshness and Index kinds; D1 is added by
///   `finalize_qualifications`.
/// * A spent SQL ledger or deadline of the history is "no history for this
///   turn" (the run's outcome); a cancel and every other error stop the turn.
#[cfg(feature = "native-current-human-capture")]
#[allow(clippy::too_many_arguments)] // One explicit value per input of the D-final snapshot.
fn attach_history_in_snapshot(
    conn: &Connection,
    prepared: &mut NativeNir1PreparedInputs,
    scene_binding: &AttemptSceneBinding,
    purpose: PackingPurpose,
    send_classification: HistorySendClassification,
    request: NativeNir1HistoryRequest,
    context_budget_tokens: usize,
    prepare: &ParticipantSqlOperationBudget,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    let range = TurnHistoryRange::from_snapshot(&prepared.capture, scene_binding)?;
    let generation_purpose = generation_purpose_of(purpose);
    let outcome = reauthorize_turn_history_in_tx(
        conn,
        &prepared.history_context,
        &range,
        generation_purpose.clone(),
        request.now_ms,
        Instant::now(),
        prepare,
        &mut *checkpoint,
    )?;
    checkpoint()?;
    let mut context_tokens = 0usize;
    for item in &prepared.context_items {
        context_tokens = context_tokens
            .checked_add(estimate_nir1_context_tokens(&item.text))
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_D1_USAGE_OVERFLOW"))?;
    }
    let remaining_tokens = context_budget_tokens.saturating_sub(context_tokens);
    let adoption = adopt_history_turns(
        &HistoryAdoptionRequest {
            outcome: &outcome,
            current_human_body: &prepared.user_message,
            current_scene_body_digest: &scene_binding.body_digest,
            limits: AdoptionLimits::production(remaining_tokens, request.message_envelope_tokens),
        },
        &mut |attempt_id| {
            checkpoint()?;
            parent_read_cost_in_tx(conn, attempt_id)
        },
    )?;
    checkpoint()?;

    let scope = prepared
        .authority_bindings
        .first()
        .map(NativeNir1AuthorityBinding::scope)
        .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"))?
        .clone();
    let mut messages = Vec::with_capacity(adoption.message_count());
    for message in adoption.messages() {
        checkpoint()?;
        let InputTarget::Message { version_id, .. } = &message.input.target else {
            anyhow::bail!("NIR1_NATIVE_PREPARED_HISTORY_INPUT_INVALID");
        };
        let decision = match message.input.role {
            InputRole::User => NotApplicableReason::HumanAuthored,
            InputRole::Assistant => NotApplicableReason::DerivedFromParents,
            _ => anyhow::bail!("NIR1_NATIVE_PREPARED_HISTORY_INPUT_INVALID"),
        };
        let ordinal = prepared.input_references.len();
        prepared.input_references.push(message.input.clone());
        prepared
            .qualifications
            .push(QualificationReference::present(
                ordinal,
                QualificationKind::Source,
                version_id.clone(),
                message.body_digest.clone(),
            ));
        add_scene_scope_references(
            &mut prepared.qualifications,
            ordinal,
            &prepared.query_scene_id,
            &scope,
        )?;
        for (kind, reason) in [
            (
                QualificationKind::Revision,
                NotApplicableReason::NotARevision,
            ),
            (QualificationKind::Decision, decision),
            (
                QualificationKind::Freshness,
                NotApplicableReason::ImmutableMessageVersion,
            ),
            (
                QualificationKind::Index,
                NotApplicableReason::NotIndexDerived,
            ),
        ] {
            prepared
                .qualifications
                .push(QualificationReference::not_applicable(
                    ordinal, kind, reason,
                ));
        }
        messages.push(NativeNir1PreparedHistoryMessage {
            input_ordinal: ordinal,
            role: message.input.role.clone(),
            text: message.body.clone(),
            tokens: message.tokens,
        });
    }
    let observation = NativeNir1HistoryObservation {
        adopted_turns: adoption.turns.len(),
        adopted_messages: messages.len(),
        tokens: adoption.tokens(),
        changed_body_replies: adoption.changed_body_replies(),
        without_history: outcome.without_history.map(|reason| reason.code()),
        not_adopted: adoption
            .not_adopted
            .iter()
            .map(|entry| entry.reason.code())
            .collect(),
    };
    prepared.history = Some(PreparedHistory {
        purpose: generation_purpose,
        send_classification,
        turns: adoption.turns,
        messages,
        observation,
    });
    checkpoint()
}

/// Confirm the adopted history again in a new snapshot (DI1B-3; K4/3
/// section 8, "a lapse between the preparation and the claim stops the whole
/// turn"). The same run is made with a new budget; every adopted turn must
/// still be qualified, with the message versions and the body digests that
/// were adopted. Anything else, including a run that ended without a result
/// because its budget was spent, is `NIR1_NATIVE_PREPARED_HISTORY_STALE`: a
/// part of the history is never sent on the strength of a part of the
/// confirmation. (At preparation a spent budget is "no history, the turn
/// goes on", because nothing was adopted yet; here the history was adopted and
/// is about to be sent, so what cannot be confirmed must not be sent.)
#[cfg(feature = "native-current-human-capture")]
fn confirm_history_in_snapshot(
    conn: &Connection,
    expected: &NativeNir1PreparedInputs,
    history: &PreparedHistory,
    workspace: &ActiveWorkspaceSnapshot,
    now_ms: i64,
    prepare: &ParticipantSqlOperationBudget,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    let stage = build_history_context_stage(
        conn,
        &expected.project_id,
        &expected.query_scene_id,
        workspace.durable_workspace_identity(),
        history.send_classification,
    )?;
    checkpoint()?;
    let scene_binding =
        read_attempt_scene_binding_in_tx(conn, &expected.project_id, &expected.query_scene_id)?;
    checkpoint()?;
    let range = TurnHistoryRange::from_snapshot(&expected.capture, &scene_binding)?;
    let outcome = reauthorize_turn_history_in_tx(
        conn,
        &stage,
        &range,
        history.purpose.clone(),
        now_ms,
        Instant::now(),
        prepare,
        &mut *checkpoint,
    )?;
    checkpoint()?;
    for turn in &history.turns {
        ensure!(
            history_message_still_qualified(
                &outcome,
                &turn.attempt_id,
                SessionCandidateKind::PastHuman,
                &turn.human,
            ),
            "NIR1_NATIVE_PREPARED_HISTORY_STALE"
        );
        if let Some(output) = &turn.output {
            ensure!(
                history_message_still_qualified(
                    &outcome,
                    &turn.attempt_id,
                    SessionCandidateKind::GeneratedOutput,
                    output,
                ),
                "NIR1_NATIVE_PREPARED_HISTORY_STALE"
            );
        }
        checkpoint()?;
    }
    Ok(())
}

/// The new run qualified the candidate of `attempt_id` and `kind`, and the
/// message it read is the adopted one: the same version, the same digest and
/// the same body.
#[cfg(feature = "native-current-human-capture")]
fn history_message_still_qualified(
    outcome: &SessionHistoryOutcome,
    attempt_id: &str,
    kind: SessionCandidateKind,
    adopted: &super::nir1_history_adoption::AdoptedMessage,
) -> bool {
    let InputTarget::Message { version_id, .. } = &adopted.input.target else {
        return false;
    };
    let qualified = outcome.candidates.iter().any(|result| {
        result.kind == kind
            && result.attempt_id == attempt_id
            && result.disposition == CandidateDisposition::Qualified
            && result.version_id.as_deref() == Some(version_id.as_str())
    });
    if !qualified {
        return false;
    }
    let Some(material) = outcome.materials.get(attempt_id) else {
        return false;
    };
    let message = match kind {
        SessionCandidateKind::PastHuman => material.human.as_ref(),
        SessionCandidateKind::GeneratedOutput => material.output.as_ref(),
        SessionCandidateKind::Attempt => None,
    };
    message.is_some_and(|message| {
        message.version_id == *version_id
            && message.body_digest == adopted.body_digest
            && message.body == adopted.body
    })
}

#[cfg(feature = "native-current-human-capture")]
#[allow(clippy::too_many_arguments)] // The pooled read, the Human and the history stage are separate values.
fn build_native_nir1_prepared_inputs(
    capture: AcceptedChatInputCapture,
    project_id: String,
    query_scene_id: String,
    user_message_version: MessageVersion,
    user_message: String,
    mut pooled: NativeNir1PooledPackedContext,
    history_context: HistoryContextStage,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1PreparedInputs> {
    let raw_source_binding = pooled
        .raw_source_binding
        .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_RAW_SOURCE_BINDING_MISSING"))?;
    let mut raw_ordinal = None;
    let mut revision_ordinals = HashMap::new();
    // Graph group ID -> the ordinal of its Graph-derived input.
    let mut graph_ordinals = HashMap::<String, usize>::new();
    // The Revisions this request keeps, whichever input first named them.
    let mut kept_revision_ids = Vec::<String>::new();
    let mut kept_revision_set = HashSet::<String>::new();
    // Every context input that carries a Revision's authority, in ordinal
    // order: an accepted Revision input, or a Graph-derived input of one
    // relation of a Revision.
    let mut revision_inputs = Vec::<(usize, String, Option<(String, String)>)>::new();
    let mut context_references = Vec::new();
    let mut accepted_ir_count = 0usize;
    let graph_outcome = pooled.graph.take();
    // Candidates A2 or A3 left out in the pooled read come first, in candidate
    // order; the sealed-basis conflicts found below follow.
    let mut excluded_revisions = std::mem::take(&mut pooled.excluded);
    let mut excluded_revision_ids = HashSet::<String>::new();

    // A Revision whose sealed material basis disagrees with itself is left out
    // alone, as an accepted Revision and as a Graph-derived input; the Human,
    // the Raw, the other Revisions and the attempt context stay (K4/3 section
    // 3, rule 2). The check is made once, at the first selected item that
    // names the Revision.
    let mut keep_revision =
        |revision_id: &str, bindings: &[NativeNir1AuthorityBinding]| -> Result<bool> {
            if excluded_revision_ids.contains(revision_id) {
                return Ok(false);
            }
            if kept_revision_set.contains(revision_id) {
                return Ok(true);
            }
            let binding = bindings
                .iter()
                .find(|binding| binding.revision_id() == revision_id)
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING"))?;
            if let Some(reason) = revision_exclusion_reason(binding) {
                excluded_revision_ids.insert(revision_id.to_owned());
                excluded_revisions.push(NativeNir1ExcludedRevision {
                    revision_id: revision_id.to_owned(),
                    reason,
                });
                return Ok(false);
            }
            kept_revision_set.insert(revision_id.to_owned());
            kept_revision_ids.push(revision_id.to_owned());
            Ok(true)
        };

    for selected in &pooled.selected_items {
        checkpoint()?;
        match selected.item() {
            ContextItemKind::Raw { id, .. } => {
                ensure!(
                    raw_ordinal.is_none() && id == &raw_source_binding.binding.source_key,
                    "NIR1_NATIVE_PREPARED_RAW_SELECTION_MISMATCH"
                );
                raw_ordinal = Some(context_references.len() + 1);
                context_references.push(InputReference {
                    role: InputRole::Context,
                    target: InputTarget::RawSource {
                        source_key: raw_source_binding.binding.source_key.clone(),
                        revision_token: raw_source_binding.binding.revision_token.clone(),
                    },
                    input_use: InputUse::SelectedMaterial,
                });
            }
            ContextItemKind::AcceptedIr { .. } => {
                ensure!(
                    selected.atomic_part().is_some() && selected.candidate_binding().is_some(),
                    "NIR1_NATIVE_PREPARED_ACCEPTED_IR_BINDING_MISSING"
                );
                let revision_id = selected.owner_revision_id.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_OWNER_MISSING")
                })?;
                if !keep_revision(revision_id, &pooled.bindings)? {
                    continue;
                }
                if !revision_ordinals.contains_key(revision_id) {
                    let binding = pooled
                        .bindings
                        .iter()
                        .find(|binding| binding.revision_id() == revision_id)
                        .ok_or_else(|| {
                            anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING")
                        })?;
                    let ordinal = context_references.len() + 1;
                    revision_ordinals.insert(revision_id.to_owned(), ordinal);
                    revision_inputs.push((ordinal, revision_id.to_owned(), None));
                    context_references.push(InputReference {
                        role: InputRole::Context,
                        target: InputTarget::AcceptedRevision {
                            revision_id: revision_id.to_owned(),
                            bundle_digest: binding.bundle_digest().to_owned(),
                        },
                        input_use: InputUse::SelectedMaterial,
                    });
                }
                accepted_ir_count += 1;
            }
            ContextItemKind::GraphEvidence { atomic_group, .. } => {
                ensure!(
                    selected.atomic_part().is_some() && selected.candidate_binding().is_some(),
                    "NIR1_NATIVE_PREPARED_GRAPH_BINDING_MISSING"
                );
                // The group is one the Graph requalification made in this
                // snapshot; the selector cannot have invented it.
                let group = graph_outcome
                    .as_ref()
                    .and_then(|outcome| {
                        outcome
                            .groups()
                            .iter()
                            .find(|group| group.group_id() == atomic_group)
                    })
                    .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_GRAPH_GROUP_MISSING"))?;
                ensure!(
                    selected.owner_revision_id.as_deref() == Some(group.revision_id()),
                    "NIR1_NATIVE_PREPARED_GRAPH_OWNER_MISMATCH"
                );
                if !keep_revision(group.revision_id(), &pooled.bindings)? {
                    continue;
                }
                if !graph_ordinals.contains_key(atomic_group) {
                    let binding = pooled
                        .bindings
                        .iter()
                        .find(|binding| binding.revision_id() == group.revision_id())
                        .ok_or_else(|| {
                            anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING")
                        })?;
                    let (source_key, revision_token) =
                        graph_input_source(binding, group.edge_id())?;
                    let ordinal = context_references.len() + 1;
                    graph_ordinals.insert(atomic_group.clone(), ordinal);
                    revision_inputs.push((
                        ordinal,
                        group.revision_id().to_owned(),
                        Some((group.edge_id().to_owned(), group.group_id().to_owned())),
                    ));
                    context_references.push(InputReference {
                        role: InputRole::Context,
                        target: InputTarget::GraphEvidence {
                            evidence_ref: graph_evidence_ref(group.revision_id(), group.edge_id())?,
                            source_key,
                            revision_token,
                        },
                        input_use: InputUse::SelectedMaterial,
                    });
                }
            }
            _ => anyhow::bail!("NIR1_NATIVE_PREPARED_UNSUPPORTED_SELECTED_MATERIAL"),
        }
    }
    ensure!(
        raw_ordinal.is_some() && accepted_ir_count > 0,
        "NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"
    );

    let mut input_references = Vec::with_capacity(context_references.len() + 1);
    input_references.push(InputReference {
        role: InputRole::User,
        target: InputTarget::Message {
            version_id: user_message_version.id.clone(),
            parent_attempt_id: None,
        },
        input_use: InputUse::CurrentTurn,
    });
    input_references.extend(context_references);

    let mut context_items = Vec::with_capacity(pooled.selected_items.len());
    for selected in pooled.selected_items {
        checkpoint()?;
        let input_ordinal = match selected.item() {
            ContextItemKind::Raw { .. } => raw_ordinal.expect("validated above"),
            ContextItemKind::AcceptedIr { .. } => {
                let owner = selected.owner_revision_id.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_OWNER_MISSING")
                })?;
                if excluded_revision_ids.contains(owner) {
                    continue;
                }
                *revision_ordinals.get(owner).ok_or_else(|| {
                    anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_ORDINAL_MISSING")
                })?
            }
            ContextItemKind::GraphEvidence { atomic_group, .. } => {
                let owner = selected.owner_revision_id.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_OWNER_MISSING")
                })?;
                if excluded_revision_ids.contains(owner) {
                    continue;
                }
                *graph_ordinals.get(atomic_group).ok_or_else(|| {
                    anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_ORDINAL_MISSING")
                })?
            }
            _ => anyhow::bail!("NIR1_NATIVE_PREPARED_UNSUPPORTED_SELECTED_MATERIAL"),
        };
        context_items.push(NativeNir1PreparedContextItem {
            input_ordinal,
            text: take_selected_context_text(selected)?,
        });
    }

    let mut selected_bindings = Vec::with_capacity(kept_revision_ids.len());
    for revision_id in &kept_revision_ids {
        checkpoint()?;
        selected_bindings.push(
            pooled
                .bindings
                .iter()
                .find(|binding| binding.revision_id() == revision_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING"))?,
        );
    }
    // The Human and the Raw carry the target Scene's Scope binding. The
    // Revisions of one snapshot all read the same Scene, so their query-Scene
    // tokens must agree; any difference means the snapshot is inconsistent.
    let scene_scope = selected_bindings
        .first()
        .map(NativeNir1AuthorityBinding::scope)
        .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"))?;
    for binding in &selected_bindings {
        let other = binding.scope();
        ensure!(
            other.query_scene_id() == query_scene_id
                && other.query_scene_scope_token() == scene_scope.query_scene_scope_token()
                && other.query_scene_incarnation_id() == scene_scope.query_scene_incarnation_id(),
            "NIR1_NATIVE_PREPARED_SCENE_SCOPE_INCONSISTENT"
        );
    }
    let mut qualifications = Vec::new();
    // Current Human (ordinal 0): Source and Scope references, five typed N/A.
    qualifications.push(QualificationReference::present(
        0,
        QualificationKind::Source,
        user_message_version.id.clone(),
        user_message_version.body_digest.clone(),
    ));
    add_scene_scope_references(&mut qualifications, 0, &query_scene_id, scene_scope)?;
    for (kind, reason) in [
        (
            QualificationKind::Revision,
            NotApplicableReason::NotARevision,
        ),
        (
            QualificationKind::Decision,
            NotApplicableReason::HumanAuthored,
        ),
        (
            QualificationKind::Freshness,
            NotApplicableReason::ImmutableMessageVersion,
        ),
        (
            QualificationKind::Index,
            NotApplicableReason::NotIndexDerived,
        ),
        (QualificationKind::D1, NotApplicableReason::FixedUserSlot),
    ] {
        qualifications.push(QualificationReference::not_applicable(0, kind, reason));
    }
    // Target Scene body (Raw): Source and Scope references, four typed N/A
    // (D1 is added after the render).
    let raw_ordinal = raw_ordinal.expect("validated above");
    qualifications.push(QualificationReference::present(
        raw_ordinal,
        QualificationKind::Source,
        raw_source_binding.binding.source_key.clone(),
        raw_source_binding.binding.revision_token.clone(),
    ));
    add_scene_scope_references(
        &mut qualifications,
        raw_ordinal,
        &query_scene_id,
        scene_scope,
    )?;
    let raw_freshness_reason =
        if raw_source_binding.binding.source_key == format!("project:scene:{query_scene_id}") {
            NotApplicableReason::TargetSceneBodyNotADependency
        } else {
            NotApplicableReason::ExactSourceToken
        };
    for (kind, reason) in [
        (
            QualificationKind::Revision,
            NotApplicableReason::NotARevision,
        ),
        (
            QualificationKind::Decision,
            NotApplicableReason::ManuscriptSource,
        ),
        (QualificationKind::Freshness, raw_freshness_reason),
        (
            QualificationKind::Index,
            NotApplicableReason::NotIndexDerived,
        ),
    ] {
        qualifications.push(QualificationReference::not_applicable(
            raw_ordinal,
            kind,
            reason,
        ));
    }
    let mut graph_inputs = Vec::new();
    for (input_ordinal, revision_id, graph_edge) in &revision_inputs {
        checkpoint()?;
        let binding = selected_bindings
            .iter()
            .find(|binding| binding.revision_id() == revision_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING"))?;
        let index = match graph_edge {
            None => RevisionIndexQualification::NotIndexDerived,
            Some((edge_id, group_id)) => {
                let seal = graph_outcome
                    .as_ref()
                    .and_then(|outcome| outcome.seal())
                    .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_GRAPH_SEAL_MISSING"))?;
                let (identity, version) =
                    graph_index_reference(&project_id, seal, binding, edge_id)?;
                graph_inputs.push(NativeNir1GraphInput {
                    input_ordinal: *input_ordinal,
                    revision_id: revision_id.clone(),
                    edge_id: edge_id.clone(),
                    group_id: group_id.clone(),
                    index_identity: identity.clone(),
                    index_version: version.clone(),
                });
                RevisionIndexQualification::Present { identity, version }
            }
        };
        add_revision_qualifications(
            &mut qualifications,
            *input_ordinal,
            &project_id,
            revision_id,
            binding,
            index,
            checkpoint,
        )?;
    }
    let graph_binding = match (graph_inputs.is_empty(), graph_outcome.as_ref()) {
        (false, Some(outcome)) => Some(NativeNir1GraphBinding {
            seal: outcome
                .seal()
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_GRAPH_SEAL_MISSING"))?,
            inputs: graph_inputs,
        }),
        _ => None,
    };
    checkpoint()?;
    Ok(NativeNir1PreparedInputs {
        capture: capture.clone(),
        project_id,
        query_scene_id,
        user_message_version,
        user_message,
        input_references,
        qualifications,
        context_items,
        raw_source_binding,
        authority_bindings: selected_bindings,
        excluded_revisions,
        graph_outcome,
        graph_binding,
        history_context,
        history: None,
    })
}

/// How the Index kind of a Revision-authority input is qualified: an accepted
/// Revision is read through A2 and A3 without a Graph Index (a typed N/A); a
/// Graph-derived input carries the Index reference of its group and no N/A
/// (K4/3 section 3).
#[cfg(feature = "native-current-human-capture")]
pub(crate) enum RevisionIndexQualification {
    NotIndexDerived,
    Present { identity: String, version: String },
}

/// The Source a Graph-derived input records as its own `source_key` and
/// `revision_token`: the first, in `(source key, revision token)` order, of the
/// Sources of the relation's Evidence in the Revision's material basis. The
/// other Sources are Source references of the input (K4/3 section 3).
#[cfg(feature = "native-current-human-capture")]
fn graph_input_source(
    binding: &NativeNir1AuthorityBinding,
    edge_id: &str,
) -> Result<(String, String)> {
    let revision = binding.revision();
    let relation = revision
        .bundle
        .relations
        .iter()
        .find(|relation| relation.edge_id == edge_id)
        .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_GRAPH_RELATION_MISSING"))?;
    let mut sources = Vec::with_capacity(relation.evidence_ids.len());
    for evidence_id in &relation.evidence_ids {
        let evidence = revision
            .material_basis
            .evidence_set
            .iter()
            .find(|evidence| &evidence.evidence_ref == evidence_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_GRAPH_EVIDENCE_MISSING"))?;
        sources.push((
            evidence.source_key.as_str(),
            evidence.revision_token.as_str(),
        ));
    }
    sources.sort_unstable();
    let (source_key, revision_token) = sources
        .first()
        .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_GRAPH_EVIDENCE_MISSING"))?;
    Ok(((*source_key).to_owned(), (*revision_token).to_owned()))
}

/// The sealed material basis disagrees with itself when `source_basis` and
/// `evidence_set` hold one source key with two revision tokens. The same key
/// with the same token (the usual overlap) is one Source.
#[cfg(feature = "native-current-human-capture")]
fn revision_exclusion_reason(
    binding: &NativeNir1AuthorityBinding,
) -> Option<NativeNir1RevisionExclusionReason> {
    let basis = &binding.revision().material_basis;
    let mut tokens = HashMap::<&str, &str>::new();
    for (key, token) in basis
        .source_basis
        .iter()
        .map(|source| (&source.source_key, &source.revision_token))
        .chain(
            basis
                .evidence_set
                .iter()
                .map(|evidence| (&evidence.source_key, &evidence.revision_token)),
        )
    {
        if let Some(existing) = tokens.insert(key.as_str(), token.as_str()) {
            if existing != token.as_str() {
                return Some(NativeNir1RevisionExclusionReason::MaterialBasisSourceTokenConflict);
            }
        }
    }
    None
}

/// The query-Scene Scope references of a Human or Raw input: the Scene's
/// Scope binding token and its incarnation.
#[cfg(feature = "native-current-human-capture")]
fn add_scene_scope_references(
    qualifications: &mut Vec<QualificationReference>,
    input_ordinal: usize,
    query_scene_id: &str,
    scope: &NativeNir1ScopeBinding,
) -> Result<()> {
    qualifications.push(QualificationReference::scope(
        input_ordinal,
        ScopeRole::QuerySceneScope,
        scope_identity(ScopeRole::QuerySceneScope, &[query_scene_id])?,
        scope.query_scene_scope_token().to_owned(),
    ));
    qualifications.push(QualificationReference::scope(
        input_ordinal,
        ScopeRole::QuerySceneIncarnation,
        scope_identity(ScopeRole::QuerySceneIncarnation, &[query_scene_id])?,
        scope.query_scene_incarnation_id().to_owned(),
    ));
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
fn add_revision_qualifications(
    qualifications: &mut Vec<QualificationReference>,
    input_ordinal: usize,
    project_id: &str,
    revision_id: &str,
    binding: &NativeNir1AuthorityBinding,
    index: RevisionIndexQualification,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    // An exact repeat (same kind, role, identity and version) is one
    // reference. The same target with another version is kept, so the
    // completeness rule reports the duplicate instead of one version being
    // hidden. A Source conflict inside the material basis never reaches this
    // point: the Revision is excluded earlier.
    let mut seen = HashSet::<(QualificationKind, Option<ScopeRole>, String, String)>::new();
    let mut add = |kind: QualificationKind,
                   scope_role: Option<ScopeRole>,
                   identity: String,
                   version: String| {
        if seen.insert((kind, scope_role, identity.clone(), version.clone())) {
            qualifications.push(QualificationReference {
                input_ordinal,
                kind,
                body: QualificationBody::Present {
                    identity,
                    version,
                    scope_role,
                },
            });
        }
    };
    add(
        QualificationKind::Revision,
        None,
        revision_id.to_owned(),
        binding.bundle_digest().to_owned(),
    );
    add(
        QualificationKind::Decision,
        None,
        binding.decision().id().to_owned(),
        binding.decision_token().to_owned(),
    );
    add(
        QualificationKind::Freshness,
        None,
        revision_id.to_owned(),
        binding.freshness_token().to_owned(),
    );
    for source in &binding.revision().material_basis.source_basis {
        checkpoint()?;
        add(
            QualificationKind::Source,
            None,
            source.source_key.clone(),
            source.revision_token.clone(),
        );
    }
    for evidence in &binding.revision().material_basis.evidence_set {
        checkpoint()?;
        add(
            QualificationKind::Source,
            None,
            evidence.source_key.clone(),
            evidence.revision_token.clone(),
        );
    }
    let query_scene_id = binding.scope().query_scene_id();
    add(
        QualificationKind::Scope,
        Some(ScopeRole::ProjectAuthority),
        scope_identity(ScopeRole::ProjectAuthority, &[project_id])?,
        binding.scope().scope_authority_revision().to_owned(),
    );
    add(
        QualificationKind::Scope,
        Some(ScopeRole::QuerySceneScope),
        scope_identity(ScopeRole::QuerySceneScope, &[query_scene_id])?,
        binding.scope().query_scene_scope_token().to_owned(),
    );
    add(
        QualificationKind::Scope,
        Some(ScopeRole::QuerySceneSource),
        scope_identity(ScopeRole::QuerySceneSource, &[query_scene_id])?,
        binding.scope().query_scene_source_token().to_owned(),
    );
    add(
        QualificationKind::Scope,
        Some(ScopeRole::QuerySceneIncarnation),
        scope_identity(ScopeRole::QuerySceneIncarnation, &[query_scene_id])?,
        binding.scope().query_scene_incarnation_id().to_owned(),
    );
    add(
        QualificationKind::Scope,
        Some(ScopeRole::RevealState),
        scope_identity(ScopeRole::RevealState, &[query_scene_id])?,
        binding.scope().reveal_state_token().to_owned(),
    );
    add(
        QualificationKind::Scope,
        Some(ScopeRole::ScopeAxis),
        scope_identity(ScopeRole::ScopeAxis, &[query_scene_id])?,
        canonical_json_digest(&json!({
            "axis": binding.scope().effective_axis(),
            "fallbackReason": binding.scope().axis_fallback_reason(),
        }))?,
    );
    for (index, typed_scope) in binding.scope().typed_scope_bindings().iter().enumerate() {
        checkpoint()?;
        add(
            QualificationKind::Scope,
            Some(ScopeRole::TypedScope),
            scope_identity(ScopeRole::TypedScope, &[revision_id, &index.to_string()])?,
            canonical_json_digest(&serde_json::to_value(typed_scope)?)?,
        );
    }
    for proof in binding.scope().material_scene_proofs() {
        checkpoint()?;
        add(
            QualificationKind::Scope,
            Some(ScopeRole::MaterialSceneProof),
            scope_identity(
                ScopeRole::MaterialSceneProof,
                &[&proof.scene_id, &proof.scene_incarnation_id],
            )?,
            proof.scene_scope_token.clone(),
        );
    }
    // An accepted Revision is "not index-derived": no Graph Index is read for
    // it. A Graph-derived input has no N/A for the Index and records the
    // reference of its group (K4/3 section 3).
    qualifications.push(match index {
        RevisionIndexQualification::NotIndexDerived => QualificationReference::not_applicable(
            input_ordinal,
            QualificationKind::Index,
            NotApplicableReason::NotIndexDerived,
        ),
        RevisionIndexQualification::Present { identity, version } => {
            QualificationReference::present(
                input_ordinal,
                QualificationKind::Index,
                identity,
                version,
            )
        }
    });
    Ok(())
}

/// Re-read every adopted input in a new participant-owned read transaction.
/// The original preparation snapshot is never reused as a return-time proof.
///
/// The adopted history (DI1B-3) is confirmed again in the same transaction:
/// the run is made once more with a new budget, and a turn that no longer
/// qualifies, or a message whose body is not the adopted one, stops the turn
/// with `NIR1_NATIVE_PREPARED_HISTORY_STALE`. `now_ms` is the Native clock's
/// value now (the 30-day validity is decided against it); it is not used when
/// no history was adopted.
#[cfg(feature = "native-current-human-capture")]
pub fn revalidate_native_nir1_prepared_inputs(
    workspace: &ActiveWorkspaceSnapshot,
    expected_session_id: &str,
    expected: &NativeNir1PreparedInputs,
    sql_budget: ParticipantSqlOperationBudget,
    now_ms: i64,
) -> Result<()> {
    ensure!(
        expected.capture.chat_session_id() == expected_session_id,
        "NIR1_NATIVE_PREPARED_SESSION_MISMATCH"
    );
    let mut input_budget = NativePackingInputBudget::default();
    let checkpoint_budget = sql_budget.clone();
    workspace.db().with_participant_read_transaction_bounded(
        workspace.participant(),
        sql_budget,
        |conn| {
            let mut checkpoint = || checkpoint_budget.check(workspace.participant());
            checkpoint()?;
            let (current_version, current_message) = read_current_chat_input_capture_in_tx(
                conn,
                &expected.capture,
                expected.capture.owner(),
                |version_id_bytes, body_bytes| {
                    input_budget.reserve_lengths(version_id_bytes, body_bytes, 0)
                },
            )?;
            checkpoint()?;
            ensure!(
                current_version == expected.user_message_version
                    && current_message == expected.user_message,
                "NIR1_NATIVE_PREPARED_HUMAN_MESSAGE_STALE"
            );
            let source_ref = NativeNir1RawSourceRef {
                project_id: &expected.raw_source_binding.project_id,
                scene_id: &expected.raw_source_binding.scene_id,
                binding: &expected.raw_source_binding.binding,
            };
            let raw = read_nir1_source_raw_context_item(
                conn,
                source_ref,
                &mut input_budget,
                &mut checkpoint,
            )?;
            let raw_ordinal = expected
                .input_references
                .iter()
                .position(|reference| matches!(&reference.target, InputTarget::RawSource { .. }))
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_RAW_INPUT_MISSING"))?;
            let expected_raw = expected
                .context_items
                .iter()
                .find(|item| item.input_ordinal == raw_ordinal)
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_RAW_CONTEXT_MISSING"))?;
            ensure!(
                raw.text == expected_raw.text,
                "NIR1_NATIVE_PREPARED_RAW_SOURCE_BODY_STALE"
            );
            // A Graph-derived input is requalified against B's seal as this
            // snapshot reads it, then against the Revision's current binding
            // (below); its Index reference is derived again from both.
            let current_seal = match &expected.graph_binding {
                Some(graph) => {
                    checkpoint()?;
                    let seal = read_nir1_graph_seal(conn, &expected.project_id)?;
                    ensure!(
                        seal.as_ref() == Some(&graph.seal),
                        "NIR1_NATIVE_PREPARED_GRAPH_STALE"
                    );
                    seal
                }
                None => None,
            };
            for binding in &expected.authority_bindings {
                checkpoint()?;
                let current = match evaluate_nir1_entity_relation_disclosure(
                    conn,
                    &expected.project_id,
                    binding.revision_id(),
                    &expected.query_scene_id,
                )? {
                    Nir1EntityRelationDisclosureRead::Eligible(disclosure) => {
                        authority_binding(&disclosure)?
                    }
                    Nir1EntityRelationDisclosureRead::Unavailable { .. } => {
                        anyhow::bail!("NIR1_NATIVE_PREPARED_REVISION_STALE")
                    }
                };
                checkpoint()?;
                ensure!(current == *binding, "NIR1_NATIVE_PREPARED_REVISION_STALE");
                if let (Some(graph), Some(seal)) = (&expected.graph_binding, &current_seal) {
                    for input in graph
                        .inputs
                        .iter()
                        .filter(|input| input.revision_id == current.revision_id())
                    {
                        checkpoint()?;
                        ensure!(
                            current
                                .revision()
                                .bundle
                                .relations
                                .iter()
                                .any(|relation| relation.edge_id == input.edge_id),
                            "NIR1_NATIVE_PREPARED_GRAPH_STALE"
                        );
                        let (identity, version) = graph_index_reference(
                            &expected.project_id,
                            seal,
                            &current,
                            &input.edge_id,
                        )?;
                        ensure!(
                            identity == input.index_identity && version == input.index_version,
                            "NIR1_NATIVE_PREPARED_GRAPH_STALE"
                        );
                    }
                }
            }
            checkpoint()?;
            if let Some(history) = expected
                .history
                .as_ref()
                .filter(|history| !history.turns.is_empty())
            {
                confirm_history_in_snapshot(
                    conn,
                    expected,
                    history,
                    workspace,
                    now_ms,
                    &checkpoint_budget,
                    &mut checkpoint,
                )?;
            }
            Ok(())
        },
    )
}

#[cfg(feature = "native-current-human-capture")]
fn take_selected_context_text(selected: NativeNir1SelectedContextItem) -> Result<String> {
    match selected.item {
        ContextItemKind::Raw { text, .. }
        | ContextItemKind::AcceptedIr { text, .. }
        | ContextItemKind::GraphEvidence { text, .. } => Ok(text),
        _ => anyhow::bail!("NIR1_NATIVE_PREPARED_UNSUPPORTED_SELECTED_MATERIAL"),
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
    require_non_empty(decision.created_at(), "decision.createdAt")?;
    require_non_empty(decision.actor_kind(), "decision.actorKind")?;
    require_non_empty(decision.actor_id(), "decision.actorId")?;
    // Packing binds and counts every Decision column, so it reads the Decision
    // completely (`evaluate_nir1_entity_relation_disclosure`).
    let detail = decision.detail().ok_or_else(|| {
        anyhow::anyhow!("NIR-1 Native Decision was read without its free-form columns")
    })?;
    let authority_scope = detail
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
    let override_field_paths: Value = serde_json::from_str(detail.override_field_paths_json())?;
    ensure!(
        override_field_paths.is_array(),
        "NIR-1 Native Decision override paths are not an array"
    );
    Ok(NativeNir1DecisionBinding {
        id: decision.id().to_owned(),
        revision_id: decision.revision_id().to_owned(),
        decision: decision.decision().to_owned(),
        decision_json: detail.decision_json().to_owned(),
        created_at: decision.created_at().to_owned(),
        created_by: detail.created_by().to_owned(),
        actor_kind: decision.actor_kind().to_owned(),
        actor_id: decision.actor_id().to_owned(),
        authority_scope: authority_scope.to_owned(),
        override_field_paths_json: detail.override_field_paths_json().to_owned(),
    })
}

pub(super) fn authority_binding(
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

fn authority_binding_digest_and_size(
    binding: &NativeNir1AuthorityBinding,
) -> Result<([u8; 32], usize)> {
    let serialized = canonical_value(&authority_binding_value(binding)?)?;
    // Revision serialization skips its private Decision, which is also held
    // beside the public binding projection. Count that duplicate content
    // without publishing it or changing the established digest.
    let retained_bytes = [
        &binding.decision.id,
        &binding.decision.revision_id,
        &binding.decision.decision,
        &binding.decision.decision_json,
        &binding.decision.created_at,
        &binding.decision.created_by,
        &binding.decision.actor_kind,
        &binding.decision.actor_id,
        &binding.decision.authority_scope,
        &binding.decision.override_field_paths_json,
    ]
    .into_iter()
    .try_fold(serialized.len(), |bytes, field| {
        bytes
            .checked_add(field.len())
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native authority byte count overflow"))
    })?;
    Ok((Sha256::digest(serialized.as_bytes()).into(), retained_bytes))
}

fn candidate_binding_digest(
    kind: &str,
    authority_digest: [u8; 32],
    group_id: &str,
    parts: &[(AtomicPart, String)],
) -> Result<[u8; 32]> {
    let value = json!({
        "kind": kind,
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

/// The five ordered parts of one typed record's group. Both the accepted IR
/// group and the Graph group of the same relation are made from this, so their
/// text is the same bytes (DI-1a: the Graph adds no text of its own).
fn group_parts(
    binding: &NativeNir1AuthorityBinding,
    record_id: &str,
    projection: Value,
    evidence: Value,
) -> Result<[(AtomicPart, String); NATIVE_ATOMIC_PART_COUNT]> {
    Ok([
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
    ])
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
    let parts = group_parts(binding, record_id, projection, evidence)?;
    input_budget.reserve_group(group_id, &parts)?;
    let candidate_binding = candidate_binding_digest(
        "nir1.native.accepted-ir@1",
        authority_digest,
        group_id,
        &parts,
    )?;
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

/// The statement projection and the Evidence projection of one relation, from
/// the Revision the snapshot read. The accepted IR group and the Graph group of
/// the same relation share this function, so a Graph group cannot differ from
/// the IR group in text.
fn relation_group_material(
    relation: &grimodex_core::narrative_nir1::GraphEdgeInput,
    entities_by_id: &HashMap<&str, &grimodex_core::narrative_nir1::EntityInput>,
    evidence_by_id: &HashMap<String, MaterialEvidenceEntry>,
) -> Result<(Value, Value)> {
    let from = entities_by_id
        .get(relation.from_entity_id.as_str())
        .ok_or_else(|| anyhow::anyhow!("NIR-1 Native relation source Entity is missing"))?;
    let to = entities_by_id
        .get(relation.to_entity_id.as_str())
        .ok_or_else(|| anyhow::anyhow!("NIR-1 Native relation target Entity is missing"))?;
    // Resolve relation evidence against the global Material Basis map,
    // rather than only looking at endpoint-local evidence lists.
    let relation_evidence = material_evidence_for_ids(&relation.evidence_ids, evidence_by_id)?;
    let from_evidence = material_evidence_for_ids(
        &from
            .evidence
            .iter()
            .map(|item| item.evidence_id.clone())
            .collect::<Vec<_>>(),
        evidence_by_id,
    )?;
    let to_evidence = material_evidence_for_ids(
        &to.evidence
            .iter()
            .map(|item| item.evidence_id.clone())
            .collect::<Vec<_>>(),
        evidence_by_id,
    )?;
    Ok((
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
    ))
}

fn adapt_typed_revision_candidates(
    disclosure: &Nir1EntityRelationDisclosure,
    authority_digest: [u8; 32],
    binding: &NativeNir1AuthorityBinding,
    input_budget: &mut NativePackingInputBudget,
    candidates: &mut Vec<CandidateContextItem>,
    candidate_owners: &mut HashMap<String, String>,
    checkpoint: &mut impl FnMut() -> Result<()>,
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
        checkpoint()?;
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
        let group = accepted_ir_group(
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
        )?;
        for candidate in &group {
            candidate_owners.insert(
                item_id(candidate.item()).to_owned(),
                revision.revision_id.clone(),
            );
        }
        candidates.extend(group);
    }
    for relation in &revision.bundle.relations {
        checkpoint()?;
        let (projection, evidence) =
            relation_group_material(relation, &entities_by_id, &evidence_by_id)?;
        let group_id = format!(
            "nir1:accepted-ir:{}:relation:{}",
            revision.revision_id, relation.edge_id
        );
        let group = accepted_ir_group(
            binding,
            authority_digest,
            input_budget,
            &group_id,
            &relation.edge_id,
            projection,
            evidence,
        )?;
        for candidate in &group {
            candidate_owners.insert(
                item_id(candidate.item()).to_owned(),
                revision.revision_id.clone(),
            );
        }
        candidates.extend(group);
    }
    Ok(())
}

fn selected_items(
    items: &[CandidateContextItem],
    packed: &PackedContext,
    candidate_owners: &HashMap<String, String>,
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
            owner_revision_id: candidate_owners.get(item_id(candidate.item())).cloned(),
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
    let mut input_budget = NativePackingInputBudget::default();
    database.with_read_transaction(|conn| {
        let mut pooled = read_and_pack_native_a2_context_in_tx(
            conn,
            NativeNir1PooledPackingRequest {
                project_id: &request.project_id,
                revision_ids: std::slice::from_ref(&request.revision_id),
                query_scene_id: &request.query_scene_id,
                budget_tokens: request.budget_tokens,
                purpose: request.purpose,
                raw_items: &request.raw_items,
                #[cfg(feature = "native-current-human-capture")]
                graph: None,
            },
            &mut input_budget,
            &mut |_| Ok(()),
            &mut || Ok(()),
        )?;
        let binding = pooled
            .bindings
            .pop()
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native packing lost its authority binding"))?;
        Ok(NativeNir1PackedContext {
            packed: pooled.packed,
            selected_items: pooled.selected_items,
            binding,
        })
    })
}

/// Read every unique exact Revision in one caller-owned snapshot and pack the
/// combined candidates once. The checkpoint borrows the outer read budget and
/// cancellation owner; this helper never installs or resets a connection hook.
/// `input_budget` is cumulative across all revisions and remains charged on
/// failure. The reservation callback receives cumulative serialized binding
/// bytes plus skipped private Decision content, before another binding is held.
/// This is accounting for retained authority content, not allocator/SQLite peak
/// memory. The caller supplies its applicable aggregate limit; this helper does
/// not silently use B build or C query limits. Bindings describe this snapshot,
/// not currentness after it closes.
pub(super) fn read_and_pack_native_a2_context_in_tx(
    conn: &Connection,
    request: NativeNir1PooledPackingRequest<'_>,
    input_budget: &mut NativePackingInputBudget,
    reserve_retained_binding: &mut impl FnMut(usize) -> Result<()>,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1PooledPackedContext> {
    read_and_pack_native_a2_context_in_tx_with_raw_charge(
        conn,
        request,
        input_budget,
        RawBudgetCharge::Charge,
        RevisionUnavailablePolicy::Reject,
        reserve_retained_binding,
        checkpoint,
    )
}

fn read_and_pack_native_a2_context_in_tx_with_raw_charge(
    conn: &Connection,
    request: NativeNir1PooledPackingRequest<'_>,
    input_budget: &mut NativePackingInputBudget,
    raw_budget_charge: RawBudgetCharge,
    policy: RevisionUnavailablePolicy,
    reserve_retained_binding: &mut impl FnMut(usize) -> Result<()>,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1PooledPackedContext> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_NATIVE_PACKING_REQUIRES_READ_TRANSACTION"
    );
    // Reject oversized unqualified lists before scanning IDs or allocating a
    // dedup set. Every valid Revision contributes at least one atomic group.
    ensure!(
        request.revision_ids.len() <= MAX_PACKING_ITEMS,
        "NIR-1 Native Revision count exceeds MAX_PACKING_ITEMS {MAX_PACKING_ITEMS}"
    );
    let revision_id_bytes = request.revision_ids.iter().try_fold(0usize, |used, id| {
        used.checked_add(id.len())
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native Revision ID byte count overflow"))
    })?;
    ensure!(
        revision_id_bytes <= MAX_PACKING_INPUT_BYTES,
        "NIR-1 Native Revision IDs exceed MAX_PACKING_INPUT_BYTES {MAX_PACKING_INPUT_BYTES}"
    );
    // The Native selection may find no candidate; the caller then meets the
    // required-context rule (a Raw and at least one accepted IR). A caller list
    // is never empty.
    let empty_list_allowed = match policy {
        RevisionUnavailablePolicy::Reject => false,
        #[cfg(feature = "native-current-human-capture")]
        RevisionUnavailablePolicy::Exclude => true,
    };
    ensure!(
        !request.project_id.trim().is_empty()
            && (empty_list_allowed || !request.revision_ids.is_empty())
            && request.revision_ids.iter().all(|id| !id.trim().is_empty())
            && !request.query_scene_id.trim().is_empty(),
        "NIR-1 Native packing request identity is incomplete"
    );
    ensure!(
        !request.raw_items.is_empty(),
        "NIR-1 Native packing requires at least one Raw context item"
    );
    checkpoint()?;
    preflight_projected_item_count(request.raw_items.len(), 0, 0)?;
    if raw_budget_charge == RawBudgetCharge::Charge {
        for raw in request.raw_items {
            input_budget.reserve_raw(raw)?;
        }
    }
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
    let mut seen = HashSet::new();
    let mut candidate_owners = HashMap::new();
    let mut bindings = Vec::new();
    #[cfg(feature = "native-current-human-capture")]
    let mut excluded = Vec::<NativeNir1ExcludedRevision>::new();
    #[cfg(feature = "native-current-human-capture")]
    let mut authority_digests = HashMap::<String, [u8; 32]>::new();
    for revision_id in request.revision_ids {
        checkpoint()?;
        if !seen.insert(revision_id.as_str()) {
            continue;
        }
        let disclosure = match evaluate_nir1_entity_relation_disclosure(
            conn,
            request.project_id,
            revision_id,
            request.query_scene_id,
        )? {
            Nir1EntityRelationDisclosureRead::Eligible(disclosure) => disclosure,
            Nir1EntityRelationDisclosureRead::Unavailable { reason } => match policy {
                RevisionUnavailablePolicy::Reject => {
                    anyhow::bail!("NIR1_NATIVE_A2_UNAVAILABLE:{reason}")
                }
                // Only a closed per-candidate reason leaves the candidate out.
                // A query-Scene reason is about the request, and an unknown one
                // is not understood: both fail the whole request.
                #[cfg(feature = "native-current-human-capture")]
                RevisionUnavailablePolicy::Exclude => {
                    if REQUEST_LEVEL_UNAVAILABLE_REASONS.contains(&reason.as_str()) {
                        anyhow::bail!("NIR1_NATIVE_A2_UNAVAILABLE:{reason}")
                    }
                    let Some(reason) = NativeNir1RevisionExclusionReason::from_a2_a3_code(&reason)
                    else {
                        anyhow::bail!("NIR1_NATIVE_A2_UNAVAILABLE_REASON_UNKNOWN")
                    };
                    excluded.push(NativeNir1ExcludedRevision {
                        revision_id: revision_id.clone(),
                        reason,
                    });
                    continue;
                }
            },
        };
        checkpoint()?;
        preflight_projected_item_count(
            items.len(),
            disclosure.revision.bundle.entities.len(),
            disclosure.revision.bundle.relations.len(),
        )?;
        let binding = authority_binding(&disclosure)?;
        let (authority_digest, binding_bytes) = authority_binding_digest_and_size(&binding)?;
        #[cfg(feature = "native-current-human-capture")]
        authority_digests.insert(binding.revision_id.clone(), authority_digest);
        let retained_binding_bytes = input_budget
            .retained_binding_bytes
            .checked_add(binding_bytes)
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native authority byte count overflow"))?;
        reserve_retained_binding(retained_binding_bytes)?;
        input_budget.retained_binding_bytes = retained_binding_bytes;
        adapt_typed_revision_candidates(
            &disclosure,
            authority_digest,
            &binding,
            input_budget,
            &mut items,
            &mut candidate_owners,
            checkpoint,
        )?;
        bindings.push(binding);
    }
    checkpoint()?;
    // The Graph is requalified in this same snapshot, after the IR groups: a
    // relation the Graph qualifies takes the place of its IR group (DI-1a).
    #[cfg(feature = "native-current-human-capture")]
    let graph = match request.graph {
        Some(candidates) => Some(graph_candidates::pool_graph_candidates(
            conn,
            graph_candidates::GraphPoolContext {
                candidates,
                project_id: request.project_id,
                query_scene_id: request.query_scene_id,
                native_selection: policy_is_native_selection(policy),
                raw_item_count: request.raw_items.len(),
                budget_tokens: request.budget_tokens,
                purpose: request.purpose,
                excluded: &excluded,
                bindings: &bindings,
                authority_digests: &authority_digests,
            },
            input_budget,
            &mut items,
            &mut candidate_owners,
            checkpoint,
        )?),
        None => None,
    };
    checkpoint()?;
    #[cfg(feature = "nir1-final-request-eval")]
    final_request_eval::observe_candidate_set(
        &request,
        &items,
        &candidate_owners,
        &bindings,
        &raw_budget_charge,
        &graph,
    );
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: request.budget_tokens,
        purpose: request.purpose,
        items: items.clone(),
    })
    .map_err(anyhow::Error::from)?;
    let selected_items = selected_items(&items, &packed, &candidate_owners)?;
    checkpoint()?;
    Ok(NativeNir1PooledPackedContext {
        packed,
        selected_items,
        bindings,
        #[cfg(feature = "native-current-human-capture")]
        raw_source_binding: None,
        #[cfg(feature = "native-current-human-capture")]
        excluded,
        #[cfg(feature = "native-current-human-capture")]
        graph,
    })
}

#[cfg(feature = "native-current-human-capture")]
fn policy_is_native_selection(policy: RevisionUnavailablePolicy) -> bool {
    matches!(policy, RevisionUnavailablePolicy::Exclude)
}

#[cfg(test)]
#[path = "nir1_packing_tests.rs"]
pub(super) mod tests;

// DI-1a S2: Graph-derived inputs of a D-final request.
#[cfg(all(test, feature = "native-current-human-capture"))]
#[path = "nir1_packing_graph_input_tests.rs"]
mod graph_input_tests;

// HC1-4: the session history run, end to end.
#[cfg(all(test, feature = "native-current-human-capture"))]
#[path = "nir1_packing_session_tests.rs"]
mod session_history_tests;
