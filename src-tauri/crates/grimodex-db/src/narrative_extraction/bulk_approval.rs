//! Chronicle "bulk approve" operation (BAO/1).
//!
//! One Native-owned judgement decides whether a Chronicle proposal may be
//! bulk-approved ([`evaluate`]).  The review read ([`attach_bulk_approval`])
//! and the write path ([`narrative_extraction_chronicle_bulk_approve`]) call
//! the same function, so the screen never computes the condition itself.
//!
//! The write path composes two existing bodies in one transaction per
//! proposal: the Human-derived child creation (only `/disclosure/secret`
//! changes, true -> false) and the Human approval of that child.  Neither
//! body's checks are skipped or loosened here.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashMap};

use anyhow::anyhow;
use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_ir::CHRONICLE_EVENT_PROPOSAL_KIND;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};

use super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, ActiveDependencyDeclarationSetRead,
};
use super::human_materialization::{
    classify_reveal_mappings,
    create_human_derived_revision_with_c2b_projection_materialization_in_tx, reveal_scene_ref,
    RevealMappingMatch,
};
use super::models::{
    AppendDecisionPayload, CreateHumanDerivedRevisionRequest, NarrativeAdapterIdentity,
};
use super::project_scope_authority::load_live_project_scope_authority;
use super::repository::{
    append_human_decision_in_tx, current_chronicle_run_spec_for_run,
    load_current_chronicle_proposal_matches, load_validated_chronicle_proposal_matches,
    CurrentChronicleProposalPlanAuthority,
};
use super::scope_authority_runtime::{
    load_sealed_snapshot_document_bindings_in_tx, SealedSnapshotDocumentBinding,
};
use super::task_leases::with_immediate_transaction;
use crate::narrative_runtime_policy::require_narrative_extraction_allowed;
use crate::Database;

const PROPOSAL_REVISION_CONSUMER_KIND: &str = "proposal-revision";
const EVIDENCE_RESOLVED_ARTIFACT_KIND: &str = "evidence.resolved@1";
const EVIDENCE_RESOLVE_TASK_KIND: &str = "evidence.resolve@1";
/// The review surface id the lineage verification reads (`human_derivation.rs`).
const REVIEW_SURFACE_ID: &str = "chronicle-review";
/// Same `createdBy` label the review screen records for a Human decision.
const REVIEW_DECISION_CREATED_BY: &str = "chronicle-extract-dialog";
/// Upper bound on one request's target list.
pub const BULK_APPROVE_MAX_TARGETS: usize = 4096;

/// Why a proposal is not (or no longer) a bulk-approval target. Serialized as
/// stable kebab-case codes; the review screen shows them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BulkApprovalReason {
    // (a) review state
    Approved,
    Rejected,
    Held,
    Deferred,
    StatusOther,
    Applied,
    SetApplied,
    // (b) the current revision is not the AI interpretation root
    Edited,
    // (c) sealed duplicate judgement
    ProbableDuplicate,
    PlanUnavailable,
    // (d) evidence correspondence
    EvidenceUnverified,
    // (e)(f) review reasons (RR/1)
    R0MaterialUnavailable,
    R1NarrativeFrame,
    R2Attribution,
    R3Significance,
    R4Actuality,
    // (g) the unsealed child cannot be created now
    AlreadyNonSecret,
    RevealSceneUnresolved,
    ScopeAuthorityUnavailable,
    SemanticEpochMissing,
    ParentSealMissing,
    // command-only
    ProposalNotFound,
    RevisionChanged,
}

impl BulkApprovalReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Held => "held",
            Self::Deferred => "deferred",
            Self::StatusOther => "status-other",
            Self::Applied => "applied",
            Self::SetApplied => "set-applied",
            Self::Edited => "edited",
            Self::ProbableDuplicate => "probable-duplicate",
            Self::PlanUnavailable => "plan-unavailable",
            Self::EvidenceUnverified => "evidence-unverified",
            Self::R0MaterialUnavailable => "r0-material-unavailable",
            Self::R1NarrativeFrame => "r1-narrative-frame",
            Self::R2Attribution => "r2-attribution",
            Self::R3Significance => "r3-significance",
            Self::R4Actuality => "r4-actuality",
            Self::AlreadyNonSecret => "already-nonsecret",
            Self::RevealSceneUnresolved => "reveal-scene-unresolved",
            Self::ScopeAuthorityUnavailable => "scope-authority-unavailable",
            Self::SemanticEpochMissing => "semantic-epoch-missing",
            Self::ParentSealMissing => "parent-seal-missing",
            Self::ProposalNotFound => "proposal-not-found",
            Self::RevisionChanged => "revision-changed",
        }
    }
}

impl Serialize for BulkApprovalReason {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkApprovalVerdict {
    pub eligible: bool,
    pub reasons: Vec<BulkApprovalReason>,
}

impl BulkApprovalVerdict {
    fn from_reasons(reasons: BTreeSet<BulkApprovalReason>) -> Self {
        Self {
            eligible: reasons.is_empty(),
            reasons: reasons.into_iter().collect(),
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "eligible": self.eligible,
            "reasons": self.reasons.iter().map(|reason| reason.code()).collect::<Vec<_>>(),
        })
    }
}

