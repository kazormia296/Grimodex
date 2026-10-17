//! Pure D2b-2 history traversal.
//!
//! This file deliberately has no database, Native, provider, or transport
//! dependency. The storage owner supplies an immutable same-snapshot
//! [`HistorySnapshot`] through the hook described in
//! `docs/plans/nir1-d2b-history-gap-candidate.md`. Missing authority data is
//! represented as `None`/`Pending` and fails closed; this module never infers
//! Scope axes, artifact lineage, receipts, or Graph qualification.

use std::collections::{BTreeMap, BTreeSet};

/// An opaque existing identity or token supplied by an authority reader.
pub type OpaqueRef = String;

pub type AttemptId = String;

fn valid_ref(value: &str) -> bool {
    !value.is_empty() && value.trim() == value
}

use crate::nir1_generation::{
    check_input_completeness, CompletenessContext, InputReference, InputRole, InputTarget,
    QualificationReference as StoredQualificationReference,
};
pub use crate::nir1_generation::{
    CompletenessReason, CompletenessViolation, InputUse, QualificationBody, QualificationKind,
    ReferenceFormat,
};
#[cfg(test)]
use crate::nir1_generation::{NotApplicableReason, ScopeRole};

/// One qualification row of an adopted input: a present reference
/// (identity, version and, for Scope, its closed role) or a typed N/A with a
/// closed reason (K4/3 section 3). The kinds, roles and reasons are the
/// storage types, so the checker and the D-final finalizer share one rule.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualificationReference {
    pub kind: QualificationKind,
    pub body: QualificationBody,
}

#[cfg(test)]
impl QualificationReference {
    pub fn present(
        kind: QualificationKind,
        identity: impl Into<OpaqueRef>,
        version: impl Into<OpaqueRef>,
    ) -> Self {
        Self {
            kind,
            body: QualificationBody::Present {
                identity: identity.into(),
                version: version.into(),
                scope_role: None,
            },
        }
    }

    pub fn scope(
        role: ScopeRole,
        identity: impl Into<OpaqueRef>,
        version: impl Into<OpaqueRef>,
    ) -> Self {
        Self {
            kind: QualificationKind::Scope,
            body: QualificationBody::Present {
                identity: identity.into(),
                version: version.into(),
                scope_role: Some(role),
            },
        }
    }

