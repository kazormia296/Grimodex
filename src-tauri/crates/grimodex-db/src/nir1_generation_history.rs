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

/// The seven qualification kinds already present in D2b storage.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum QualificationKind {
    Source,
    Revision,
    Decision,
    Freshness,
    Index,
    Scope,
    D1,
}

const REQUIRED_QUALIFICATIONS: [QualificationKind; 7] = [
    QualificationKind::Source,
    QualificationKind::Revision,
    QualificationKind::Decision,
    QualificationKind::Freshness,
    QualificationKind::Index,
    QualificationKind::Scope,
    QualificationKind::D1,
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualificationReference {
    pub kind: QualificationKind,
    pub identity: OpaqueRef,
    pub version: OpaqueRef,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct QualificationSet {
    pub references: Vec<QualificationReference>,
}

impl QualificationSet {
    fn validate_complete(&self) -> Result<(), Failure> {
        let mut seen = BTreeSet::new();
        for reference in &self.references {
            if reference.identity.trim() != reference.identity
                || reference.identity.is_empty()
                || reference.version.trim() != reference.version
                || reference.version.is_empty()
            {
                return Err(Failure::incomplete(IncompleteReason::InvalidQualification));
            }
            if !seen.insert(reference.kind) {
                return Err(Failure::incomplete(
                    IncompleteReason::DuplicateQualification(reference.kind),
                ));
            }
        }
        for kind in REQUIRED_QUALIFICATIONS {
            if !seen.contains(&kind) {
                return Err(Failure::incomplete(IncompleteReason::MissingQualification(
                    kind,
                )));
            }
        }
        Ok(())
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
    pub qualifications: QualificationSet,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttemptSnapshot {
    pub id: AttemptId,
    pub tuple: Option<HistoryTuple>,
    pub inputs: Vec<HistoryInput>,
    pub terminal: Option<TerminalReceipt>,
    pub project_id: Option<OpaqueRef>,
    pub session_id: Option<OpaqueRef>,
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
    DuplicateQualification(QualificationKind),
    MissingQualification(QualificationKind),
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
        let direct_human = matches!(
            input.kind,
            HistoryInputKind::HumanMessage {
                explicitly_bound: true,
                ..
            }
        );
        if !direct_human {
            self.budget
                .consume_qualification_refs(input.qualifications.references.len())?;
            input.qualifications.validate_complete()?;
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
        InputTarget, MessageOrigin, QualificationKind as StoredKind, StoredAttempt, StoredTerminal,
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

    fn qualification_kind(kind: &StoredKind) -> QualificationKind {
        match kind {
            StoredKind::Source => QualificationKind::Source,
            StoredKind::Revision => QualificationKind::Revision,
            StoredKind::Decision => QualificationKind::Decision,
            StoredKind::Freshness => QualificationKind::Freshness,
            StoredKind::Index => QualificationKind::Index,
            StoredKind::Scope => QualificationKind::Scope,
            StoredKind::D1 => QualificationKind::D1,
        }
    }

    fn qualifications(attempt: &StoredAttempt, ordinal: usize) -> QualificationSet {
        QualificationSet {
            references: attempt
                .qualifications
                .iter()
                .filter(|reference| reference.input_ordinal == ordinal)
                .map(|reference| QualificationReference {
                    kind: qualification_kind(&reference.kind),
                    identity: reference.identity.clone(),
                    version: reference.version.clone(),
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
                        && message.version.session_id == attempt.binding.session_id
                        && message.version.parent_attempt_id.as_ref() == parent_attempt_id.as_ref()
                        && origin_shape_matches
                        && role_matches
                });
                if resolve_lineage && message.is_some() && !binding_matches {
                    return Ok(HistoryInput {
                        kind: HistoryInputKind::InvalidMessageBinding {
                            version_id: version_id.clone(),
                        },
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
            qualifications,
        })
    }

    fn attempt(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        stored: &StoredAttempt,
        resolve_lineage: bool,
    ) -> Result<AttemptSnapshot> {
        // AttemptBinding currently exposes only digests and purpose, not the
        // confirmed full history tuple. Do not reconstruct Scope axes here.
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
            session_id: Some(stored.binding.session_id.clone()),
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
            create_attempt, AttemptBinding, GenerationPurpose, NewAttempt, ReadBudget,
        };
        use crate::recovery::SafeModeState;
        use crate::state::{
            active_workspace_snapshot, ActiveWorkspace, ActiveWorkspaceSnapshot,
            WorkspaceAuthority, WorkspaceState,
        };
        use crate::workspace_lifecycle::{LiveBinding, WorkspaceLifecycleCompatibilityView};
        use crate::Database;
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
                max_candidates: 8,
                max_reference_count: 16,
                max_reference_bytes: 16_384,
                max_resolved_body_bytes: 16_384,
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
                open_lock: Mutex::new(()),
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
            let db = snapshot.db().db();
            db.with_conn(|connection| {
                connection.execute(
                    "INSERT OR IGNORE INTO projects(id,title) VALUES ('generation-project','Project')",
                    [],
                )?;
                connection.execute(
                    "INSERT OR IGNORE INTO chat_sessions(id,project_id) VALUES ('generation-session','generation-project')",
                    [],
                )?;
                Ok(())
            })
            .expect("generation fixture");
            let digest = format!("sha256:{}", "0".repeat(64));
            create_attempt(
                db,
                NewAttempt {
                    binding: AttemptBinding {
                        project_id: "generation-project".into(),
                        session_id: "generation-session".into(),
                        profile_id: "profile".into(),
                        caller_id: "caller".into(),
                        caller_epoch: 1,
                        workspace_binding_digest: digest.clone(),
                        purpose: GenerationPurpose::Writing,
                        scope_digest: digest.clone(),
                        material_digest: digest.clone(),
                        d1_digest: digest.clone(),
                        route_revision: "route".into(),
                        provider: "local".into(),
                        model: "test".into(),
                        api: "chat".into(),
                        endpoint_identity: digest.clone(),
                    },
                    payload_digest: digest,
                    inputs: Vec::new(),
                    qualifications: Vec::new(),
                    created_at_ms: 1,
                    expires_at_ms: 2,
                    budget: ReadBudget {
                        max_references: 8,
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
    }
}

#[allow(unused_imports)]
pub(crate) use generation_storage_adapter::reauthorize_from_generation_snapshot;

#[cfg(test)]
mod tests {
    use super::*;

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

    fn qualifications() -> QualificationSet {
        QualificationSet {
            references: REQUIRED_QUALIFICATIONS
                .into_iter()
                .map(|kind| QualificationReference {
                    kind,
                    identity: format!("{kind:?}:identity"),
                    version: format!("{kind:?}:v1"),
                })
                .collect(),
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
        HistoryInput {
            kind: HistoryInputKind::GeneratedMessage {
                version_id: version_id.into(),
                parent_attempt_id: Some(parent_attempt_id.into()),
                receipt: Some(ReceiptRef {
                    attempt_id: parent_attempt_id.into(),
                    receipt_digest: receipt_digest.into(),
                }),
            },
            qualifications: qualifications(),
        }
    }

    fn raw(source: &str) -> HistoryInput {
        HistoryInput {
            kind: HistoryInputKind::RawSource {
                source_key: source.into(),
                revision_token: "source:v1".into(),
            },
            qualifications: qualifications(),
        }
    }

    fn artifact(
        artifact_id: &str,
        producer_attempt_id: Option<&str>,
        receipt_digest: Option<&str>,
    ) -> HistoryInput {
        HistoryInput {
            kind: HistoryInputKind::Artifact {
                artifact_id: artifact_id.into(),
                payload_digest: "sha256:artifact".into(),
                producer_attempt_id: producer_attempt_id.map(str::to_owned),
                receipt: receipt_digest.map(|receipt_digest| ReceiptRef {
                    attempt_id: producer_attempt_id.unwrap_or_default().into(),
                    receipt_digest: receipt_digest.into(),
                }),
            },
            qualifications: qualifications(),
        }
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
        let graph = snapshot(vec![attempt("root", vec![raw("source")], None)]);
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
            qualification_refs: 7,
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
        let graph_input = HistoryInput {
            kind: HistoryInputKind::GraphEvidence {
                evidence_ref: "evidence".into(),
                source_key: "source".into(),
                revision_token: "source:v1".into(),
            },
            qualifications: qualifications(),
        };
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
    fn artifact_without_existing_producer_receipt_cannot_create_lineage() {
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

        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::MissingParent(
                String::new()
            )))
        );
    }

    #[test]
    fn artifact_payload_must_match_the_producer_terminal() {
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

        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::ReceiptMismatch(
                _
            )))
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
        let human = HistoryInput {
            kind: HistoryInputKind::HumanMessage {
                version_id: "human:v1".into(),
                explicitly_bound: true,
            },
            qualifications: QualificationSet::default(),
        };
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
            qualifications: qualifications(),
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
        let legacy = HistoryInput {
            kind: HistoryInputKind::HumanMessage {
                version_id: "legacy".into(),
                explicitly_bound: false,
            },
            qualifications: qualifications(),
        };
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
}