/// How the sealed Plan is read. The review bundle has already verified the
/// Plan binding of the Run for exactly one (Task, Attempt) pair, so it does not
/// pay for the same verification a second time.
pub(crate) enum PlanSource {
    /// Verify the whole binding again (the write path has no earlier proof).
    Verify,
    /// The caller verified the binding for this Task / Attempt just before.
    Verified { task_id: String, attempt_id: String },
}

/// The `evidence.resolved@1` anchors of the Run, indexed by anchor id.
pub(crate) struct EvidenceAnchors {
    anchors: Vec<Value>,
    by_id: HashMap<String, Vec<usize>>,
}

impl EvidenceAnchors {
    fn new(anchors: Vec<Value>) -> Self {
        let mut by_id: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, anchor) in anchors.iter().enumerate() {
            if let Some(id) = anchor.get("id").and_then(Value::as_str) {
                by_id.entry(id.to_owned()).or_default().push(index);
            }
        }
        Self { anchors, by_id }
    }
}

/// Run-level material. Every part is read at most once per call, the first time
/// a judgement needs it, and a part that cannot be read is `None`: the judgement
/// then reports it as a reason instead of failing the caller.  The sealed parts
/// (Plan, evidence, Snapshot documents) are immutable.  The live parts (Scope
/// authority, Semantic Epoch) are advisory pre-checks of the writer, which
/// re-reads them itself inside its own transaction, so a stale value can only
/// make the write path skip a proposal or fail it (never write one the writer
/// would refuse).  Values that change per proposal (status, current Revision,
/// Application, parent seal) are never held here.
pub(crate) struct BulkApprovalContext {
    project_id: String,
    run_id: String,
    proposal_set_id: String,
    plan_source: PlanSource,
    plan: OnceCell<Option<HashMap<String, CurrentChronicleProposalPlanAuthority>>>,
    evidence: OnceCell<Option<EvidenceAnchors>>,
    sealed_documents: OnceCell<Option<Vec<SealedSnapshotDocumentBinding>>>,
    /// `scene_ref` of every live Scope authority mapping.
    mapping_scene_refs: OnceCell<Option<Vec<String>>>,
    epoch_present: OnceCell<bool>,
}

impl BulkApprovalContext {
    pub(crate) fn new(
        project_id: &str,
        run_id: &str,
        proposal_set_id: &str,
        plan_source: PlanSource,
    ) -> Self {
        Self {
            project_id: project_id.to_owned(),
            run_id: run_id.to_owned(),
            proposal_set_id: proposal_set_id.to_owned(),
            plan_source,
            plan: OnceCell::new(),
            evidence: OnceCell::new(),
            sealed_documents: OnceCell::new(),
            mapping_scene_refs: OnceCell::new(),
            epoch_present: OnceCell::new(),
        }
    }