    pub fn not_applicable(kind: QualificationKind, reason: NotApplicableReason) -> Self {
        Self {
            kind,
            body: QualificationBody::NotApplicable { reason },
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct QualificationSet {
    pub references: Vec<QualificationReference>,
}

impl QualificationSet {
    /// The completeness rule of K4/3 section 3 for one adopted input: each of
    /// the 7 kinds has one or more references or the typed N/A of the table,
    /// never both; no `(kind, target)` repeats; an N/A outside the table, a
    /// reference where the table puts an N/A and an unsupported input are
    /// incomplete. The rule is the storage module's pure function, so the
    /// D-final finalizer and this checker cannot drift. There is no
    /// exemption: a Human message is checked like every other input.
    ///
    /// Rule 3 (the set equals the one derived from the current state) needs
    /// the current authorities and is the `CurrentQualifier`'s concern.
    fn validate_complete(
        &self,
        input: &InputReference,
        target_scene_id: &str,
    ) -> Result<(), Failure> {
        for reference in &self.references {
            if let QualificationBody::Present {
                identity, version, ..
            } = &reference.body
            {
                if identity.trim() != identity
                    || identity.is_empty()
                    || version.trim() != version
                    || version.is_empty()
                {
                    return Err(Failure::incomplete(IncompleteReason::InvalidQualification));
                }
            }
        }
        let rows: Vec<StoredQualificationReference> = self
            .references
            .iter()
            .map(|reference| StoredQualificationReference {
                input_ordinal: 0,
                kind: reference.kind,
                body: reference.body.clone(),
            })
            .collect();
        let rows: Vec<&StoredQualificationReference> = rows.iter().collect();
        check_input_completeness(
            0,
            input,
            &rows,
            &CompletenessContext {
                target_scene_id,
                expected_targets: None,
            },
        )
        .map_err(|violation| Failure::incomplete(IncompleteReason::from_completeness(violation)))
    }
}

/// The exact Scope axes are supplied by the existing Scope authority. Empty
/// or absent fields are unavailable; no fallback value is accepted here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopeAxes {
    pub reading_order: Option<OpaqueRef>,
    pub story_time: Option<OpaqueRef>,
    pub viewpoint: Option<OpaqueRef>,
    pub knowledge_holder: Option<OpaqueRef>,
    pub audience: Option<OpaqueRef>,
    pub timeline: Option<OpaqueRef>,
    pub worldline: Option<OpaqueRef>,
    pub narrative_layer: Option<OpaqueRef>,
    pub scene: Option<OpaqueRef>,
}

impl ScopeAxes {
    fn is_complete(&self) -> bool {
        [
            &self.reading_order,
            &self.story_time,
            &self.viewpoint,
            &self.knowledge_holder,
            &self.audience,
            &self.timeline,
            &self.worldline,
            &self.narrative_layer,
            &self.scene,
        ]
        .into_iter()
        .all(|value| {
            value
                .as_deref()
                .is_some_and(|value| !value.is_empty() && value.trim() == value)
        })
    }
}

/// The stored turn tuple and the current turn tuple use the same shape. The
/// stored value is only a comparison anchor; current authority readers still
/// have to approve every attempt/input in the snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryTuple {
    pub envelope: Option<OpaqueRef>,
    pub revision_refs: Vec<OpaqueRef>,
    pub material: Option<OpaqueRef>,
    pub scope: Option<OpaqueRef>,
    pub d1: Option<OpaqueRef>,
    pub scope_axes: ScopeAxes,
    pub purpose: Option<OpaqueRef>,
    pub input_use: Option<OpaqueRef>,
    pub send_classification: Option<OpaqueRef>,
}

impl HistoryTuple {
    fn is_complete(&self) -> bool {
        let present = |value: &Option<OpaqueRef>| {
            value
                .as_deref()
                .is_some_and(|value| !value.is_empty() && value.trim() == value)
        };
        !self.revision_refs.is_empty()
            && self
                .revision_refs
                .iter()
                .all(|value| !value.is_empty() && value.trim() == value)
            && present(&self.envelope)
            && present(&self.material)
            && present(&self.scope)
            && present(&self.d1)
            && self.scope_axes.is_complete()
            && present(&self.purpose)
            && present(&self.input_use)
            && present(&self.send_classification)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptRef {
    pub attempt_id: AttemptId,
    pub receipt_digest: OpaqueRef,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalReceipt {
    pub attempt_id: AttemptId,
    pub receipt_digest: OpaqueRef,
    pub successful: bool,
    pub output_version_id: Option<OpaqueRef>,
    pub payload_digest: Option<OpaqueRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryInputKind {
    GeneratedMessage {
        version_id: OpaqueRef,
        parent_attempt_id: Option<AttemptId>,
        receipt: Option<ReceiptRef>,
    },
    InvalidMessageBinding {
        version_id: OpaqueRef,
    },
    Artifact {
        artifact_id: OpaqueRef,
        payload_digest: OpaqueRef,
        producer_attempt_id: Option<AttemptId>,
        receipt: Option<ReceiptRef>,
    },
    AcceptedRevision {
        revision_id: OpaqueRef,
        bundle_digest: OpaqueRef,
    },
    RawSource {
        source_key: OpaqueRef,
        revision_token: OpaqueRef,
    },
    GraphEvidence {
        evidence_ref: OpaqueRef,
        source_key: OpaqueRef,
        revision_token: OpaqueRef,
    },
    HumanMessage {
        version_id: OpaqueRef,
        explicitly_bound: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryInput {
    pub kind: HistoryInputKind,
    /// How the stored attempt used this input (K4/3 section 5). It selects the
    /// row of the typed N/A table together with the kind.
    pub input_use: InputUse,
    pub qualifications: QualificationSet,
}

impl HistoryInput {
    /// The stored input row this input stands for, derived from its kind and
    /// input-use. `None` for an invalid message binding, which never
    /// qualifies and so has no row of the table.
    fn input_reference(&self) -> Option<InputReference> {
        let (role, target) = match &self.kind {
            HistoryInputKind::GeneratedMessage {
                version_id,
                parent_attempt_id,
                ..
            } => (
                InputRole::Assistant,
                InputTarget::Message {
                    version_id: version_id.clone(),
                    parent_attempt_id: parent_attempt_id.clone(),
                },
            ),
            HistoryInputKind::HumanMessage { version_id, .. } => (
                InputRole::User,
                InputTarget::Message {
                    version_id: version_id.clone(),
                    parent_attempt_id: None,
                },
            ),
            HistoryInputKind::InvalidMessageBinding { .. } => return None,
            HistoryInputKind::Artifact {
                artifact_id,
                payload_digest,
                ..
            } => (
                InputRole::Context,
                InputTarget::Artifact {
                    artifact_id: artifact_id.clone(),
                    payload_digest: payload_digest.clone(),
                },
            ),
            HistoryInputKind::AcceptedRevision {
                revision_id,
                bundle_digest,
            } => (
                InputRole::Context,
                InputTarget::AcceptedRevision {
                    revision_id: revision_id.clone(),
                    bundle_digest: bundle_digest.clone(),
                },
            ),
            HistoryInputKind::RawSource {
                source_key,
                revision_token,
            } => (
                InputRole::Context,
                InputTarget::RawSource {
                    source_key: source_key.clone(),
                    revision_token: revision_token.clone(),
                },
            ),
            HistoryInputKind::GraphEvidence {
                evidence_ref,
                source_key,
                revision_token,
            } => (
                InputRole::Context,
                InputTarget::GraphEvidence {
                    evidence_ref: evidence_ref.clone(),
                    source_key: source_key.clone(),
                    revision_token: revision_token.clone(),
                },
            ),
        };
        Some(InputReference {
            role,
            target,
            input_use: self.input_use,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttemptSnapshot {
    pub id: AttemptId,
    pub tuple: Option<HistoryTuple>,
    pub inputs: Vec<HistoryInput>,
    pub terminal: Option<TerminalReceipt>,
    pub project_id: Option<OpaqueRef>,
    pub session_id: Option<OpaqueRef>,
    /// The attempt's target Scene (`AttemptBinding.scene.scene_id`). The
    /// completeness rule needs it for the query-Scene Scope roles and the Raw
    /// Freshness reason; `None` fails closed.
    pub target_scene_id: Option<OpaqueRef>,
    /// How the attempt's reference rows were written. A version 1 attempt has
    /// no readable inputs and is never used as history.
    pub reference_format: ReferenceFormat,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistorySnapshot {
    pub attempts: BTreeMap<AttemptId, AttemptSnapshot>,
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SnapshotError {
    DuplicateAttempt(AttemptId),
}

#[cfg(test)]
impl HistorySnapshot {
    pub fn from_attempts(
        attempts: impl IntoIterator<Item = AttemptSnapshot>,
    ) -> Result<Self, SnapshotError> {
        let mut by_id = BTreeMap::new();
        for attempt in attempts {
            let id = attempt.id.clone();
            if by_id.contains_key(&id) {
                return Err(SnapshotError::DuplicateAttempt(id));
            }
            by_id.insert(id, attempt);
        }
        Ok(Self { attempts: by_id })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Candidate {
    pub id: OpaqueRef,
    pub root_attempt_id: AttemptId,
    /// Only these direct inputs are adopted at the candidate root. Once a
    /// parent attempt is reached, all of its direct inputs are traversed.
    pub adopted_input_ordinals: Vec<usize>,
}

/// Pure traversal test ledger; storage adapters use their shared turn ledger.
#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryBudget {
    pub remaining_nodes: usize,
    pub remaining_edges: usize,
    pub remaining_qualification_refs: usize,
}

#[cfg(test)]
impl HistoryBudget {
    pub fn new(
        remaining_nodes: usize,
        remaining_edges: usize,
        remaining_qualification_refs: usize,
    ) -> Self {
        Self {
            remaining_nodes,
            remaining_edges,
            remaining_qualification_refs,
        }
    }

    fn consume_node(&mut self) -> Result<(), Failure> {
        if self.remaining_nodes == 0 {
            return Err(Failure::incomplete(IncompleteReason::BudgetExhausted));
        }
        self.remaining_nodes -= 1;
        Ok(())
    }

    fn consume_edge(&mut self) -> Result<(), Failure> {
        if self.remaining_edges == 0 {
            return Err(Failure::incomplete(IncompleteReason::BudgetExhausted));
        }
        self.remaining_edges -= 1;
        Ok(())
    }

    fn consume_qualification_refs(&mut self, count: usize) -> Result<(), Failure> {
        if self.remaining_qualification_refs < count {
            return Err(Failure::incomplete(IncompleteReason::BudgetExhausted));
        }
        self.remaining_qualification_refs -= count;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[expect(
    dead_code,
    reason = "current-authority mapping remains incomplete; no production qualifier is activated"
)]
pub enum QualificationStatus {
    Current,
    Pending,
    Unavailable,
    Ineligible,
}

/// The storage adapter implements this with the existing current readers. A
/// pure traversal cannot turn identity/version strings into authority itself.
pub trait CurrentQualifier {
    fn qualify_attempt(
        &mut self,
        attempt: &AttemptSnapshot,
        current: &HistoryTuple,
    ) -> QualificationStatus;

    fn qualify_input(
        &mut self,
        attempt: &AttemptSnapshot,
        ordinal: usize,
        input: &HistoryInput,
        current: &HistoryTuple,
    ) -> QualificationStatus;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IncompleteReason {
    CurrentTupleUnavailable,
    MissingAttempt(AttemptId),
    MissingParent(AttemptId),
    MissingReceipt(AttemptId),
    ReceiptMismatch(AttemptId),
    InvalidQualification,
    InvalidReference,
    /// Two references (or two typed N/A rows) with the same `(kind, target)`.
    DuplicateQualification(QualificationKind),
    /// Neither a reference nor a typed N/A for this kind.
    MissingQualification(QualificationKind),
    /// Any other violation of the completeness rule (forged N/A, a reference
    /// and an N/A together, a Scope role problem, an unsupported input, ...).
    QualificationRule(CompletenessViolation),
    /// The attempt's references were written in the version 1 format. They are
    /// read for terminalization and recovery only (K4/3 section 2).
    LegacyReferenceFormat,
    /// The attempt's target Scene is unknown, so the completeness rule cannot
    /// be applied.
    TargetSceneUnavailable,
    InvalidInputOrdinal(usize),
    DuplicateInputOrdinal(usize),
    EmptyAdoption,
    Cycle(AttemptId),
    BudgetExhausted,
    Cancelled,
    LegacyMessage,
    PendingAuthority,
    AuthorityUnavailable,
}

impl IncompleteReason {
    /// Map a violation of the shared completeness rule.
    fn from_completeness(violation: CompletenessViolation) -> Self {
        match (violation.reason, violation.kind) {
            (CompletenessReason::MissingKind, Some(kind)) => Self::MissingQualification(kind),
            (
                CompletenessReason::DuplicateTarget | CompletenessReason::DuplicateNotApplicable,
                Some(kind),
            ) => Self::DuplicateQualification(kind),
            _ => Self::QualificationRule(violation),
        }
    }
}

/// A request-wide stop. These conditions must not be represented as an
/// excluded candidate because that could leave an earlier qualified result in
/// an apparently successful outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryRunError {
    CurrentTupleUnavailable,
    AuthorityUnavailable,
    BudgetExhausted,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IneligibleReason {
    TupleMismatch(AttemptId),
    AuthorityRejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Failure {
    Incomplete(IncompleteReason),
    Ineligible(IneligibleReason),
}

/// A caller-owned whole-turn budget ledger. Storage-backed adapters implement
/// this with the same ledger that bounds snapshot reads; the pure test ledger
/// below keeps the traversal independently checkable.
pub trait HistoryBudgetLedger {
    fn consume_node(&mut self) -> Result<(), Failure>;
    fn consume_edge(&mut self) -> Result<(), Failure>;
    fn consume_qualification_refs(&mut self, count: usize) -> Result<(), Failure>;
}

#[cfg(test)]
impl HistoryBudgetLedger for HistoryBudget {
    fn consume_node(&mut self) -> Result<(), Failure> {
        HistoryBudget::consume_node(self)
    }

    fn consume_edge(&mut self) -> Result<(), Failure> {
        HistoryBudget::consume_edge(self)
    }

    fn consume_qualification_refs(&mut self, count: usize) -> Result<(), Failure> {
        HistoryBudget::consume_qualification_refs(self, count)
    }
}

impl Failure {
    fn incomplete(reason: IncompleteReason) -> Self {
        Self::Incomplete(reason)
    }

    fn ineligible(reason: IneligibleReason) -> Self {
        Self::Ineligible(reason)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CandidateDisposition {
    Qualified,
    Excluded(Failure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateResult {
    pub id: OpaqueRef,
    pub disposition: CandidateDisposition,
    pub visited_attempts: Vec<AttemptId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryOutcome {
    pub candidates: Vec<CandidateResult>,
}

struct Traversal<
    'snapshot,
    'qualifier,
    Q: CurrentQualifier,
    B: HistoryBudgetLedger,
    C: FnMut() -> bool,
> {
    snapshot: &'snapshot HistorySnapshot,
    current: &'snapshot HistoryTuple,
    qualifier: &'qualifier mut Q,
    budget: &'qualifier mut B,
    cancelled: &'qualifier mut C,
    header_cache: BTreeMap<AttemptId, Result<(), Failure>>,
    input_cache: BTreeMap<(AttemptId, usize), Result<Option<AttemptId>, Failure>>,
    complete_cache: BTreeMap<AttemptId, Result<Vec<AttemptId>, Failure>>,
    visiting: BTreeSet<AttemptId>,
}

impl<'snapshot, 'qualifier, Q: CurrentQualifier, B: HistoryBudgetLedger, C: FnMut() -> bool>
    Traversal<'snapshot, 'qualifier, Q, B, C>
{
    fn check_cancelled(&mut self) -> Result<(), Failure> {
        if (self.cancelled)() {
            Err(Failure::incomplete(IncompleteReason::Cancelled))
        } else {
            Ok(())
        }
    }

    fn validate_header(&mut self, id: &str) -> Result<(), Failure> {
        self.check_cancelled()?;
        if let Some(cached) = self.header_cache.get(id) {
            return cached.clone();
        }
        let attempt = self
            .snapshot
            .attempts
            .get(id)
            .cloned()
            .ok_or_else(|| Failure::incomplete(IncompleteReason::MissingAttempt(id.into())))?;
        self.budget.consume_node()?;
        let result = match attempt.tuple.as_ref() {
            _ if attempt.reference_format == ReferenceFormat::LegacyV1 => {
                // Version 1 rows have no input-use or typed N/A. The attempt
                // and every descendant that adopts it are excluded; the turn
                // goes on (K4/3 section 2).
                Err(Failure::incomplete(IncompleteReason::LegacyReferenceFormat))
            }
            None => Err(Failure::incomplete(
                IncompleteReason::CurrentTupleUnavailable,
            )),
            Some(tuple) if !tuple.is_complete() || !self.current.is_complete() => Err(
                Failure::incomplete(IncompleteReason::CurrentTupleUnavailable),
            ),
            Some(tuple) if tuple != self.current => Err(Failure::ineligible(
                IneligibleReason::TupleMismatch(id.into()),
            )),
            Some(_) => match self.qualifier.qualify_attempt(&attempt, self.current) {
                QualificationStatus::Current => Ok(()),
                QualificationStatus::Pending => {
                    Err(Failure::incomplete(IncompleteReason::PendingAuthority))
                }
                QualificationStatus::Unavailable => {
                    Err(Failure::incomplete(IncompleteReason::AuthorityUnavailable))
                }
                QualificationStatus::Ineligible => {
                    Err(Failure::ineligible(IneligibleReason::AuthorityRejected))
                }
            },
        };
        self.header_cache.insert(id.into(), result.clone());
        result
    }

    fn validate_input(
        &mut self,
        attempt: &AttemptSnapshot,
        ordinal: usize,
    ) -> Result<Option<AttemptId>, Failure> {
        self.check_cancelled()?;
        if let Some(cached) = self.input_cache.get(&(attempt.id.clone(), ordinal)) {
            return cached.clone();
        }
        let input =
            attempt.inputs.get(ordinal).cloned().ok_or_else(|| {
                Failure::incomplete(IncompleteReason::InvalidInputOrdinal(ordinal))
            })?;
        self.budget
            .consume_qualification_refs(input.qualifications.references.len())?;
        // The completeness rule applies to every input, a Human message
        // included. An invalid message binding has no row of the table; it
        // is excluded by its lineage below.
        if let Some(reference) = input.input_reference() {
            let target_scene_id = attempt
                .target_scene_id
                .as_deref()
                .ok_or_else(|| Failure::incomplete(IncompleteReason::TargetSceneUnavailable))?;
            input
                .qualifications
                .validate_complete(&reference, target_scene_id)?;
        }
        let result = match self
            .qualifier
            .qualify_input(attempt, ordinal, &input, self.current)
        {
            QualificationStatus::Current => self.validate_lineage(attempt, &input),
            QualificationStatus::Pending => {
                Err(Failure::incomplete(IncompleteReason::PendingAuthority))
            }
            QualificationStatus::Unavailable => {
                Err(Failure::incomplete(IncompleteReason::AuthorityUnavailable))
            }
            QualificationStatus::Ineligible => {
                Err(Failure::ineligible(IneligibleReason::AuthorityRejected))
            }
        };
        self.input_cache
            .insert((attempt.id.clone(), ordinal), result.clone());
        result
    }

    fn validate_parent_receipt(
        &self,
        attempt: &AttemptSnapshot,
        parent_attempt_id: Option<&AttemptId>,
        receipt: Option<&ReceiptRef>,
        expected_output_version_id: Option<&str>,
        expected_payload_digest: Option<&str>,
    ) -> Result<Option<AttemptId>, Failure> {
        let parent = parent_attempt_id
            .cloned()
            .ok_or_else(|| Failure::incomplete(IncompleteReason::MissingParent(String::new())))?;
        if !valid_ref(&parent) {
            return Err(Failure::incomplete(IncompleteReason::InvalidReference));
        }
        let receipt = receipt
            .ok_or_else(|| Failure::incomplete(IncompleteReason::MissingReceipt(parent.clone())))?;
        if !valid_ref(&receipt.attempt_id) || !valid_ref(&receipt.receipt_digest) {
            return Err(Failure::incomplete(IncompleteReason::InvalidReference));
        }
        let parent_snapshot =
            self.snapshot.attempts.get(&parent).ok_or_else(|| {
                Failure::incomplete(IncompleteReason::MissingParent(parent.clone()))
            })?;
        if let (Some(project_id), Some(session_id)) =
            (attempt.project_id.as_deref(), attempt.session_id.as_deref())
        {
            if parent_snapshot.project_id.as_deref() != Some(project_id)
                || parent_snapshot.session_id.as_deref() != Some(session_id)
            {
                return Err(Failure::incomplete(IncompleteReason::ReceiptMismatch(
                    parent,
                )));
            }
        }
        let terminal = parent_snapshot
            .terminal
            .as_ref()
            .ok_or_else(|| Failure::incomplete(IncompleteReason::MissingReceipt(parent.clone())))?;
        if receipt.attempt_id != parent
            || !terminal.successful
            || terminal.attempt_id != parent
            || terminal.receipt_digest != receipt.receipt_digest
            || expected_output_version_id
                .is_some_and(|expected| terminal.output_version_id.as_deref() != Some(expected))
            || expected_payload_digest
                .is_some_and(|expected| terminal.payload_digest.as_deref() != Some(expected))
        {
            return Err(Failure::incomplete(IncompleteReason::ReceiptMismatch(
                parent,
            )));
        }
        Ok(Some(parent))
    }

    fn validate_lineage(
        &self,
        attempt: &AttemptSnapshot,
        input: &HistoryInput,
    ) -> Result<Option<AttemptId>, Failure> {
        match &input.kind {
            HistoryInputKind::GeneratedMessage {
                version_id,
                parent_attempt_id,
                receipt,
            } => {
                if !valid_ref(version_id) {
                    return Err(Failure::incomplete(IncompleteReason::InvalidReference));
                }
                self.validate_parent_receipt(
                    attempt,
                    parent_attempt_id.as_ref(),
                    receipt.as_ref(),
                    Some(version_id),
                    None,
                )
            }
            HistoryInputKind::InvalidMessageBinding { .. } => {
                Err(Failure::incomplete(IncompleteReason::InvalidReference))
            }
            HistoryInputKind::Artifact {
                artifact_id,
                payload_digest,
                producer_attempt_id,
                receipt,
                ..
            } => {
                if !valid_ref(artifact_id) || !valid_ref(payload_digest) {
                    return Err(Failure::incomplete(IncompleteReason::InvalidReference));
                }
                self.validate_parent_receipt(
                    attempt,
                    producer_attempt_id.as_ref(),
                    receipt.as_ref(),
                    None,
                    Some(payload_digest),
                )
            }
            HistoryInputKind::HumanMessage {
                version_id,
                explicitly_bound,
                ..
            } => {
                if !valid_ref(version_id) {
                    return Err(Failure::incomplete(IncompleteReason::InvalidReference));
                }
                if !explicitly_bound {
                    Err(Failure::incomplete(IncompleteReason::LegacyMessage))
                } else {
                    Ok(None)
                }
            }
            HistoryInputKind::AcceptedRevision {
                revision_id,
                bundle_digest,
            } => {
                if valid_ref(revision_id) && valid_ref(bundle_digest) {
                    Ok(None)
                } else {
                    Err(Failure::incomplete(IncompleteReason::InvalidReference))
                }
            }
            HistoryInputKind::RawSource {
                source_key,
                revision_token,
            } => {
                if valid_ref(source_key) && valid_ref(revision_token) {
                    Ok(None)
                } else {
                    Err(Failure::incomplete(IncompleteReason::InvalidReference))
                }
            }
            HistoryInputKind::GraphEvidence {
                evidence_ref,
                source_key,
                revision_token,
            } => {
                if valid_ref(evidence_ref) && valid_ref(source_key) && valid_ref(revision_token) {
                    Ok(None)
                } else {
                    Err(Failure::incomplete(IncompleteReason::InvalidReference))
                }
            }
        }
    }

    fn visit_complete(&mut self, id: &str) -> Result<Vec<AttemptId>, Failure> {
        self.check_cancelled()?;
        if let Some(cached) = self.complete_cache.get(id) {
            return cached.clone();
        }
        if self.visiting.contains(id) {
            return Err(Failure::incomplete(IncompleteReason::Cycle(id.into())));
        }
        let attempt = self
            .snapshot
            .attempts
            .get(id)
            .cloned()
            .ok_or_else(|| Failure::incomplete(IncompleteReason::MissingAttempt(id.into())))?;
        self.visiting.insert(id.into());
        let result = (|| {
            self.validate_header(id)?;
            let mut visited = vec![id.into()];
            for ordinal in 0..attempt.inputs.len() {
                self.budget.consume_edge()?;
                if let Some(parent) = self.validate_input(&attempt, ordinal)? {
                    let parent_visited = self.visit_complete(&parent)?;
                    for ancestor in parent_visited {
                        if !visited.contains(&ancestor) {
                            visited.push(ancestor);
                        }
                    }
                }
            }
            Ok(visited)
        })();
        self.visiting.remove(id);
        self.complete_cache.insert(id.into(), result.clone());
        result
    }

    fn visit_candidate_root(&mut self, candidate: &Candidate) -> Result<Vec<AttemptId>, Failure> {
        self.validate_header(&candidate.root_attempt_id)?;
        let attempt = self
            .snapshot
            .attempts
            .get(&candidate.root_attempt_id)
            .cloned()
            .ok_or_else(|| {
                Failure::incomplete(IncompleteReason::MissingAttempt(
                    candidate.root_attempt_id.clone(),
                ))
            })?;
        let mut ordinals = BTreeSet::new();
        for ordinal in &candidate.adopted_input_ordinals {
            if !ordinals.insert(*ordinal) {
                return Err(Failure::incomplete(
                    IncompleteReason::DuplicateInputOrdinal(*ordinal),
                ));
            }
            if *ordinal >= attempt.inputs.len() {
                return Err(Failure::incomplete(IncompleteReason::InvalidInputOrdinal(
                    *ordinal,
                )));
            }
        }
        if ordinals.is_empty() {
            return Err(Failure::incomplete(IncompleteReason::EmptyAdoption));
        }
        let mut visited = vec![candidate.root_attempt_id.clone()];
        for ordinal in ordinals {
            self.budget.consume_edge()?;
            if let Some(parent) = self.validate_input(&attempt, ordinal)? {
                for ancestor in self.visit_complete(&parent)? {
                    if !visited.contains(&ancestor) {
                        visited.push(ancestor);
                    }
                }
            }
        }
        Ok(visited)
    }
}

pub fn reauthorize_history<Q: CurrentQualifier, B: HistoryBudgetLedger, C: FnMut() -> bool>(
    snapshot: &HistorySnapshot,
    candidates: &[Candidate],
    current: &HistoryTuple,
    budget: &mut B,
    qualifier: &mut Q,
    cancelled: &mut C,
) -> Result<HistoryOutcome, HistoryRunError> {
    if cancelled() {
        return Err(HistoryRunError::Cancelled);
    }
    if !current.is_complete() {
        return Err(HistoryRunError::CurrentTupleUnavailable);
    }
    let mut traversal = Traversal {
        snapshot,
        current,
        qualifier,
        budget,
        cancelled,
        header_cache: BTreeMap::new(),
        input_cache: BTreeMap::new(),
        complete_cache: BTreeMap::new(),
        visiting: BTreeSet::new(),
    };
    let mut results = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let result = match traversal.visit_candidate_root(candidate) {
            Ok(visited_attempts) => CandidateResult {
                id: candidate.id.clone(),
                disposition: CandidateDisposition::Qualified,
                visited_attempts,
            },
            Err(Failure::Incomplete(IncompleteReason::AuthorityUnavailable)) => {
                return Err(HistoryRunError::AuthorityUnavailable)
            }
            Err(Failure::Incomplete(IncompleteReason::BudgetExhausted)) => {
                return Err(HistoryRunError::BudgetExhausted)
            }
            Err(Failure::Incomplete(IncompleteReason::Cancelled)) => {
                return Err(HistoryRunError::Cancelled)
            }
            Err(failure) => CandidateResult {
                id: candidate.id.clone(),
                disposition: CandidateDisposition::Excluded(failure),
                visited_attempts: Vec::new(),
            },
        };
        results.push(result);
    }
    Ok(HistoryOutcome {
        candidates: results,
    })
}

/// Adapter for the Native storage hook. The current D2b binding has no full
/// tuple, and the current artifact reader returns no producer receipt; both
/// facts are preserved as `None` and therefore fail closed in
/// `reauthorize_history`.
#[cfg_attr(not(test), allow(dead_code, unused_imports))]
mod generation_storage_adapter {
    use super::*;
    use anyhow::{anyhow, Context, Result};
    use std::collections::BTreeMap;

    use crate::narrative_extraction::{validation_terminated, ValidationTerminationReason};
    use crate::narrative_maintenance_connection::ParticipantSqlControl;
    use crate::nir1_generation::{
        with_generation_history_snapshot, GenerationHistoryReadBudget,
        GenerationHistorySnapshotCancellation, GenerationHistorySnapshotReader, InputRole,
        InputTarget, MessageOrigin, StoredAttempt, StoredTerminal,
    };
    use crate::state::ActiveWorkspaceSnapshot;

    impl HistoryBudgetLedger for GenerationHistoryReadBudget {
        fn consume_node(&mut self) -> std::result::Result<(), Failure> {
            GenerationHistoryReadBudget::consume_node(self)
                .map_err(|_| Failure::incomplete(IncompleteReason::BudgetExhausted))
        }

        fn consume_edge(&mut self) -> std::result::Result<(), Failure> {
            GenerationHistoryReadBudget::consume_edge(self)
                .map_err(|_| Failure::incomplete(IncompleteReason::BudgetExhausted))
        }

        fn consume_qualification_refs(&mut self, count: usize) -> std::result::Result<(), Failure> {
            GenerationHistoryReadBudget::consume_qualification_refs(self, count)
                .map_err(|_| Failure::incomplete(IncompleteReason::BudgetExhausted))
        }
    }

    fn history_run_error(error: HistoryRunError) -> anyhow::Error {
        match error {
            HistoryRunError::Cancelled => validation_terminated(
                ValidationTerminationReason::Cancelled,
                "generation history traversal cancelled by caller",
            ),
            HistoryRunError::CurrentTupleUnavailable => {
                anyhow!("NIR1_GENERATION_HISTORY_CURRENT_TUPLE_UNAVAILABLE")
            }
            HistoryRunError::AuthorityUnavailable => {
                anyhow!("NIR1_GENERATION_HISTORY_AUTHORITY_UNAVAILABLE")
            }
            HistoryRunError::BudgetExhausted => {
                anyhow!("NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED")
            }
        }
    }

    /// The storage reader currently exposes `anyhow::Result` rather than a
    /// typed missing-row error. Only these exact, documented absence markers
    /// may be converted into an absent lineage record. Budget exhaustion,
    /// malformed rows, invalidation, and SQLite failures remain fatal to the
    /// whole same-snapshot read.
    fn is_missing_row(error: &anyhow::Error) -> bool {
        const MISSING_CODES: [&str; 4] = [
            "NIR1_GENERATION_ATTEMPT_MISSING",
            "NIR1_GENERATION_MESSAGE_VERSION_MISSING",
            "NIR1_GENERATION_MESSAGE_BODY_MISSING",
            "NIR1_GENERATION_ARTIFACT_MISSING",
        ];
        let rendered = format!("{error:#}");
        rendered
            .split(": ")
            .any(|part| MISSING_CODES.contains(&part))
    }

    fn missing_as_none<T>(value: Result<T>) -> Result<Option<T>> {
        match value {
            Ok(value) => Ok(Some(value)),
            Err(error) if is_missing_row(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn ensure_not_cancelled<C: FnMut() -> bool>(cancelled: &mut C) -> Result<()> {
        if cancelled() {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "generation history traversal cancelled by caller",
            ));
        }
        Ok(())
    }

    fn ensure_snapshot_not_cancelled<C: FnMut() -> bool>(
        cancellation: &GenerationHistorySnapshotCancellation,
        cancelled: &mut C,
    ) -> Result<()> {
        cancellation.checkpoint()?;
        ensure_not_cancelled(cancelled)
    }

    /// The rows of one input, present references and typed N/A alike. The
    /// completeness rule (not this mapping) decides what they are worth.
    fn qualifications(attempt: &StoredAttempt, ordinal: usize) -> QualificationSet {
        QualificationSet {
            references: attempt
                .qualifications
                .iter()
                .filter(|reference| reference.input_ordinal == ordinal)
                .map(|reference| QualificationReference {
                    kind: reference.kind,
                    body: reference.body.clone(),
                })
                .collect(),
        }
    }

    fn terminal_receipt(terminal: Option<&StoredTerminal>) -> Option<TerminalReceipt> {
        let terminal = terminal?;
        let successful = terminal
            .observation
            .get("terminalStatus")
            .and_then(|value| value.as_str())
            == Some("succeeded");
        Some(TerminalReceipt {
            attempt_id: terminal.attempt_id.clone(),
            receipt_digest: terminal.receipt_digest.clone(),
            successful,
            output_version_id: terminal
                .message_version
                .as_ref()
                .map(|version| version.id.clone()),
            payload_digest: Some(terminal.payload_digest.clone()),
        })
    }

    fn parent_receipt(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        parent_attempt_id: Option<&str>,
    ) -> Result<Option<ReceiptRef>> {
        let Some(parent_attempt_id) = parent_attempt_id else {
            return Ok(None);
        };
        let Some(terminal) =
            missing_as_none(reader.read_terminal(budget, parent_attempt_id))?.flatten()
        else {
            return Ok(None);
        };
        Ok(Some(ReceiptRef {
            attempt_id: parent_attempt_id.to_owned(),
            receipt_digest: terminal.receipt_digest,
        }))
    }

    fn input(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        attempt: &StoredAttempt,
        ordinal: usize,
        input: &crate::nir1_generation::InputReference,
        resolve_lineage: bool,
    ) -> Result<HistoryInput> {
        let qualifications = qualifications(attempt, ordinal);
        let kind = match &input.target {
            InputTarget::Message {
                version_id,
                parent_attempt_id,
            } => {
                let message = if resolve_lineage {
                    missing_as_none(reader.read_message(budget, version_id))?
                } else {
                    None
                };
                let binding_matches = message.as_ref().is_some_and(|message| {
                    let origin_shape_matches = match &message.version.origin {
                        MessageOrigin::Generated => parent_attempt_id.is_some(),
                        MessageOrigin::Human => parent_attempt_id.is_none(),
                    };
                    let role_matches = matches!(
                        (&message.version.origin, &input.role),
                        (MessageOrigin::Generated, InputRole::Assistant)
                            | (MessageOrigin::Human, InputRole::User)
                    );
                    message.version.project_id == attempt.binding.project_id
                        && message.version.session_id == attempt.binding.chat_session_id
                        && message.version.parent_attempt_id.as_ref() == parent_attempt_id.as_ref()
                        && origin_shape_matches
                        && role_matches
                });
                if resolve_lineage && message.is_some() && !binding_matches {
                    return Ok(HistoryInput {
                        kind: HistoryInputKind::InvalidMessageBinding {
                            version_id: version_id.clone(),
                        },
                        input_use: input.input_use,
                        qualifications,
                    });
                }
                let generated = message
                    .as_ref()
                    .map(|message| message.version.origin == MessageOrigin::Generated)
                    .unwrap_or_else(|| parent_attempt_id.is_some());
                if generated {
                    HistoryInputKind::GeneratedMessage {
                        version_id: version_id.clone(),
                        parent_attempt_id: parent_attempt_id.clone(),
                        receipt: if resolve_lineage && message.is_some() {
                            parent_receipt(reader, budget, parent_attempt_id.as_deref())?
                        } else {
                            None
                        },
                    }
                } else {
                    HistoryInputKind::HumanMessage {
                        version_id: version_id.clone(),
                        explicitly_bound: resolve_lineage && message.is_some(),
                    }
                }
            }
            InputTarget::Artifact {
                artifact_id,
                payload_digest,
            } => {
                let artifact = resolve_lineage
                    .then(|| {
                        missing_as_none(reader.read_artifact(
                            budget,
                            &attempt.binding.project_id,
                            artifact_id,
                            payload_digest,
                        ))
                    })
                    .transpose()?
                    .flatten();
                // Current storage returns no producer/receipt relation, so
                // this path remains fail-closed until that relation exists.
                let (artifact_id, payload_digest, producer_attempt_id, producer_receipt_digest) =
                    artifact
                        .map(|artifact| {
                            (
                                artifact.artifact_id,
                                artifact.payload_digest,
                                artifact.producer_attempt_id,
                                artifact.producer_receipt_digest,
                            )
                        })
                        .unwrap_or_else(|| {
                            (artifact_id.clone(), payload_digest.clone(), None, None)
                        });
                let receipt = producer_attempt_id
                    .as_ref()
                    .zip(producer_receipt_digest)
                    .map(|(attempt_id, receipt_digest)| ReceiptRef {
                        attempt_id: attempt_id.clone(),
                        receipt_digest,
                    });
                HistoryInputKind::Artifact {
                    artifact_id,
                    payload_digest,
                    producer_attempt_id,
                    receipt,
                }
            }
            InputTarget::AcceptedRevision {
                revision_id,
                bundle_digest,
            } => HistoryInputKind::AcceptedRevision {
                revision_id: revision_id.clone(),
                bundle_digest: bundle_digest.clone(),
            },
            InputTarget::RawSource {
                source_key,
                revision_token,
            } => HistoryInputKind::RawSource {
                source_key: source_key.clone(),
                revision_token: revision_token.clone(),
            },
            InputTarget::GraphEvidence {
                evidence_ref,
                source_key,
                revision_token,
            } => HistoryInputKind::GraphEvidence {
                evidence_ref: evidence_ref.clone(),
                source_key: source_key.clone(),
                revision_token: revision_token.clone(),
            },
        };
        Ok(HistoryInput {
            kind,
            input_use: input.input_use,
            qualifications,
        })
    }

    fn attempt(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        stored: &StoredAttempt,
        resolve_lineage: bool,
    ) -> Result<AttemptSnapshot> {
        // AttemptBinding exposes coarse digests, purpose and the query Scene
        // binding, not the confirmed full history tuple. Do not reconstruct
        // Scope axes here.
        let inputs = stored
            .inputs
            .iter()
            .enumerate()
            .map(|(ordinal, input_ref)| {
                input(reader, budget, stored, ordinal, input_ref, resolve_lineage)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(AttemptSnapshot {
            id: stored.id.clone(),
            tuple: None,
            inputs,
            terminal: terminal_receipt(stored.terminal.as_ref()),
            project_id: Some(stored.binding.project_id.clone()),
            session_id: Some(stored.binding.chat_session_id.clone()),
            target_scene_id: Some(stored.binding.scene.scene_id.clone()),
            reference_format: stored.reference_format,
        })
    }

    struct LoadedAttempt {
        stored: StoredAttempt,
        snapshot: AttemptSnapshot,
        enriched_ordinals: BTreeSet<usize>,
    }

    fn load_attempt(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
        attempts: &mut BTreeMap<AttemptId, LoadedAttempt>,
    ) -> Result<()> {
        if attempts.contains_key(id) {
            return Ok(());
        }
        let stored = match reader.read_attempt(budget, id) {
            Ok(stored) => stored,
            Err(error) if is_missing_row(&error) => return Ok(()),
            Err(error) => return Err(error),
        };
        let snapshot = attempt(reader, budget, &stored, false)?;
        attempts.insert(
            stored.id.clone(),
            LoadedAttempt {
                stored,
                snapshot,
                enriched_ordinals: BTreeSet::new(),
            },
        );
        Ok(())
    }

    fn enrich_input(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
        ordinal: usize,
        attempts: &mut BTreeMap<AttemptId, LoadedAttempt>,
    ) -> Result<()> {
        let (stored, input_ref) = {
            let Some(loaded) = attempts.get(id) else {
                return Ok(());
            };
            if loaded.enriched_ordinals.contains(&ordinal) {
                return Ok(());
            }
            let Some(input_ref) = loaded.stored.inputs.get(ordinal).cloned() else {
                return Ok(());
            };
            (loaded.stored.clone(), input_ref)
        };
        let mapped = input(reader, budget, &stored, ordinal, &input_ref, true)?;
        let loaded = attempts
            .get_mut(id)
            .ok_or_else(|| anyhow!("NIR1_GENERATION_HISTORY_ATTEMPT_MISSING: {id}"))?;
        loaded.snapshot.inputs[ordinal] = mapped;
        loaded.enriched_ordinals.insert(ordinal);
        Ok(())
    }

    fn parent_id(input: &HistoryInput) -> Option<AttemptId> {
        match &input.kind {
            HistoryInputKind::GeneratedMessage {
                parent_attempt_id,
                receipt,
                ..
            }
            | HistoryInputKind::Artifact {
                producer_attempt_id: parent_attempt_id,
                receipt,
                ..
            } => receipt.as_ref().and_then(|_| parent_attempt_id.clone()),
            _ => None,
        }
    }

    fn materialize_all(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
        attempts: &mut BTreeMap<AttemptId, LoadedAttempt>,
        expanded: &mut BTreeSet<AttemptId>,
        cancellation: &GenerationHistorySnapshotCancellation,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        ensure_snapshot_not_cancelled(cancellation, cancelled)?;
        if !expanded.insert(id.to_owned()) {
            return Ok(());
        }
        load_attempt(reader, budget, id, attempts)?;
        let input_count = attempts
            .get(id)
            .map_or(0, |loaded| loaded.stored.inputs.len());
        for ordinal in 0..input_count {
            ensure_snapshot_not_cancelled(cancellation, cancelled)?;
            enrich_input(reader, budget, id, ordinal, attempts)?;
        }
        let parents = attempts
            .get(id)
            .into_iter()
            .flat_map(|loaded| loaded.snapshot.inputs.iter())
            .filter_map(parent_id)
            .collect::<Vec<_>>();
        for parent in parents {
            ensure_snapshot_not_cancelled(cancellation, cancelled)?;
            materialize_all(
                reader,
                budget,
                &parent,
                attempts,
                expanded,
                cancellation,
                cancelled,
            )?;
        }
        Ok(())
    }

    fn materialize_candidate(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        candidate: &Candidate,
        attempts: &mut BTreeMap<AttemptId, LoadedAttempt>,
        expanded: &mut BTreeSet<AttemptId>,
        cancellation: &GenerationHistorySnapshotCancellation,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        ensure_snapshot_not_cancelled(cancellation, cancelled)?;
        load_attempt(reader, budget, &candidate.root_attempt_id, attempts)?;
        for ordinal in &candidate.adopted_input_ordinals {
            ensure_snapshot_not_cancelled(cancellation, cancelled)?;
            enrich_input(
                reader,
                budget,
                &candidate.root_attempt_id,
                *ordinal,
                attempts,
            )?;
        }
        let parents = attempts
            .get(&candidate.root_attempt_id)
            .into_iter()
            .flat_map(|loaded| {
                candidate
                    .adopted_input_ordinals
                    .iter()
                    .filter_map(|ordinal| loaded.snapshot.inputs.get(*ordinal))
            })
            .filter_map(parent_id)
            .collect::<Vec<_>>();
        for parent in parents {
            ensure_snapshot_not_cancelled(cancellation, cancelled)?;
            materialize_all(
                reader,
                budget,
                &parent,
                attempts,
                expanded,
                cancellation,
                cancelled,
            )?;
        }
        Ok(())
    }

    /// Run the pure traversal over the typed records owned by one storage
    /// snapshot. Confirmed missing rows become absent records so the
    /// candidate is excluded by the pure fail-closed path. Budget, malformed
    /// data, invalidation, and SQLite errors abort the whole read.
    pub(crate) fn reauthorize_from_generation_snapshot<Q: CurrentQualifier, C: FnMut() -> bool>(
        workspace: &ActiveWorkspaceSnapshot,
        control: ParticipantSqlControl,
        caller_budget: &mut GenerationHistoryReadBudget,
        candidates: &[Candidate],
        current: &HistoryTuple,
        qualifier: &mut Q,
        cancelled: &mut C,
    ) -> Result<HistoryOutcome> {
        anyhow::ensure!(
            candidates.len() <= caller_budget.max_candidates,
            "NIR1_GENERATION_HISTORY_CANDIDATE_LIMIT"
        );
        with_generation_history_snapshot(
            workspace,
            control,
            caller_budget,
            |reader, shared_budget, cancellation| {
                let mut loaded = BTreeMap::new();
                let mut expanded = BTreeSet::new();
                cancellation.checkpoint()?;
                ensure_snapshot_not_cancelled(cancellation, cancelled)?;
                for candidate in candidates {
                    materialize_candidate(
                        reader,
                        shared_budget,
                        candidate,
                        &mut loaded,
                        &mut expanded,
                        cancellation,
                        cancelled,
                    )?;
                }
                let attempts = loaded
                    .into_iter()
                    .map(|(id, loaded)| (id, loaded.snapshot))
                    .collect();
                let snapshot = HistorySnapshot { attempts };
                cancellation.checkpoint()?;
                // The pure traversal is synchronous and has no storage
                // connection to poll. Combine the caller's independent
                // cancellation with the participant-owned snapshot control
                // so a long candidate set observes the same turn lifetime.
                // The checkpoint immediately after traversal preserves the
                // participant's typed TimedOut/Cancelled reason when both
                // sources race.
                let mut traversal_cancelled = || cancelled() || cancellation.is_cancelled();
                let result = reauthorize_history(
                    &snapshot,
                    candidates,
                    current,
                    shared_budget,
                    qualifier,
                    &mut traversal_cancelled,
                )
                .map_err(history_run_error);
                cancellation.checkpoint()?;
                result
            },
        )
        .context("NIR1_GENERATION_HISTORY_SNAPSHOT")
    }

    #[cfg(test)]
    mod adapter_tests {
        use super::*;
        use crate::narrative_extraction::{ValidationTerminated, ValidationTerminationReason};
        use crate::nir1_generation::{
            create_attempt, read_attempt_scene_binding_in_tx, scope_identity, AttemptBinding,
            AttemptBindingVersion, AttemptCallerBinding, GenerationHistorySnapshotSqlBudget,
            GenerationHistorySqlLedger, GenerationPurpose, NewAttempt, ReadBudget,
        };
        use crate::recovery::SafeModeState;
        use crate::state::{
            active_workspace_snapshot, ActiveWorkspace, ActiveWorkspaceSnapshot,
            WorkspaceAuthority, WorkspaceState,
        };
        use crate::workspace_lifecycle::{LiveBinding, WorkspaceLifecycleCompatibilityView};
        use crate::Database;
        use serde_json::json;
        use std::path::Path;
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };
        use std::time::{Duration, Instant};

        struct AllowCurrent;

        impl CurrentQualifier for AllowCurrent {
            fn qualify_attempt(
                &mut self,
                _attempt: &AttemptSnapshot,
                _current: &HistoryTuple,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }

            fn qualify_input(
                &mut self,
                _attempt: &AttemptSnapshot,
                _ordinal: usize,
                _input: &HistoryInput,
                _current: &HistoryTuple,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }
        }

        fn incomplete_tuple() -> HistoryTuple {
            HistoryTuple {
                envelope: None,
                revision_refs: Vec::new(),
                material: None,
                scope: None,
                d1: None,
                scope_axes: ScopeAxes {
                    reading_order: None,
                    story_time: None,
                    viewpoint: None,
                    knowledge_holder: None,
                    audience: None,
                    timeline: None,
                    worldline: None,
                    narrative_layer: None,
                    scene: None,
                },
                purpose: None,
                input_use: None,
                send_classification: None,
            }
        }

        fn complete_tuple() -> HistoryTuple {
            let value = |suffix: &str| Some(format!("{suffix}:v1"));
            HistoryTuple {
                envelope: value("envelope"),
                revision_refs: vec!["revision:v1".into()],
                material: value("material"),
                scope: value("scope"),
                d1: value("d1"),
                scope_axes: ScopeAxes {
                    reading_order: value("reading"),
                    story_time: value("story"),
                    viewpoint: value("viewpoint"),
                    knowledge_holder: value("holder"),
                    audience: value("audience"),
                    timeline: value("timeline"),
                    worldline: value("worldline"),
                    narrative_layer: value("layer"),
                    scene: value("scene"),
                },
                purpose: value("writing"),
                input_use: value("history"),
                send_classification: value("local"),
            }
        }

        fn budget() -> GenerationHistoryReadBudget {
            GenerationHistoryReadBudget {
                max_attempts: 8,
                sql: Some(GenerationHistorySqlLedger::new(
                    GenerationHistorySnapshotSqlBudget {
                        max_vm_steps: 1_000_000,
                        deadline: Instant::now() + Duration::from_secs(30),
                        busy_wait: Duration::from_millis(25),
                    },
                )),
                max_candidates: 8,
                max_reference_count: 16,
                max_reference_bytes: 16_384,
                max_resolved_body_bytes: 16_384,
                remaining_project_authority_rows: 0,
                remaining_nodes: 8,
                remaining_edges: 8,
                remaining_qualification_refs: 16,
            }
        }

        fn workspace_snapshot() -> (WorkspaceState, ActiveWorkspaceSnapshot) {
            let path = std::env::temp_dir().join(format!(
                "grimodex-generation-history-adapter-{}",
                uuid::Uuid::new_v4()
            ));
            let db = Database::new(Path::new(":memory:")).expect("database");
            db.migrate().expect("migrate");
            let authority =
                WorkspaceAuthority::from_database_for_test(db, path).expect("test authority");
            let state = WorkspaceState {
                inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
                safe_mode: SafeModeState::default(),
                switching: WorkspaceLifecycleCompatibilityView::new(false),
                open_lock: Mutex::new(Default::default()),
            };
            state
                .switching
                .core()
                .set_ready(LiveBinding::new(
                    authority.path().to_string_lossy(),
                    format!("test-workspace:{}", authority.identity()),
                    authority.identity(),
                    0,
                ))
                .expect("test lifecycle ready");
            let snapshot = active_workspace_snapshot(&state).expect("workspace snapshot");
            (state, snapshot)
        }

        fn storage_attempt(snapshot: &ActiveWorkspaceSnapshot) -> String {
            storage_attempt_with(snapshot, Vec::new(), Vec::new())
        }

        fn storage_attempt_with(
            snapshot: &ActiveWorkspaceSnapshot,
            inputs: Vec<InputReference>,
            qualifications: Vec<crate::nir1_generation::QualificationReference>,
        ) -> String {
            let db = snapshot.db().db();
            db.with_conn(|connection| {
                connection.execute(
                    "INSERT OR IGNORE INTO projects(id,title) VALUES ('generation-project','Project')",
                    [],
                )?;
                connection.execute(
                    "INSERT OR IGNORE INTO tree_nodes
                       (id,project_id,node_type,title,sort_order,version,created_at,updated_at)
                     VALUES ('generation-scene','generation-project','scene','Scene','a0',0,
                             '2026-10-11 00:00:00','2026-10-11 00:00:00')",
                    [],
                )?;
                crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                    connection,
                    "generation-project",
                    "generation-scene",
                    "2026-10-11 00:00:00",
                )?;
                connection.execute(
                    "INSERT OR IGNORE INTO chat_sessions(id,project_id,node_id)
                     VALUES ('generation-session','generation-project','generation-scene')",
                    [],
                )?;
                Ok(())
            })
            .expect("generation fixture");
            let scene = db
                .with_read_transaction(|connection| {
                    read_attempt_scene_binding_in_tx(
                        connection,
                        "generation-project",
                        "generation-scene",
                    )
                })
                .expect("generation Scene binding");
            let digest = format!("sha256:{}", "0".repeat(64));
            create_attempt(
                db,
                NewAttempt {
                    binding: AttemptBinding {
                        binding_version: AttemptBindingVersion::V2,
                        project_id: "generation-project".into(),
                        chat_session_id: "generation-session".into(),
                        scene,
                        caller: AttemptCallerBinding {
                            profile_id: "profile".into(),
                            caller_id: "caller".into(),
                            caller_epoch: 1,
                            caller_session_id: "caller-session".into(),
                        },
                        workspace_binding_digest: digest.clone(),
                        route_revision: "route".into(),
                        purpose: GenerationPurpose::Writing,
                        scope_digest: digest.clone(),
                        material_digest: digest.clone(),
                        d1_digest: digest.clone(),
                        provider: "local".into(),
                        model: "test".into(),
                        api: "chat".into(),
                        endpoint_identity: digest.clone(),
                        history_turn_context: None,
                        durable_workspace_identity: None,
                    },
                    payload_digest: digest,
                    inputs,
                    qualifications,
                    created_at_ms: 1,
                    expires_at_ms: 2,
                    budget: ReadBudget {
                        max_references: 16,
                        max_reference_bytes: 16_384,
                    },
                },
            )
            .expect("generation attempt")
            .id
        }

        fn assert_reason(error: &anyhow::Error, expected: ValidationTerminationReason) {
            let termination = error
                .downcast_ref::<ValidationTerminated>()
                .expect("typed validation termination");
            assert_eq!(termination.reason, expected);
        }

        #[test]
        fn owner_stop_keeps_typed_cancelled_reason_through_adapter_context() {
            let (_state, snapshot) = workspace_snapshot();
            let control = ParticipantSqlControl {
                stop: Arc::new(AtomicBool::new(true)),
                deadline: None,
            };
            let mut caller_budget = budget();
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            let error = reauthorize_from_generation_snapshot(
                &snapshot,
                control,
                &mut caller_budget,
                &[],
                &incomplete_tuple(),
                &mut qualifier,
                &mut cancelled,
            )
            .expect_err("owner stop");
            assert_reason(&error, ValidationTerminationReason::Cancelled);
        }

        #[test]
        fn deadline_keeps_typed_timed_out_reason_through_adapter_context() {
            let (_state, snapshot) = workspace_snapshot();
            let control = ParticipantSqlControl {
                stop: Arc::new(AtomicBool::new(false)),
                deadline: Some(
                    Instant::now()
                        .checked_sub(Duration::from_secs(1))
                        .expect("deadline"),
                ),
            };
            let mut caller_budget = budget();
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            let error = reauthorize_from_generation_snapshot(
                &snapshot,
                control,
                &mut caller_budget,
                &[],
                &incomplete_tuple(),
                &mut qualifier,
                &mut cancelled,
            )
            .expect_err("deadline");
            assert_reason(&error, ValidationTerminationReason::TimedOut);
        }

        #[test]
        fn independent_cancel_closure_keeps_typed_reason_during_materialization() {
            let (_state, snapshot) = workspace_snapshot();
            let candidate = Candidate {
                id: "candidate".into(),
                root_attempt_id: "missing-attempt".into(),
                adopted_input_ordinals: Vec::new(),
            };
            let mut caller_budget = budget();
            let mut qualifier = AllowCurrent;
            let mut checks = 0;
            let mut cancelled = || {
                checks += 1;
                checks > 1
            };
            let error = reauthorize_from_generation_snapshot(
                &snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                &[candidate],
                &incomplete_tuple(),
                &mut qualifier,
                &mut cancelled,
            )
            .expect_err("independent cancellation during materialization");
            assert_reason(&error, ValidationTerminationReason::Cancelled);
        }

        #[test]
        fn participant_stop_is_observed_during_pure_traversal() {
            let (_state, snapshot) = workspace_snapshot();
            let root_attempt_id = storage_attempt(&snapshot);
            let candidate_count = 4;
            let candidates = (0..candidate_count)
                .map(|index| Candidate {
                    id: format!("candidate-{index}"),
                    root_attempt_id: root_attempt_id.clone(),
                    adopted_input_ordinals: Vec::new(),
                })
                .collect::<Vec<_>>();
            let stop = Arc::new(AtomicBool::new(false));
            let control = ParticipantSqlControl {
                stop: Arc::clone(&stop),
                deadline: None,
            };
            let mut caller_budget = budget();
            caller_budget.max_candidates = candidate_count;
            let mut qualifier = AllowCurrent;
            let mut checks = 0;
            let mut cancelled = || {
                checks += 1;
                if checks > candidate_count {
                    stop.store(true, Ordering::Release);
                }
                false
            };
            let error = reauthorize_from_generation_snapshot(
                &snapshot,
                control,
                &mut caller_budget,
                &candidates,
                &complete_tuple(),
                &mut qualifier,
                &mut cancelled,
            )
            .expect_err("participant stop during pure traversal");
            assert_reason(&error, ValidationTerminationReason::Cancelled);
            assert_eq!(
                checks,
                candidate_count + 1,
                "participant cancellation must stop at the first pure traversal checkpoint"
            );
        }

        #[test]
        fn adapter_rejects_candidate_page_over_caller_limit_before_snapshot() {
            let (_state, snapshot) = workspace_snapshot();
            let candidates = vec![
                Candidate {
                    id: "candidate-1".into(),
                    root_attempt_id: "missing-1".into(),
                    adopted_input_ordinals: Vec::new(),
                },
                Candidate {
                    id: "candidate-2".into(),
                    root_attempt_id: "missing-2".into(),
                    adopted_input_ordinals: Vec::new(),
                },
            ];
            let mut caller_budget = budget();
            caller_budget.max_candidates = 1;
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            let error = reauthorize_from_generation_snapshot(
                &snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                &candidates,
                &complete_tuple(),
                &mut qualifier,
                &mut cancelled,
            )
            .expect_err("candidate page over caller limit");
            assert!(error
                .to_string()
                .contains("NIR1_GENERATION_HISTORY_CANDIDATE_LIMIT"));
        }

        #[test]
        fn missing_parent_receipt_does_not_abort_independent_snapshot_read() {
            let (_state, snapshot) = workspace_snapshot();
            let valid_attempt_id = storage_attempt(&snapshot);
            let mut caller_budget = budget();
            let outcome = with_generation_history_snapshot(
                &snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                |reader, shared_budget, _cancellation| {
                    let missing =
                        parent_receipt(reader, shared_budget, Some("missing-parent-receipt"))?;
                    assert!(missing.is_none());
                    Ok(reader.read_attempt(shared_budget, &valid_attempt_id)?.id)
                },
            )
            .expect("missing parent receipt is candidate-local");
            assert_eq!(outcome, valid_attempt_id);
        }

        const STORAGE_SCENE: &str = "generation-scene";

        fn raw_input() -> InputReference {
            InputReference {
                role: InputRole::Context,
                target: InputTarget::RawSource {
                    source_key: format!("project:scene:{STORAGE_SCENE}"),
                    revision_token: "v0@2026-10-11 00:00:00".into(),
                },
                input_use: InputUse::SelectedMaterial,
            }
        }

        /// The K4/3 section 3 row of a target-Scene Raw input, as stored.
        fn raw_rows() -> Vec<crate::nir1_generation::QualificationReference> {
            use crate::nir1_generation::QualificationReference as Row;
            let scope = |role, component: &str, version: &str| {
                Row::scope(
                    0,
                    role,
                    scope_identity(role, &[component]).expect("scope identity"),
                    version,
                )
            };
            vec![
                Row::present(
                    0,
                    QualificationKind::Source,
                    format!("project:scene:{STORAGE_SCENE}"),
                    "v0@2026-10-11 00:00:00",
                ),
                Row::not_applicable(
                    0,
                    QualificationKind::Revision,
                    NotApplicableReason::NotARevision,
                ),
                Row::not_applicable(
                    0,
                    QualificationKind::Decision,
                    NotApplicableReason::ManuscriptSource,
                ),
                Row::not_applicable(
                    0,
                    QualificationKind::Freshness,
                    NotApplicableReason::TargetSceneBodyNotADependency,
                ),
                Row::not_applicable(
                    0,
                    QualificationKind::Index,
                    NotApplicableReason::NotIndexDerived,
                ),
                scope(ScopeRole::QuerySceneScope, STORAGE_SCENE, "scope-token"),
                scope(
                    ScopeRole::QuerySceneIncarnation,
                    STORAGE_SCENE,
                    "incarnation-1",
                ),
                Row::present(0, QualificationKind::D1, "d1-selection", "d1-digest"),
            ]
        }

        fn read_snapshot_attempt(snapshot: &ActiveWorkspaceSnapshot, id: &str) -> AttemptSnapshot {
            let mut caller_budget = budget();
            with_generation_history_snapshot(
                snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                |reader, shared_budget, _cancellation| {
                    let stored = reader.read_attempt(shared_budget, id)?;
                    attempt(reader, shared_budget, &stored, false)
                },
            )
            .expect("snapshot attempt")
        }

        fn run_checker(attempt: AttemptSnapshot) -> CandidateDisposition {
            let mut attempt = attempt;
            attempt.tuple = Some(complete_tuple());
            let id = attempt.id.clone();
            let history = HistorySnapshot::from_attempts([attempt]).expect("unique attempt");
            let candidate = Candidate {
                id: "candidate".into(),
                root_attempt_id: id,
                adopted_input_ordinals: vec![0],
            };
            let mut ledger = HistoryBudget::new(8, 8, 32);
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            reauthorize_history(
                &history,
                &[candidate],
                &complete_tuple(),
                &mut ledger,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("history run")
            .candidates
            .remove(0)
            .disposition
        }

        #[test]
        fn adapter_maps_v2_rows_and_marks_v1_rows_incomplete() {
            let (_state, snapshot) = workspace_snapshot();
            // A version 2 attempt: present references keep their Scope role,
            // typed N/A rows arrive as N/A, and the shared rule accepts them.
            let v2_id = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            let mapped = read_snapshot_attempt(&snapshot, &v2_id);
            assert_eq!(mapped.reference_format, ReferenceFormat::V2);
            assert_eq!(mapped.target_scene_id.as_deref(), Some(STORAGE_SCENE));
            assert_eq!(mapped.inputs.len(), 1);
            let input = &mapped.inputs[0];
            assert_eq!(input.input_use, InputUse::SelectedMaterial);
            assert_eq!(input.qualifications.references.len(), 8);
            let na: Vec<_> = input
                .qualifications
                .references
                .iter()
                .filter_map(|reference| match &reference.body {
                    QualificationBody::NotApplicable { reason } => Some((reference.kind, *reason)),
                    QualificationBody::Present { .. } => None,
                })
                .collect();
            assert_eq!(
                na,
                vec![
                    (
                        QualificationKind::Revision,
                        NotApplicableReason::NotARevision
                    ),
                    (
                        QualificationKind::Decision,
                        NotApplicableReason::ManuscriptSource
                    ),
                    (
                        QualificationKind::Freshness,
                        NotApplicableReason::TargetSceneBodyNotADependency
                    ),
                    (
                        QualificationKind::Index,
                        NotApplicableReason::NotIndexDerived
                    ),
                ]
            );
            let roles: Vec<_> = input
                .qualifications
                .references
                .iter()
                .filter_map(|reference| match &reference.body {
                    QualificationBody::Present { scope_role, .. } => *scope_role,
                    QualificationBody::NotApplicable { .. } => None,
                })
                .collect();
            assert_eq!(
                roles,
                vec![ScopeRole::QuerySceneScope, ScopeRole::QuerySceneIncarnation]
            );
            assert_eq!(run_checker(mapped.clone()), CandidateDisposition::Qualified);

            // A version 1 attempt is read, carries no inputs, and is the
            // reason the candidate (and any descendant) is excluded.
            let v1_id = storage_attempt_with(
                &snapshot,
                vec![raw_input()],
                raw_rows().into_iter().take(1).collect(),
            );
            let legacy_input = json!({
                "role": raw_input().role,
                "target": raw_input().target,
            });
            let legacy_qualification = json!({
                "inputOrdinal": 0,
                "kind": "source",
                "identity": format!("project:scene:{STORAGE_SCENE}"),
                "version": "v0@2026-10-11 00:00:00",
            });
            let legacy_digest = grimodex_core::canonical_json_digest(&json!({
                "domain": "nir1-generation-inputs@1",
                "inputs": [legacy_input],
                "qualifications": [legacy_qualification],
            }))
            .expect("legacy digest");
            snapshot
                .db()
                .db()
                .with_conn(|conn| {
                    conn.execute(
                        "UPDATE nir1_generation_input_refs SET reference_json=?2 WHERE attempt_id=?1",
                        rusqlite::params![
                            v1_id,
                            grimodex_core::canonical_json_string(&legacy_input)?
                        ],
                    )?;
                    conn.execute(
                        "UPDATE nir1_generation_qualification_refs SET reference_json=?2 WHERE attempt_id=?1",
                        rusqlite::params![
                            v1_id,
                            grimodex_core::canonical_json_string(&legacy_qualification)?
                        ],
                    )?;
                    conn.execute(
                        "UPDATE nir1_generation_attempts SET input_digest=?2 WHERE id=?1",
                        rusqlite::params![v1_id, legacy_digest],
                    )?;
                    Ok(())
                })
                .expect("rewrite the rows as version 1");
            let legacy = read_snapshot_attempt(&snapshot, &v1_id);
            assert_eq!(legacy.reference_format, ReferenceFormat::LegacyV1);
            assert!(legacy.inputs.is_empty());
            let mut legacy_with_input = legacy.clone();
            // Even if a caller supplied an adoptable input, the format alone
            // excludes the attempt.
            legacy_with_input.inputs = mapped.inputs.clone();
            assert_eq!(
                run_checker(legacy_with_input),
                CandidateDisposition::Excluded(Failure::Incomplete(
                    IncompleteReason::LegacyReferenceFormat
                ))
            );
            assert_eq!(
                run_checker(legacy),
                CandidateDisposition::Excluded(Failure::Incomplete(
                    IncompleteReason::LegacyReferenceFormat
                ))
            );
        }
    }
}

#[allow(unused_imports)]
pub(crate) use generation_storage_adapter::reauthorize_from_generation_snapshot;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nir1_generation::scope_identity;

    struct AllowCurrent {
        pending_graph: bool,
    }

    impl CurrentQualifier for AllowCurrent {
        fn qualify_attempt(
            &mut self,
            _attempt: &AttemptSnapshot,
            _current: &HistoryTuple,
        ) -> QualificationStatus {
            QualificationStatus::Current
        }

        fn qualify_input(
            &mut self,
            _attempt: &AttemptSnapshot,
            _ordinal: usize,
            input: &HistoryInput,
            _current: &HistoryTuple,
        ) -> QualificationStatus {
            if self.pending_graph && matches!(&input.kind, HistoryInputKind::GraphEvidence { .. }) {
                QualificationStatus::Pending
            } else {
                QualificationStatus::Current
            }
        }
    }

    struct SharedLedger {
        nodes: usize,
        edges: usize,
        qualification_refs: usize,
    }

    impl HistoryBudgetLedger for SharedLedger {
        fn consume_node(&mut self) -> Result<(), Failure> {
            if self.nodes == 0 {
                return Err(Failure::incomplete(IncompleteReason::BudgetExhausted));
            }
            self.nodes -= 1;
            Ok(())
        }

        fn consume_edge(&mut self) -> Result<(), Failure> {
            if self.edges == 0 {
                return Err(Failure::incomplete(IncompleteReason::BudgetExhausted));
            }
            self.edges -= 1;
            Ok(())
        }

        fn consume_qualification_refs(&mut self, count: usize) -> Result<(), Failure> {
            if self.qualification_refs < count {
                return Err(Failure::incomplete(IncompleteReason::BudgetExhausted));
            }
            self.qualification_refs -= count;
            Ok(())
        }
    }

    fn tuple() -> HistoryTuple {
        let value = |suffix: &str| Some(format!("{suffix}:v1"));
        HistoryTuple {
            envelope: value("envelope"),
            revision_refs: vec!["revision:v1".into()],
            material: value("material"),
            scope: value("scope"),
            d1: value("d1"),
            scope_axes: ScopeAxes {
                reading_order: value("reading"),
                story_time: value("story"),
                viewpoint: value("viewpoint"),
                knowledge_holder: value("holder"),
                audience: value("audience"),
                timeline: value("timeline"),
                worldline: value("worldline"),
                narrative_layer: value("layer"),
                scene: value("scene"),
            },
            purpose: value("writing"),
            input_use: value("history"),
            send_classification: value("local"),
        }
    }

    const REVISION_SCOPE_ROLES: [ScopeRole; 6] = [
        ScopeRole::ProjectAuthority,
        ScopeRole::QuerySceneScope,
        ScopeRole::QuerySceneSource,
        ScopeRole::QuerySceneIncarnation,
        ScopeRole::RevealState,
        ScopeRole::ScopeAxis,
    ];

    /// The target Scene of every test attempt.
    const TARGET_SCENE: &str = "scene-q";

    fn scope_ref(role: ScopeRole) -> QualificationReference {
        let components: &[&str] = match role {
            ScopeRole::ProjectAuthority => &["project-1"],
            ScopeRole::TypedScope => &["revision-1", "0"],
            ScopeRole::MaterialSceneProof => &["anchor", "incarnation-a"],
            _ => &[TARGET_SCENE],
        };
        QualificationReference::scope(
            role,
            scope_identity(role, components).expect("scope identity"),
            format!("{role:?}:v1"),
        )
    }

    fn na(kind: QualificationKind, reason: NotApplicableReason) -> QualificationReference {
        QualificationReference::not_applicable(kind, reason)
    }

    fn present(kind: QualificationKind) -> QualificationReference {
        QualificationReference::present(kind, format!("{kind:?}:identity"), format!("{kind:?}:v1"))
    }

    /// A set that follows the K4/3 section 3 table for the input.
    fn qualifications_for(kind: &HistoryInputKind, input_use: InputUse) -> QualificationSet {
        use NotApplicableReason as Na;
        use QualificationKind as K;
        let d1 = if input_use == InputUse::CurrentTurn {
            na(K::D1, Na::FixedUserSlot)
        } else {
            QualificationReference::present(K::D1, "d1-selection", "d1:v1")
        };
        let references = match kind {
            HistoryInputKind::GeneratedMessage { .. } | HistoryInputKind::HumanMessage { .. } => {
                let decision = if matches!(kind, HistoryInputKind::HumanMessage { .. }) {
                    Na::HumanAuthored
                } else {
                    Na::DerivedFromParents
                };
                vec![
                    present(K::Source),
                    na(K::Revision, Na::NotARevision),
                    na(K::Decision, decision),
                    na(K::Freshness, Na::ImmutableMessageVersion),
                    na(K::Index, Na::NotIndexDerived),
                    scope_ref(ScopeRole::QuerySceneScope),
                    scope_ref(ScopeRole::QuerySceneIncarnation),
                    d1,
                ]
            }
            HistoryInputKind::RawSource { source_key, .. } => {
                let freshness = if *source_key == format!("project:scene:{TARGET_SCENE}") {
                    Na::TargetSceneBodyNotADependency
                } else {
                    Na::ExactSourceToken
                };
                vec![
                    present(K::Source),
                    na(K::Revision, Na::NotARevision),
                    na(K::Decision, Na::ManuscriptSource),
                    na(K::Freshness, freshness),
                    na(K::Index, Na::NotIndexDerived),
                    scope_ref(ScopeRole::QuerySceneScope),
                    scope_ref(ScopeRole::QuerySceneIncarnation),
                    d1,
                ]
            }
            // Revision, Graph-derived (Index is a reference there) and the
            // unsupported Artifact input.
            _ => {
                let index = if matches!(kind, HistoryInputKind::GraphEvidence { .. }) {
                    present(K::Index)
                } else {
                    na(K::Index, Na::NotIndexDerived)
                };
                let mut references = vec![
                    present(K::Source),
                    present(K::Revision),
                    present(K::Decision),
                    present(K::Freshness),
                    index,
                ];
                references.extend(REVISION_SCOPE_ROLES.map(scope_ref));
                references.push(d1);
                references
            }
        };
        QualificationSet { references }
    }

    fn history_input(kind: HistoryInputKind, input_use: InputUse) -> HistoryInput {
        let qualifications = qualifications_for(&kind, input_use);
        HistoryInput {
            kind,
            input_use,
            qualifications,
        }
    }

    fn receipt(attempt_id: &str, digest: &str, output_version_id: Option<&str>) -> TerminalReceipt {
        TerminalReceipt {
            attempt_id: attempt_id.into(),
            receipt_digest: digest.into(),
            successful: true,
            output_version_id: output_version_id.map(str::to_owned),
            payload_digest: None,
        }
    }

    fn generated(version_id: &str, parent_attempt_id: &str, receipt_digest: &str) -> HistoryInput {
        history_input(
            HistoryInputKind::GeneratedMessage {
                version_id: version_id.into(),
                parent_attempt_id: Some(parent_attempt_id.into()),
                receipt: Some(ReceiptRef {
                    attempt_id: parent_attempt_id.into(),
                    receipt_digest: receipt_digest.into(),
                }),
            },
            InputUse::AdoptedHistory,
        )
    }

    fn raw(source: &str) -> HistoryInput {
        history_input(
            HistoryInputKind::RawSource {
                source_key: source.into(),
                revision_token: "source:v1".into(),
            },
            InputUse::SelectedMaterial,
        )
    }

    fn artifact(
        artifact_id: &str,
        producer_attempt_id: Option<&str>,
        receipt_digest: Option<&str>,
    ) -> HistoryInput {
        history_input(
            HistoryInputKind::Artifact {
                artifact_id: artifact_id.into(),
                payload_digest: "sha256:artifact".into(),
                producer_attempt_id: producer_attempt_id.map(str::to_owned),
                receipt: receipt_digest.map(|receipt_digest| ReceiptRef {
                    attempt_id: producer_attempt_id.unwrap_or_default().into(),
                    receipt_digest: receipt_digest.into(),
                }),
            },
            InputUse::AdoptedHistory,
        )
    }

    fn attempt(
        id: &str,
        inputs: Vec<HistoryInput>,
        terminal: Option<TerminalReceipt>,
    ) -> AttemptSnapshot {
        AttemptSnapshot {
            id: id.into(),
            tuple: Some(tuple()),
            inputs,
            terminal,
            project_id: None,
            session_id: None,
            target_scene_id: Some(TARGET_SCENE.into()),
            reference_format: ReferenceFormat::V2,
        }
    }

    fn snapshot(attempts: Vec<AttemptSnapshot>) -> HistorySnapshot {
        HistorySnapshot::from_attempts(attempts).expect("unique attempt ids")
    }

    fn budget() -> HistoryBudget {
        HistoryBudget::new(32, 32, 128)
    }

    #[test]
    fn traversal_debits_the_caller_owned_shared_ledger() {
        let input = raw("source");
        let rows = input.qualifications.references.len();
        let graph = snapshot(vec![attempt("root", vec![input], None)]);
        let candidate = Candidate {
            id: "shared-ledger".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut ledger = SharedLedger {
            nodes: 1,
            edges: 1,
            qualification_refs: rows,
        };
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut ledger,
            &mut current,
            &mut cancelled,
        )
        .expect("shared ledger should cover one root and one input");

        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Qualified
        );
        assert_eq!(ledger.nodes, 0);
        assert_eq!(ledger.edges, 0);
        assert_eq!(ledger.qualification_refs, 0);
    }

    #[test]
    fn traverses_all_selected_ancestors_and_excludes_sibling_branch() {
        let graph = snapshot(vec![
            attempt(
                "root",
                vec![
                    generated("m1", "mid", "receipt-mid"),
                    generated("sibling", "sibling", "receipt-sibling"),
                ],
                None,
            ),
            attempt(
                "mid",
                vec![raw("source-x")],
                Some(receipt("mid", "receipt-mid", Some("m1"))),
            ),
            attempt(
                "sibling",
                vec![raw("source-y")],
                Some(receipt("sibling", "receipt-sibling", Some("sibling"))),
            ),
        ]);
        let candidates = [Candidate {
            id: "root-history".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        }];
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &candidates,
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert_eq!(outcome.candidates.len(), 1);
        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Qualified
        );
        assert_eq!(
            outcome.candidates[0].visited_attempts,
            vec!["root".to_string(), "mid".to_string()]
        );
        assert!(!outcome.candidates[0]
            .visited_attempts
            .contains(&"sibling".to_string()));
    }

    #[test]
    fn independent_candidate_survives_missing_parent_in_other_branch() {
        let graph = snapshot(vec![
            attempt(
                "bad",
                vec![generated("missing", "absent", "receipt-absent")],
                None,
            ),
            attempt("good", vec![raw("source-good")], None),
        ]);
        let candidates = [
            Candidate {
                id: "bad-candidate".into(),
                root_attempt_id: "bad".into(),
                adopted_input_ordinals: vec![0],
            },
            Candidate {
                id: "good-candidate".into(),
                root_attempt_id: "good".into(),
                adopted_input_ordinals: vec![0],
            },
        ];
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &candidates,
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::MissingParent(_)))
        ));
        assert_eq!(
            outcome.candidates[1].disposition,
            CandidateDisposition::Qualified
        );
    }

    #[test]
    fn missing_qualification_is_incomplete_and_not_safe_by_default() {
        let mut source = raw("source");
        source.qualifications.references.pop();
        let graph = snapshot(vec![attempt("root", vec![source], None)]);
        let candidate = Candidate {
            id: "candidate".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(
                IncompleteReason::MissingQualification(QualificationKind::D1)
            ))
        ));
    }

    #[test]
    fn cycle_is_incomplete_and_does_not_assume_the_remaining_path_is_safe() {
        let graph = snapshot(vec![
            attempt(
                "a",
                vec![generated("b-output", "b", "receipt-b")],
                Some(receipt("a", "receipt-a", Some("a-output"))),
            ),
            attempt(
                "b",
                vec![generated("a-output", "a", "receipt-a")],
                Some(receipt("b", "receipt-b", Some("b-output"))),
            ),
        ]);
        let candidate = Candidate {
            id: "cycle".into(),
            root_attempt_id: "a".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::Cycle(_)))
        ));
    }

    #[test]
    fn graph_pending_is_not_treated_as_current_index_qualification() {
        let graph_input = history_input(
            HistoryInputKind::GraphEvidence {
                evidence_ref: "evidence".into(),
                source_key: "source".into(),
                revision_token: "source:v1".into(),
            },
            InputUse::SelectedMaterial,
        );
        let graph = snapshot(vec![attempt("root", vec![graph_input], None)]);
        let candidate = Candidate {
            id: "graph".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: true,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::PendingAuthority))
        );
    }

    #[test]
    fn missing_full_tuple_fails_closed_before_input_adoption() {
        let mut root = attempt("root", vec![raw("source")], None);
        root.tuple = None;
        let graph = snapshot(vec![root]);
        let candidate = Candidate {
            id: "missing-tuple".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(
                IncompleteReason::CurrentTupleUnavailable
            ))
        );
    }

    #[test]
    fn artifact_without_existing_producer_receipt_is_unsupported() {
        let graph = snapshot(vec![attempt(
            "root",
            vec![artifact("artifact", None, None)],
            None,
        )]);
        let candidate = Candidate {
            id: "artifact".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        // Artifact is unsupported (K4/3 section 3): the candidate is excluded
        // by the completeness rule before any producer lineage is looked at.
        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(
                IncompleteReason::QualificationRule(CompletenessViolation {
                    input_ordinal: Some(0),
                    kind: None,
                    scope_role: None,
                    reason: CompletenessReason::UnsupportedInput,
                })
            ))
        );
    }

    #[test]
    fn artifact_with_a_mismatching_producer_receipt_is_still_unsupported() {
        let mut producer_terminal = receipt("producer", "receipt-producer", None);
        producer_terminal.payload_digest = Some("sha256:other".into());
        let graph = snapshot(vec![
            attempt(
                "root",
                vec![artifact(
                    "artifact",
                    Some("producer"),
                    Some("receipt-producer"),
                )],
                None,
            ),
            attempt("producer", vec![raw("source")], Some(producer_terminal)),
        ]);
        let candidate = Candidate {
            id: "artifact-mismatch".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        // A producer receipt whose payload differs is irrelevant: Artifact is
        // unsupported and never reaches the lineage check.
        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(
                IncompleteReason::QualificationRule(CompletenessViolation {
                    reason: CompletenessReason::UnsupportedInput,
                    ..
                })
            ))
        ));
    }

    #[test]
    fn parent_attempt_binding_must_match_the_child_scope() {
        let mut root = attempt(
            "root",
            vec![generated("message:v1", "parent", "receipt-parent")],
            None,
        );
        root.project_id = Some("project-a".into());
        root.session_id = Some("session-a".into());
        let mut parent = attempt(
            "parent",
            vec![raw("source")],
            Some(receipt("parent", "receipt-parent", Some("message:v1"))),
        );
        parent.project_id = Some("project-b".into());
        parent.session_id = Some("session-b".into());
        let graph = snapshot(vec![root, parent]);
        let candidate = Candidate {
            id: "cross-scope-parent".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::ReceiptMismatch(
                _
            )))
        ));
    }

    #[test]
    fn explicit_current_human_input_uses_its_separate_binding_path() {
        let human = history_input(
            HistoryInputKind::HumanMessage {
                version_id: "human:v1".into(),
                explicitly_bound: true,
            },
            InputUse::CurrentTurn,
        );
        let graph = snapshot(vec![attempt("root", vec![human], None)]);
        let candidate = Candidate {
            id: "current-human".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Qualified
        );
    }

    #[test]
    fn invalid_message_binding_is_excluded() {
        let input = HistoryInput {
            kind: HistoryInputKind::InvalidMessageBinding {
                version_id: "message:v1".into(),
            },
            input_use: InputUse::AdoptedHistory,
            qualifications: QualificationSet::default(),
        };
        let graph = snapshot(vec![attempt("root", vec![input], None)]);
        let candidate = Candidate {
            id: "invalid-binding".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::InvalidReference))
        );
    }