    /// The Chronicle ProposalSet of the Run. `None` when the Run is not a
    /// current Chronicle Run or does not own exactly one ProposalSet.
    pub(crate) fn proposal_set_id(
        conn: &Connection,
        project_id: &str,
        run_id: &str,
    ) -> anyhow::Result<Option<String>> {
        if !current_chronicle_run_spec_for_run(conn, project_id, run_id)? {
            return Ok(None);
        }
        let ids = conn
            .prepare(
                "SELECT id FROM narrative_proposal_sets
                  WHERE run_id = ?1 AND project_id = ?2",
            )?
            .query_map(params![run_id, project_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(match ids.as_slice() {
            [only] => Some(only.clone()),
            _ => None,
        })
    }

    /// `conn` must be inside a caller-owned transaction (the sealed Snapshot
    /// lookup requires one).
    fn plan(
        &self,
        conn: &Connection,
    ) -> Option<&HashMap<String, CurrentChronicleProposalPlanAuthority>> {
        self.plan
            .get_or_init(|| match &self.plan_source {
                PlanSource::Verify => load_current_chronicle_proposal_matches(
                    conn,
                    &self.project_id,
                    &self.run_id,
                    &self.proposal_set_id,
                )
                .ok(),
                PlanSource::Verified {
                    task_id,
                    attempt_id,
                } => load_validated_chronicle_proposal_matches(
                    conn,
                    &self.run_id,
                    &self.proposal_set_id,
                    task_id,
                    attempt_id,
                )
                .ok(),
            })
            .as_ref()
    }

    fn evidence(&self, conn: &Connection) -> Option<&EvidenceAnchors> {
        self.evidence
            .get_or_init(|| {
                load_resolved_evidence_anchors(conn, &self.run_id)
                    .ok()
                    .map(EvidenceAnchors::new)
            })
            .as_ref()
    }

    fn sealed_documents(&self, conn: &Connection) -> Option<&[SealedSnapshotDocumentBinding]> {
        self.sealed_documents
            .get_or_init(|| {
                load_sealed_snapshot_document_bindings_in_tx(conn, &self.project_id, &self.run_id)
                    .ok()
            })
            .as_deref()
    }

    fn mapping_scene_refs(&self, conn: &Connection) -> Option<&[String]> {
        self.mapping_scene_refs
            .get_or_init(|| {
                load_live_project_scope_authority(
                    conn,
                    &self.project_id,
                    &format!("project:scope-authority:{}", self.project_id),
                )
                .ok()
                .map(|authority| {
                    authority
                        .mappings
                        .iter()
                        .map(|mapping| mapping.scene_ref.clone())
                        .collect()
                })
            })
            .as_deref()
    }

    fn epoch_present(&self, conn: &Connection) -> bool {
        *self.epoch_present.get_or_init(|| {
            matches!(
                super::semantic_epoch::get_current_epoch(conn, &self.project_id),
                Ok(Some(_))
            )
        })
    }

    /// Read every part now. The write path does this once, in one short
    /// transaction, so the per-proposal transactions only read per-proposal
    /// values.
    fn warm(&self, conn: &Connection) {
        self.plan(conn);
        self.evidence(conn);
        self.sealed_documents(conn);
        self.mapping_scene_refs(conn);
        self.epoch_present(conn);
    }
}

/// The current `evidence.resolved@1` anchors of the Run: the artifact of the
/// completed current Attempt of the evidence task, with a verified canonical
/// digest.
fn load_resolved_evidence_anchors(conn: &Connection, run_id: &str) -> anyhow::Result<Vec<Value>> {
    let rows = conn
        .prepare(
            "SELECT a.payload_storage, a.payload_json, a.payload_digest
               FROM narrative_extraction_artifacts a
               JOIN narrative_extraction_tasks t
                 ON t.id = a.task_id AND t.run_id = a.run_id
               JOIN narrative_extraction_attempts attempt
                 ON attempt.id = a.attempt_id
                AND attempt.task_id = t.id
                AND attempt.attempt_number = t.attempt_count
                AND attempt.status = 'completed'
              WHERE a.run_id = ?1
                AND a.artifact_kind = ?2
                AND t.task_kind = ?3
                AND t.status = 'completed'",
        )?
        .query_map(
            params![
                run_id,
                EVIDENCE_RESOLVED_ARTIFACT_KIND,
                EVIDENCE_RESOLVE_TASK_KIND
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let [(storage, payload, digest)] = rows.as_slice() else {
        return Err(anyhow!(
            "NEX_BULK_APPROVE_EVIDENCE_UNAVAILABLE: Run needs exactly one current evidence artifact"
        ));
    };
    anyhow::ensure!(
        storage == "inline-json",
        "NEX_BULK_APPROVE_EVIDENCE_UNAVAILABLE: evidence artifact is not inline-json"
    );
    let payload: Value = serde_json::from_str(
        payload
            .as_deref()
            .ok_or_else(|| anyhow!("NEX_BULK_APPROVE_EVIDENCE_UNAVAILABLE: no payload"))?,
    )?;
    anyhow::ensure!(
        digest.as_deref() == Some(canonical_json_digest(&payload)?.as_str()),
        "NEX_BULK_APPROVE_EVIDENCE_UNAVAILABLE: evidence artifact digest is not canonical"
    );
    Ok(payload
        .get("anchors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// Stored values of one proposal and its current revision.
pub(crate) struct ProposalFacts {
    pub(crate) proposal_id: String,
    pub(crate) proposal_set_id: String,
    pub(crate) project_id: String,
    pub(crate) run_id: String,
    proposal_key: String,
    kind: String,
    status: String,
    pub(crate) current_revision_id: Option<String>,
    origin_kind: Option<String>,
    envelope_digest: Option<String>,
    payload: Option<Value>,
    envelope: Option<Value>,
    /// `revision_number` of the current Revision row.
    revision_number: Option<i64>,
    application_count: i64,
    /// Some Proposal of the same ProposalSet already has an Application.
    set_applied: bool,
}

/// Whether any Proposal of the set has an Application. One bounded probe.
fn set_has_application(conn: &Connection, proposal_set_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM narrative_proposal_applications application
              JOIN narrative_proposals sibling ON sibling.id = application.proposal_id
             WHERE sibling.proposal_set_id = ?1)",
        params![proposal_set_id],
        |row| row.get(0),
    )
}

/// `shared_set_applied`: the answer of [`set_has_application`] the caller
/// already read once for `(proposal_set_id, applied)` in the same transaction.
/// The write path passes `None` and reads it inside every per-proposal
/// transaction.
pub(crate) fn load_facts(
    conn: &Connection,
    proposal_id: &str,
    shared_set_applied: Option<(&str, bool)>,
) -> anyhow::Result<Option<ProposalFacts>> {
    #[allow(clippy::type_complexity)]
    let row: Option<(
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        i64,
    )> = conn
        .query_row(
            "SELECT p.proposal_set_id, s.project_id, s.run_id, p.proposal_key, p.kind,
                    p.status, p.current_revision_id, r.origin_kind,
                    r.reconciliation_envelope_digest, r.payload_json,
                    r.reconciliation_envelope_json,
                    r.revision_number,
                    (SELECT COUNT(*) FROM narrative_proposal_applications
                      WHERE proposal_id = p.id)
               FROM narrative_proposals p
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
               LEFT JOIN narrative_proposal_revisions r
                 ON r.id = p.current_revision_id AND r.proposal_id = p.id
              WHERE p.id = ?1",
            params![proposal_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                ))
            },
        )
        .optional()?;
    let Some((
        proposal_set_id,
        project_id,
        run_id,
        proposal_key,
        kind,
        status,
        current_revision_id,
        origin_kind,
        envelope_digest,
        payload,
        envelope,
        revision_number,
        application_count,
    )) = row
    else {
        return Ok(None);
    };
    let set_applied = match shared_set_applied {
        Some((set_id, applied)) if set_id == proposal_set_id => applied,
        _ => set_has_application(conn, &proposal_set_id)?,
    };
    Ok(Some(ProposalFacts {
        proposal_id: proposal_id.to_owned(),
        proposal_set_id,
        project_id,
        run_id,
        proposal_key,
        kind,
        status,
        current_revision_id,
        origin_kind,
        envelope_digest,
        payload: payload.and_then(|text| serde_json::from_str(&text).ok()),
        envelope: envelope.and_then(|text| serde_json::from_str(&text).ok()),
        revision_number,
        application_count,
        set_applied,
    }))
}

/// (e): RR/1. Only `story-world` / `narrator` / `scene-level` / `actual` give no
/// reason; any other known value is its own reason; an unknown or missing value
/// is R0 (shown, never silently passed).
fn review_reasons(assertion_payload: &Value, reasons: &mut BTreeSet<BulkApprovalReason>) {
    let field = |name: &str| assertion_payload.get(name).and_then(Value::as_str);
    match field("narrativeFrame") {
        Some("story-world") => {}
        Some("flashback" | "dream" | "reported" | "hypothetical" | "unknown") => {
            reasons.insert(BulkApprovalReason::R1NarrativeFrame);
        }
        _ => {
            reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
        }
    }
    match field("attribution") {
        Some("narrator") => {}
        Some(other)
            if other == "unknown"
                || other
                    .strip_prefix("character:")
                    .is_some_and(|id| !id.trim().is_empty()) =>
        {
            reasons.insert(BulkApprovalReason::R2Attribution);
        }
        _ => {
            reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
        }
    }
    match field("significance") {
        Some("scene-level") => {}
        Some("major") => {
            reasons.insert(BulkApprovalReason::R3Significance);
        }
        _ => {
            reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
        }
    }
    match field("actuality") {
        Some("actual") => {}
        Some("attempted" | "prevented") => {
            reasons.insert(BulkApprovalReason::R4Actuality);
        }
        _ => {
            reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
        }
    }
}

/// (d): the Envelope evidence set is non-empty and each entry corresponds to
/// exactly one sealed `evidence.resolved@1` anchor (id, document, quote, quote
/// digest) whose resolution `method` is `exact` or `exact-with-context` (the
/// same proposals the review screen counts as exactly evidenced).
fn evidence_corresponds(envelope: &Value, evidence_anchors: &EvidenceAnchors) -> bool {
    let Some(evidence) = envelope
        .pointer("/effectiveMaterialBasis/evidenceSet")
        .and_then(Value::as_array)
    else {
        return false;
    };
    if evidence.is_empty() {
        return false;
    }
    let mut seen = BTreeSet::new();
    for entry in evidence {
        let text = |name: &str| entry.get(name).and_then(Value::as_str);
        let (Some(evidence_ref), Some(document_ref), Some(quote), Some(quote_digest)) = (
            text("evidenceRef"),
            text("documentRef"),
            text("quote"),
            text("quoteDigest"),
        ) else {
            return false;
        };
        if evidence_ref.is_empty() || !seen.insert(evidence_ref) {
            return false;
        }
        let matching = evidence_anchors
            .by_id
            .get(evidence_ref)
            .map(|indexes| {
                indexes
                    .iter()
                    .map(|index| &evidence_anchors.anchors[*index])
                    .filter(|anchor| {
                        anchor.get("documentRef").and_then(Value::as_str) == Some(document_ref)
                            && anchor.get("quote").and_then(Value::as_str) == Some(quote)
                            && anchor.get("quoteDigest").and_then(Value::as_str)
                                == Some(quote_digest)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let [anchor] = matching.as_slice() else {
            return false;
        };
        if !matches!(
            anchor.get("method").and_then(Value::as_str),
            Some("exact" | "exact-with-context")
        ) {
            return false;
        }
    }
    true
}

/// The one judgement. `conn` must be inside a transaction.
pub(crate) fn evaluate(
    conn: &Connection,
    ctx: &BulkApprovalContext,
    facts: &ProposalFacts,
) -> BulkApprovalVerdict {
    let mut reasons = BTreeSet::new();

    // (a) review state; no Application, and the set is not consumed.
    match facts.status.as_str() {
        "unreviewed" => {}
        "approved" => {
            reasons.insert(BulkApprovalReason::Approved);
        }
        "rejected" => {
            reasons.insert(BulkApprovalReason::Rejected);
        }
        "held" => {
            reasons.insert(BulkApprovalReason::Held);
        }
        "deferred" => {
            reasons.insert(BulkApprovalReason::Deferred);
        }
        _ => {
            reasons.insert(BulkApprovalReason::StatusOther);
        }
    }
    if facts.application_count > 0 {
        reasons.insert(BulkApprovalReason::Applied);
    }
    if facts.set_applied {
        reasons.insert(BulkApprovalReason::SetApplied);
    }
    if facts.kind != CHRONICLE_EVENT_PROPOSAL_KIND
        || facts.project_id != ctx.project_id
        || facts.run_id != ctx.run_id
        || facts.proposal_set_id != ctx.proposal_set_id
    {
        reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
    }

    // (b)(e)(f): the sealed Envelope of the current revision.
    let envelope = facts.envelope.as_ref().filter(|envelope| {
        facts.origin_kind.as_deref() == Some("enveloped")
            && facts.envelope_digest.is_some()
            && envelope.get("schemaVersion") == Some(&json!(2))
    });
    match envelope {
        None => {
            reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
        }
        Some(envelope) => {
            let basis = envelope
                .pointer("/revisionBasis/kind")
                .and_then(Value::as_str);
            let has_parent = envelope
                .pointer("/revisionBasis/parentRevisionId")
                .is_some_and(|parent| !parent.is_null());
            match basis {
                // The row must agree with the Envelope's own claim: the AI
                // interpretation root is the first Revision of the Proposal.
                Some("interpretation") if !has_parent && facts.revision_number == Some(1) => {}
                Some("human-derived") => {
                    reasons.insert(BulkApprovalReason::Edited);
                }
                _ => {
                    reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
                }
            }
            match envelope.pointer("/assertion/payload") {
                Some(payload) if payload.is_object() => review_reasons(payload, &mut reasons),
                _ => {
                    reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
                }
            }
            // (d)
            let corresponds = ctx
                .evidence(conn)
                .is_some_and(|anchors| evidence_corresponds(envelope, anchors));
            if !corresponds {
                reasons.insert(BulkApprovalReason::EvidenceUnverified);
            }
        }
    }

    // (c) the sealed duplicate judgement of extraction time.
    match ctx
        .plan(conn)
        .and_then(|plan| plan.get(&facts.proposal_key))
    {
        None => {
            reasons.insert(BulkApprovalReason::PlanUnavailable);
        }
        Some(plan) => {
            let status = plan.match_value.get("status").and_then(Value::as_str);
            let title = facts
                .payload
                .as_ref()
                .and_then(|payload| payload.get("title"))
                .and_then(Value::as_str);
            if status != Some("none") || title != Some(plan.planned_title.as_str()) {
                reasons.insert(BulkApprovalReason::ProbableDuplicate);
            }
        }
    }

    // (g) can the unsealed child be created now? Only read-only prerequisites;
    // everything else surfaces as the writer's own failure.
    if reasons.is_empty() {
        child_prerequisites(conn, ctx, facts, &mut reasons);
    }
    BulkApprovalVerdict::from_reasons(reasons)
}

fn child_prerequisites(
    conn: &Connection,
    ctx: &BulkApprovalContext,
    facts: &ProposalFacts,
    reasons: &mut BTreeSet<BulkApprovalReason>,
) {
    let Some(payload) = facts.payload.as_ref() else {
        reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
        return;
    };
    match payload
        .pointer("/disclosure/secret")
        .and_then(Value::as_bool)
    {
        Some(true) => {}
        Some(false) => {
            reasons.insert(BulkApprovalReason::AlreadyNonSecret);
        }
        None => {
            reasons.insert(BulkApprovalReason::R0MaterialUnavailable);
        }
    }
    // The reveal document resolves to exactly one sealed Snapshot document, and
    // its Scene to exactly one live mapping (same rule as the ScopeOverride
    // authority resolution of the child writer).
    let reveal_ref = payload
        .pointer("/disclosure/revealDocumentRef")
        .and_then(Value::as_str)
        .filter(|reference| !reference.trim().is_empty() && reference.trim() == *reference);
    match (reveal_ref, ctx.sealed_documents(conn)) {
        (Some(reveal_ref), Some(documents)) => {
            let nodes = documents
                .iter()
                .filter(|document| document.document_ref == reveal_ref)
                .map(|document| document.node_id.as_str())
                .collect::<Vec<_>>();
            match nodes.as_slice() {
                [node] => match ctx.mapping_scene_refs(conn) {
                    Some(scene_refs) => {
                        let scene_ref = reveal_scene_ref(node);
                        // The writer's own classification: exactly one mapping.
                        if !matches!(
                            classify_reveal_mappings(
                                scene_refs.iter().filter(|r| **r == scene_ref)
                            ),
                            RevealMappingMatch::Unique(_)
                        ) {
                            reasons.insert(BulkApprovalReason::RevealSceneUnresolved);
                        }
                    }
                    None => {
                        reasons.insert(BulkApprovalReason::ScopeAuthorityUnavailable);
                    }
                },
                _ => {
                    reasons.insert(BulkApprovalReason::RevealSceneUnresolved);
                }
            }
        }
        _ => {
            reasons.insert(BulkApprovalReason::RevealSceneUnresolved);
        }
    }
    if !ctx.epoch_present(conn) {
        reasons.insert(BulkApprovalReason::SemanticEpochMissing);
    }
    let sealed = facts
        .current_revision_id
        .as_deref()
        .is_some_and(|revision_id| {
            matches!(
                read_active_dependency_declaration_set_in_tx(
                    conn,
                    &facts.project_id,
                    PROPOSAL_REVISION_CONSUMER_KIND,
                    revision_id,
                ),
                Ok(ActiveDependencyDeclarationSetRead::Active(_))
            )
        });
    if !sealed {
        reasons.insert(BulkApprovalReason::ParentSealMissing);
    }
}

/// Add `bulkApproval: { eligible, reasons }` to every proposal of a current
/// Chronicle review bundle. Never fails the bundle: material that cannot be
/// read is reported as reasons.
///
/// `verified_plan` is the (Task, Attempt) pair whose Plan binding the bundle has
/// just verified. Run-level material is read the first time a judgement needs
/// it (the Snapshot documents, Scope authority and Semantic Epoch only when a
/// proposal passes every earlier condition), and the set-wide Application probe
/// runs once for the whole set.
pub(crate) fn attach_bulk_approval(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    proposal_set_id: &str,
    verified_plan: Option<(&str, &str)>,
    proposals: &mut [Value],
) {
    let unavailable = || {
        BulkApprovalVerdict::from_reasons(BTreeSet::from([
            BulkApprovalReason::R0MaterialUnavailable,
        ]))
    };
    let Ok(tx) = conn.unchecked_transaction() else {
        for proposal in proposals {
            if let Some(object) = proposal.as_object_mut() {
                object.insert("bulkApproval".to_owned(), unavailable().to_value());
            }
        }
        return;
    };
    let plan_source = match verified_plan {
        Some((task_id, attempt_id)) => PlanSource::Verified {
            task_id: task_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
        },
        None => PlanSource::Verify,
    };
    let ctx = BulkApprovalContext::new(project_id, run_id, proposal_set_id, plan_source);
    let set_applied = set_has_application(&tx, proposal_set_id).ok();
    for proposal in proposals {
        let verdict = proposal
            .get("proposalId")
            .and_then(Value::as_str)
            .and_then(|proposal_id| {
                load_facts(
                    &tx,
                    proposal_id,
                    set_applied.map(|applied| (proposal_set_id, applied)),
                )
                .ok()
                .flatten()
            })
            .map(|facts| evaluate(&tx, &ctx, &facts))
            .unwrap_or_else(unavailable);
        if let Some(object) = proposal.as_object_mut() {
            object.insert("bulkApproval".to_owned(), verdict.to_value());
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChronicleBulkApproveTarget {
    pub proposal_id: String,
    pub revision_id: String,
}

/// The renderer shows these targets; it never supplies content, a secret value,
/// an actor or a request identity.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChronicleBulkApprovePayload {
    pub project_id: String,
    pub run_id: String,
    pub targets: Vec<ChronicleBulkApproveTarget>,
}

fn validate_payload(payload: &ChronicleBulkApprovePayload) -> anyhow::Result<()> {
    let trimmed = |value: &str| !value.is_empty() && value.trim() == value;
    anyhow::ensure!(
        trimmed(&payload.project_id) && trimmed(&payload.run_id),
        "NEX_BULK_APPROVE_INVALID: projectId and runId must be trimmed and non-empty"
    );
    anyhow::ensure!(
        !payload.targets.is_empty() && payload.targets.len() <= BULK_APPROVE_MAX_TARGETS,
        "NEX_BULK_APPROVE_INVALID: targets must hold 1..={BULK_APPROVE_MAX_TARGETS} entries"
    );
    let mut seen = BTreeSet::new();
    for target in &payload.targets {
        anyhow::ensure!(
            trimmed(&target.proposal_id) && trimmed(&target.revision_id),
            "NEX_BULK_APPROVE_INVALID: target ids must be trimmed and non-empty"
        );
        anyhow::ensure!(
            seen.insert(target.proposal_id.as_str()),
            "NEX_BULK_APPROVE_INVALID: duplicate target proposal"
        );
    }
    Ok(())
}

enum Outcome {
    Approved {
        proposal_id: String,
        revision_id: String,
        decision_id: String,
    },
    Skipped(Vec<BulkApprovalReason>),
}

/// One proposal, inside the caller's transaction: re-judge, build the child
/// payload from the stored parent payload (only `/disclosure/secret` changes),
/// write the child with the existing writer body, approve it with the existing
/// decision body.
fn approve_one(
    conn: &Connection,
    ctx: &BulkApprovalContext,
    target: &ChronicleBulkApproveTarget,
) -> anyhow::Result<Outcome> {
    require_narrative_extraction_allowed(conn)?;
    let Some(facts) = load_facts(conn, &target.proposal_id, None)? else {
        return Ok(Outcome::Skipped(vec![BulkApprovalReason::ProposalNotFound]));
    };
    if facts.project_id != ctx.project_id
        || facts.run_id != ctx.run_id
        || facts.proposal_set_id != ctx.proposal_set_id
    {
        return Ok(Outcome::Skipped(vec![BulkApprovalReason::ProposalNotFound]));
    }
    if facts.current_revision_id.as_deref() != Some(target.revision_id.as_str()) {
        return Ok(Outcome::Skipped(vec![BulkApprovalReason::RevisionChanged]));
    }
    let verdict = evaluate(conn, ctx, &facts);
    if !verdict.eligible {
        return Ok(Outcome::Skipped(verdict.reasons));
    }
    let (Some(mut payload), Some(parent_digest)) =
        (facts.payload.clone(), facts.envelope_digest.clone())
    else {
        return Ok(Outcome::Skipped(vec![
            BulkApprovalReason::R0MaterialUnavailable,
        ]));
    };
    payload["disclosure"]["secret"] = Value::Bool(false);
    let saved = create_human_derived_revision_with_c2b_projection_materialization_in_tx(
        conn,
        &ctx.project_id,
        &CreateHumanDerivedRevisionRequest {
            proposal_id: facts.proposal_id.clone(),
            expected_current_revision_id: target.revision_id.clone(),
            parent_revision_id: target.revision_id.clone(),
            expected_parent_envelope_digest: parent_digest,
            proposal_payload: payload,
            adapter: NarrativeAdapterIdentity {
                id: "chronicle.scene-event".to_owned(),
                version: "1".to_owned(),
            },
            surface_id: REVIEW_SURFACE_ID.to_owned(),
        },
        None,
    )?;
    let child_revision_id = saved
        .get("revisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("NEX_BULK_APPROVE_CHILD_RECEIPT_INVALID: no child revisionId"))?
        .to_owned();
    let decision = append_human_decision_in_tx(
        conn,
        &AppendDecisionPayload {
            run_id: ctx.run_id.clone(),
            project_id: ctx.project_id.clone(),
            proposal_id: facts.proposal_id.clone(),
            revision_id: child_revision_id.clone(),
            decision: "approved".to_owned(),
            decision_json: None,
            created_by: Some(REVIEW_DECISION_CREATED_BY.to_owned()),
        },
    )?;
    let decision_id = decision
        .get("decisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("NEX_BULK_APPROVE_DECISION_RECEIPT_INVALID: no decisionId"))?
        .to_owned();
    Ok(Outcome::Approved {
        proposal_id: facts.proposal_id,
        revision_id: child_revision_id,
        decision_id,
    })
}

/// The stable `NEX_...` code at the head of an error chain.
fn failure_code(error: &anyhow::Error) -> String {
    for cause in error.chain() {
        let text = cause.to_string();
        let head = text.split(':').next().unwrap_or("");
        if head.starts_with("NEX_")
            && head
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return head.to_owned();
        }
    }
    "NEX_BULK_APPROVE_FAILED".to_owned()
}

/// Bulk approval. One transaction per proposal; a failed proposal is rolled
/// back and reported, the rest continue. `should_stop` is asked between
/// proposals (shutdown / workspace switch): the results so far are returned.
///
/// The Database connection is one mutex shared with every other write (the
/// manuscript autosave among them), so it is held only for one short read of
/// the run-level material and then for one proposal at a time: the lock is
/// released between proposals, and `should_stop` runs without it.
pub fn chronicle_bulk_approve(
    db: &Database,
    payload: ChronicleBulkApprovePayload,
    should_stop: &mut dyn FnMut() -> bool,
) -> anyhow::Result<Value> {
    validate_payload(&payload)?;
    let ctx = db.with_conn(|conn| {
        require_narrative_extraction_allowed(conn)?;
        let tx = conn.unchecked_transaction()?;
        let proposal_set_id =
            BulkApprovalContext::proposal_set_id(&tx, &payload.project_id, &payload.run_id)?
                .ok_or_else(|| {
                    anyhow!(
                        "NEX_BULK_APPROVE_RUN_UNSUPPORTED: run is not a current Chronicle review with one ProposalSet"
                    )
                })?;
        let ctx = BulkApprovalContext::new(
            &payload.project_id,
            &payload.run_id,
            &proposal_set_id,
            PlanSource::Verify,
        );
        ctx.warm(&tx);
        Ok(ctx)
    })?;
    run_targets(&payload.targets, should_stop, &mut |target| {
        db.with_conn(|conn| {
            Ok(with_immediate_transaction(conn, |conn| {
                approve_one(conn, &ctx, target)
            }))
        })
    })
}

/// The per-proposal loop of [`chronicle_bulk_approve`]. `attempt` runs one
/// proposal: the outer `Err` means the connection itself is unavailable, the inner
/// result is the proposal's own outcome. Split out so the order of outcomes can be
/// tested with a substitute for the database work.
fn run_targets(
    targets: &[ChronicleBulkApproveTarget],
    should_stop: &mut dyn FnMut() -> bool,
    attempt: &mut dyn FnMut(&ChronicleBulkApproveTarget) -> anyhow::Result<anyhow::Result<Outcome>>,
) -> anyhow::Result<Value> {
    let mut approved = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut stopped = false;
    for target in targets {
        if should_stop() {
            stopped = true;
            break;
        }
        let attempt = match attempt(target) {
            Ok(attempt) => attempt,
            Err(error) => {
                // The connection itself is unavailable (closed, switching
                // workspace): nothing after this proposal can run either.
                failed.push(json!({
                    "proposalId": target.proposal_id,
                    "code": failure_code(&error),
                }));
                stopped = true;
                break;
            }
        };
        match attempt {
            Ok(Outcome::Approved {
                proposal_id,
                revision_id,
                decision_id,
            }) => approved.push(json!({
                "proposalId": proposal_id,
                "revisionId": revision_id,
                "decisionId": decision_id,
            })),
            Ok(Outcome::Skipped(reasons)) => skipped.push(json!({
                "proposalId": target.proposal_id,
                "reasons": reasons.iter().map(|reason| reason.code()).collect::<Vec<_>>(),
            })),
            Err(error) => {
                // An unproven rollback leaves the connection unreliable:
                // never continue on it.
                if format!("{error:#}").contains("NEX_DB_TRANSACTION_CLEANUP_UNPROVEN") {
                    return Err(error);
                }
                failed.push(json!({
                    "proposalId": target.proposal_id,
                    "code": failure_code(&error),
                }));
            }
        }
    }
    Ok(json!({
        "approved": approved,
        "skipped": skipped,
        "failed": failed,
        "stopped": stopped,
    }))
}

#[cfg(test)]
mod run_targets_tests {
    use super::*;

    fn target(id: &str) -> ChronicleBulkApproveTarget {
        ChronicleBulkApproveTarget {
            proposal_id: id.to_owned(),
            revision_id: format!("{id}-rev"),
        }
    }

    fn approved(id: &str) -> anyhow::Result<anyhow::Result<Outcome>> {
        Ok(Ok(Outcome::Approved {
            proposal_id: id.to_owned(),
            revision_id: format!("{id}-child"),
            decision_id: format!("{id}-decision"),
        }))
    }

    /// A proposal that fails (rolled back) does not stop the next one: failed, then approved.
    #[test]
    fn a_failed_proposal_is_reported_and_the_next_one_is_approved() {
        let targets = [target("a"), target("b")];
        let mut ran = Vec::new();
        let result = run_targets(&targets, &mut || false, &mut |t| {
            ran.push(t.proposal_id.clone());
            if t.proposal_id == "a" {
                Ok(Err(anyhow!("NEX_TEST_FAILURE: boom")))
            } else {
                approved(&t.proposal_id)
            }
        })
        .expect("results");
        assert_eq!(ran, ["a", "b"]);
        assert_eq!(result["failed"], json!([{"proposalId": "a", "code": "NEX_TEST_FAILURE"}]));
        assert_eq!(result["approved"][0]["proposalId"], "b");
        assert_eq!(result["skipped"], json!([]));
        assert_eq!(result["stopped"], false);
    }

    /// The connection itself being unavailable fails that proposal, stops, and runs nothing after.
    #[test]
    fn an_unavailable_connection_fails_that_proposal_and_stops() {
        let targets = [target("a"), target("b"), target("c")];
        let mut ran = Vec::new();
        let result = run_targets(&targets, &mut || false, &mut |t| {
            ran.push(t.proposal_id.clone());
            if t.proposal_id == "b" {
                Err(anyhow!("NEX_DB_CONNECTION_UNUSABLE: quarantined"))
            } else {
                approved(&t.proposal_id)
            }
        })
        .expect("results");
        assert_eq!(ran, ["a", "b"], "nothing after the unavailable connection runs");
        assert_eq!(result["approved"][0]["proposalId"], "a");
        assert_eq!(
            result["failed"],
            json!([{"proposalId": "b", "code": "NEX_DB_CONNECTION_UNUSABLE"}])
        );
        assert_eq!(result["stopped"], true);
    }

    /// An unproven rollback is never continued on.
    #[test]
    fn an_unproven_rollback_aborts_the_whole_run() {
        let targets = [target("a"), target("b")];
        let mut ran = 0;
        let result = run_targets(&targets, &mut || false, &mut |_| {
            ran += 1;
            Ok(Err(anyhow!("NEX_DB_TRANSACTION_CLEANUP_UNPROVEN: x")))
        });
        assert!(result.is_err());
        assert_eq!(ran, 1);
    }
}