    #[test]
    fn tuple_mismatch_and_unbound_legacy_message_fail_closed() {
        let mut stale = attempt("stale", vec![raw("source")], None);
        stale.tuple.as_mut().unwrap().scope = Some("old-scope:v0".into());
        let legacy = history_input(
            HistoryInputKind::HumanMessage {
                version_id: "legacy".into(),
                explicitly_bound: false,
            },
            InputUse::AdoptedHistory,
        );
        let graph = snapshot(vec![stale, attempt("legacy-root", vec![legacy], None)]);
        let candidates = [
            Candidate {
                id: "stale".into(),
                root_attempt_id: "stale".into(),
                adopted_input_ordinals: vec![0],
            },
            Candidate {
                id: "legacy".into(),
                root_attempt_id: "legacy-root".into(),
                adopted_input_ordinals: vec![0],
            },
        ];
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &candidates,
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Ineligible(IneligibleReason::TupleMismatch(_)))
        ));
        assert!(matches!(
            outcome.candidates[1].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::LegacyMessage))
        ));
    }

    #[test]
    fn shared_budget_is_not_reset_for_each_candidate() {
        let graph = snapshot(vec![
            attempt("a", vec![raw("source-a")], None),
            attempt("b", vec![raw("source-b")], None),
        ]);
        let candidates = [
            Candidate {
                id: "a".into(),
                root_attempt_id: "a".into(),
                adopted_input_ordinals: vec![0],
            },
            Candidate {
                id: "b".into(),
                root_attempt_id: "b".into(),
                adopted_input_ordinals: vec![0],
            },
        ];
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = HistoryBudget::new(1, 4, 16);
        let mut cancelled = || false;
        let run = reauthorize_history(
            &graph,
            &candidates,
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        );

        assert_eq!(run, Err(HistoryRunError::BudgetExhausted));
    }

    #[test]
    fn cancellation_stops_the_whole_turn_without_partial_qualified_results() {
        let graph = snapshot(vec![
            attempt("first", vec![raw("source-first")], None),
            attempt("second", vec![raw("source-second")], None),
        ]);
        let candidates = [
            Candidate {
                id: "first".into(),
                root_attempt_id: "first".into(),
                adopted_input_ordinals: vec![0],
            },
            Candidate {
                id: "second".into(),
                root_attempt_id: "second".into(),
                adopted_input_ordinals: vec![0],
            },
        ];
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut checks = 0;
        let mut cancelled = || {
            checks += 1;
            checks > 3
        };
        let run = reauthorize_history(
            &graph,
            &candidates,
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        );

        assert_eq!(run, Err(HistoryRunError::Cancelled));
    }

    // ---- the completeness rule (K4/3 section 3), checker side ----

    const ALL_KINDS: [QualificationKind; 7] = [
        QualificationKind::Source,
        QualificationKind::Revision,
        QualificationKind::Decision,
        QualificationKind::Freshness,
        QualificationKind::Index,
        QualificationKind::Scope,
        QualificationKind::D1,
    ];

    fn current_human() -> HistoryInput {
        history_input(
            HistoryInputKind::HumanMessage {
                version_id: "human:v1".into(),
                explicitly_bound: true,
            },
            InputUse::CurrentTurn,
        )
    }

    fn target_raw() -> HistoryInput {
        raw(&format!("project:scene:{TARGET_SCENE}"))
    }

    fn revision_input() -> HistoryInput {
        history_input(
            HistoryInputKind::AcceptedRevision {
                revision_id: "revision-1".into(),
                bundle_digest: "bundle:v1".into(),
            },
            InputUse::SelectedMaterial,
        )
    }

    fn graph_input() -> HistoryInput {
        history_input(
            HistoryInputKind::GraphEvidence {
                evidence_ref: "evidence".into(),
                source_key: "source".into(),
                revision_token: "source:v1".into(),
            },
            InputUse::SelectedMaterial,
        )
    }

    fn disposition_of_attempt(root: AttemptSnapshot) -> CandidateDisposition {
        let graph = snapshot(vec![root]);
        let candidate = Candidate {
            id: "candidate".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete")
        .candidates
        .remove(0)
        .disposition
    }

    fn disposition(input: HistoryInput) -> CandidateDisposition {
        disposition_of_attempt(attempt("root", vec![input], None))
    }

    fn excluded(reason: IncompleteReason) -> CandidateDisposition {
        CandidateDisposition::Excluded(Failure::Incomplete(reason))
    }

    fn rule(
        reason: CompletenessReason,
        kind: Option<QualificationKind>,
        scope_role: Option<ScopeRole>,
    ) -> CandidateDisposition {
        excluded(IncompleteReason::QualificationRule(CompletenessViolation {
            input_ordinal: Some(0),
            kind,
            scope_role,
            reason,
        }))
    }

    fn without_kind(mut input: HistoryInput, kind: QualificationKind) -> HistoryInput {
        input
            .qualifications
            .references
            .retain(|reference| reference.kind != kind);
        input
    }

    fn replace_kind(
        mut input: HistoryInput,
        kind: QualificationKind,
        replacement: QualificationReference,
    ) -> HistoryInput {
        input = without_kind(input, kind);
        input.qualifications.references.push(replacement);
        input
    }

    fn every_table_input() -> Vec<(&'static str, HistoryInput)> {
        vec![
            ("current human", current_human()),
            (
                "past human",
                history_input(
                    HistoryInputKind::HumanMessage {
                        version_id: "past:v1".into(),
                        explicitly_bound: true,
                    },
                    InputUse::AdoptedHistory,
                ),
            ),
            ("target raw", target_raw()),
            ("other raw", raw("source")),
            ("revision", revision_input()),
            ("graph", graph_input()),
        ]
    }

    #[test]
    fn checker_accepts_complete_set_with_na() {
        for (name, input) in every_table_input() {
            let has_na =
                input.qualifications.references.iter().any(|reference| {
                    matches!(reference.body, QualificationBody::NotApplicable { .. })
                });
            assert!(
                has_na || name == "graph",
                "{name} exercises the typed N/A path"
            );
            assert_eq!(
                disposition(input),
                CandidateDisposition::Qualified,
                "{name}"
            );
        }
        // A generated output follows its table row through the parent chain.
        let graph = snapshot(vec![
            attempt(
                "root",
                vec![generated("m1", "parent", "receipt-parent")],
                None,
            ),
            attempt(
                "parent",
                vec![raw("source")],
                Some(receipt("parent", "receipt-parent", Some("m1"))),
            ),
        ]);
        let candidate = Candidate {
            id: "generated".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");
        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Qualified
        );
        // Several Source and typed-scope references stay complete: the rule
        // accepts one or more references per kind.
        let mut many = revision_input();
        for index in 0..3 {
            many.qualifications
                .references
                .push(QualificationReference::present(
                    QualificationKind::Source,
                    format!("evidence:e{index}"),
                    "token",
                ));
            many.qualifications
                .references
                .push(QualificationReference::scope(
                    ScopeRole::TypedScope,
                    scope_identity(ScopeRole::TypedScope, &["revision-1", &index.to_string()])
                        .expect("typed scope identity"),
                    "typed:v1",
                ));
        }
        assert_eq!(disposition(many), CandidateDisposition::Qualified);
    }

    #[test]
    fn checker_rejects_missing_kind_for_every_table_row() {
        for (name, input) in every_table_input() {
            for kind in ALL_KINDS {
                assert_eq!(
                    disposition(without_kind(input.clone(), kind)),
                    excluded(IncompleteReason::MissingQualification(kind)),
                    "{name} without {kind:?}"
                );
            }
            assert_eq!(
                disposition(HistoryInput {
                    qualifications: QualificationSet::default(),
                    ..input
                }),
                excluded(IncompleteReason::MissingQualification(
                    QualificationKind::Source
                )),
                "{name} with no rows"
            );
        }
        // Dropping one of the required Scope roles leaves the kind present
        // but the role missing.
        let mut revision = revision_input();
        revision.qualifications.references.retain(|reference| {
            !matches!(
                reference.body,
                QualificationBody::Present {
                    scope_role: Some(ScopeRole::RevealState),
                    ..
                }
            )
        });
        assert_eq!(
            disposition(revision),
            rule(
                CompletenessReason::ScopeRoleMissing,
                Some(QualificationKind::Scope),
                Some(ScopeRole::RevealState)
            )
        );
    }

    #[test]
    fn checker_rejects_duplicate_kind_target() {
        for version in ["same-version", "another-version"] {
            let mut input = revision_input();
            input
                .qualifications
                .references
                .push(QualificationReference::present(
                    QualificationKind::Source,
                    "Source:identity",
                    version,
                ));
            assert_eq!(
                disposition(input),
                excluded(IncompleteReason::DuplicateQualification(
                    QualificationKind::Source
                )),
                "the same target with version {version}"
            );
        }
        let mut input = target_raw();
        input.qualifications.references.push(na(
            QualificationKind::Revision,
            NotApplicableReason::NotARevision,
        ));
        assert_eq!(
            disposition(input),
            excluded(IncompleteReason::DuplicateQualification(
                QualificationKind::Revision
            ))
        );
        let mut input = revision_input();
        let duplicate = scope_ref(ScopeRole::RevealState);
        input.qualifications.references.push(duplicate);
        assert_eq!(
            disposition(input),
            excluded(IncompleteReason::DuplicateQualification(
                QualificationKind::Scope
            ))
        );
    }

    #[test]
    fn checker_rejects_forged_na() {
        use NotApplicableReason as Na;
        use QualificationKind as K;
        // A cell that requires a reference cannot be declared not applicable.
        assert_eq!(
            disposition(replace_kind(
                revision_input(),
                K::Source,
                na(K::Source, Na::ExactSourceToken)
            )),
            rule(
                CompletenessReason::NotApplicableNotInTable,
                Some(K::Source),
                None
            )
        );
        // A reason the table does not give to this input.
        assert_eq!(
            disposition(replace_kind(
                current_human(),
                K::Decision,
                na(K::Decision, Na::DerivedFromParents)
            )),
            rule(
                CompletenessReason::NotApplicableNotInTable,
                Some(K::Decision),
                None
            )
        );
        // Graph-derived input needs an Index reference; N/A is not allowed.
        assert_eq!(
            disposition(replace_kind(
                graph_input(),
                K::Index,
                na(K::Index, Na::NotIndexDerived)
            )),
            rule(
                CompletenessReason::NotApplicableNotInTable,
                Some(K::Index),
                None
            )
        );
        // The Raw Freshness reason follows the source key, both ways.
        assert_eq!(
            disposition(replace_kind(
                target_raw(),
                K::Freshness,
                na(K::Freshness, Na::ExactSourceToken)
            )),
            rule(
                CompletenessReason::NotApplicableReasonMismatch,
                Some(K::Freshness),
                None
            )
        );
        assert_eq!(
            disposition(replace_kind(
                raw("source"),
                K::Freshness,
                na(K::Freshness, Na::TargetSceneBodyNotADependency)
            )),
            rule(
                CompletenessReason::NotApplicableReasonMismatch,
                Some(K::Freshness),
                None
            )
        );
        // A reference where the table puts a typed N/A.
        assert_eq!(
            disposition(replace_kind(
                current_human(),
                K::D1,
                QualificationReference::present(K::D1, "d1-selection", "d1:v1")
            )),
            rule(CompletenessReason::ReferenceNotInTable, Some(K::D1), None)
        );
        // An N/A on an Artifact input does not make it supported.
        assert_eq!(
            disposition(artifact("artifact", None, None)),
            rule(CompletenessReason::UnsupportedInput, None, None)
        );
    }

    #[test]
    fn checker_rejects_ref_and_na_together() {
        use NotApplicableReason as Na;
        use QualificationKind as K;
        let mut revision = revision_input();
        revision
            .qualifications
            .references
            .push(na(K::Revision, Na::NotARevision));
        assert_eq!(
            disposition(revision),
            rule(
                CompletenessReason::ReferenceAndNotApplicable,
                Some(K::Revision),
                None
            )
        );
        let mut human = current_human();
        human.qualifications.references.push(present(K::Revision));
        assert_eq!(
            disposition(human),
            rule(
                CompletenessReason::ReferenceAndNotApplicable,
                Some(K::Revision),
                None
            )
        );
    }

    #[test]
    fn checker_rejects_target_pair_collision() {
        // Two typed targets whose joined strings would collide if the IDs were
        // not escaped are two different targets.
        let mut input = revision_input();
        for components in [["a:b", "c"], ["a", "b:c"]] {
            input
                .qualifications
                .references
                .push(QualificationReference::scope(
                    ScopeRole::TypedScope,
                    scope_identity(ScopeRole::TypedScope, &components).expect("identity"),
                    "typed:v1",
                ));
        }
        assert_eq!(disposition(input), CandidateDisposition::Qualified);
        // An identity that was joined without escaping does not follow its role.
        let mut forged = revision_input();
        forged
            .qualifications
            .references
            .push(QualificationReference::scope(
                ScopeRole::TypedScope,
                "revision:a:b:typed-scope:c",
                "typed:v1",
            ));
        assert_eq!(
            disposition(forged),
            rule(
                CompletenessReason::MalformedTarget,
                Some(QualificationKind::Scope),
                Some(ScopeRole::TypedScope)
            )
        );
        // The same typed target twice is a duplicate whatever the version.
        let mut twice = revision_input();
        for version in ["typed:v1", "typed:v2"] {
            twice
                .qualifications
                .references
                .push(QualificationReference::scope(
                    ScopeRole::TypedScope,
                    scope_identity(ScopeRole::TypedScope, &["a:b", "c"]).expect("identity"),
                    version,
                ));
        }
        assert_eq!(
            disposition(twice),
            excluded(IncompleteReason::DuplicateQualification(
                QualificationKind::Scope
            ))
        );
        // A query-Scene role that names another Scene is rejected.
        let other_scene = replace_scope_role(
            current_human(),
            ScopeRole::QuerySceneScope,
            scope_identity(ScopeRole::QuerySceneScope, &["another-scene"]).expect("identity"),
        );
        assert_eq!(
            disposition(other_scene),
            rule(
                CompletenessReason::ScopeSceneMismatch,
                Some(QualificationKind::Scope),
                Some(ScopeRole::QuerySceneScope)
            )
        );
    }

    fn replace_scope_role(
        mut input: HistoryInput,
        role: ScopeRole,
        identity: String,
    ) -> HistoryInput {
        for reference in &mut input.qualifications.references {
            if let QualificationBody::Present {
                identity: current,
                scope_role: Some(current_role),
                ..
            } = &mut reference.body
            {
                if *current_role == role {
                    *current = identity.clone();
                }
            }
        }
        input
    }

    #[test]
    fn explicit_human_no_longer_skips_completeness() {
        // The exemption for an explicitly bound Human is gone: with no rows,
        // or with one kind missing, the candidate is excluded.
        let bare = HistoryInput {
            qualifications: QualificationSet::default(),
            ..current_human()
        };
        assert_eq!(
            disposition(bare),
            excluded(IncompleteReason::MissingQualification(
                QualificationKind::Source
            ))
        );
        for kind in ALL_KINDS {
            assert_eq!(
                disposition(without_kind(current_human(), kind)),
                excluded(IncompleteReason::MissingQualification(kind)),
                "{kind:?}"
            );
        }
        // The qualification rows are also debited from the shared ledger.
        let human = current_human();
        let rows = human.qualifications.references.len();
        let graph = snapshot(vec![attempt("root", vec![human], None)]);
        let candidate = Candidate {
            id: "human".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut ledger = SharedLedger {
            nodes: 1,
            edges: 1,
            qualification_refs: rows,
        };
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &tuple(),
            &mut ledger,
            &mut current,
            &mut cancelled,
        )
        .expect("the ledger covers the Human rows");
        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Qualified
        );
        assert_eq!(ledger.qualification_refs, 0);
    }

    #[test]
    fn checker_excludes_version_1_attempt_and_its_descendants() {
        let mut legacy_parent = attempt(
            "parent",
            Vec::new(),
            Some(receipt("parent", "receipt-parent", Some("m1"))),
        );
        legacy_parent.reference_format = ReferenceFormat::LegacyV1;
        let graph = snapshot(vec![
            attempt(
                "child",
                vec![generated("m1", "parent", "receipt-parent")],
                None,
            ),
            legacy_parent,
            attempt("independent", vec![raw("source")], None),
        ]);
        let candidates = [
            Candidate {
                id: "child".into(),
                root_attempt_id: "child".into(),
                adopted_input_ordinals: vec![0],
            },
            Candidate {
                id: "parent".into(),
                root_attempt_id: "parent".into(),
                adopted_input_ordinals: vec![0],
            },
            Candidate {
                id: "independent".into(),
                root_attempt_id: "independent".into(),
                adopted_input_ordinals: vec![0],
            },
        ];
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &candidates,
            &tuple(),
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("the turn is not stopped");
        assert_eq!(
            outcome.candidates[0].disposition,
            excluded(IncompleteReason::LegacyReferenceFormat),
            "a descendant of a version 1 attempt"
        );
        assert_eq!(
            outcome.candidates[1].disposition,
            excluded(IncompleteReason::LegacyReferenceFormat)
        );
        assert_eq!(
            outcome.candidates[2].disposition,
            CandidateDisposition::Qualified,
            "an independent candidate survives"
        );
    }

    #[test]
    fn checker_fails_closed_without_a_target_scene() {
        let mut root = attempt("root", vec![raw("source")], None);
        root.target_scene_id = None;
        assert_eq!(
            disposition_of_attempt(root),
            excluded(IncompleteReason::TargetSceneUnavailable)
        );
    }

    #[test]
    fn checker_input_use_selects_the_table_row() {
        // The same Human message is a different row as current-turn (D1 N/A)
        // and as adopted-history (D1 reference).
        let past = HistoryInput {
            input_use: InputUse::AdoptedHistory,
            ..current_human()
        };
        assert_eq!(
            disposition(past),
            rule(
                CompletenessReason::NotApplicableNotInTable,
                Some(QualificationKind::D1),
                None
            )
        );
        let current = HistoryInput {
            input_use: InputUse::CurrentTurn,
            qualifications: qualifications_for(&current_human().kind, InputUse::AdoptedHistory),
            ..current_human()
        };
        assert_eq!(
            disposition(current),
            rule(
                CompletenessReason::ReferenceNotInTable,
                Some(QualificationKind::D1),
                None
            )
        );
    }
}
