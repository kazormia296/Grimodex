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

use crate::nir1_generation::history_context::{
    DurableWorkspaceIdentity, HistoryAxes, HistoryAxis, HistoryContextGateReason,
    HistoryContextSlot, HistoryD1Selection, HistoryRestoreEpoch, HistorySendClassification,
    HistoryTargetScope, HistoryUnavailableReason, HISTORY_ELIGIBILITY_WINDOW_MS,
};
pub(crate) use crate::nir1_generation::history_reads::HistoryCaptureState;
use crate::nir1_generation::{
    check_input_completeness, CompletenessContext, GenerationPurpose, InputReference, InputRole,
    InputTarget, QualificationReference as StoredQualificationReference,
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

/// The scope of a turn (K4/3 section 4, "scope"): the project, the DB's chat
/// session and the target Scene with its incarnation. Candidates are limited
/// to attempts of the same range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryRange {
    pub project_id: OpaqueRef,
    /// The `chat_sessions` row id, not the caller's session.
    pub chat_session_id: OpaqueRef,
    pub scene_id: OpaqueRef,
    pub scene_incarnation_id: OpaqueRef,
}

impl HistoryRange {
    pub(crate) fn is_complete(&self) -> bool {
        [
            &self.project_id,
            &self.chat_session_id,
            &self.scene_id,
            &self.scene_incarnation_id,
        ]
        .into_iter()
        .all(|value| valid_ref(value))
    }
}

/// The nine axes of K4/3 section 4, in the order they are compared and
/// reported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryAxisName {
    ReadingOrder,
    StoryTime,
    Viewpoint,
    KnowledgeHolder,
    Audience,
    Timeline,
    Worldline,
    NarrativeLayer,
    Auto,
}

/// What a turn's context is, in the form both sides are compared in (K4/3
/// section 4). The recorded side reads it from an attempt's binding and its
/// `HistoryTurnContextV1`; the current side comes from the HS-1 builder in the
/// D-final snapshot. It deliberately holds no caller, profile, workspace
/// binding digest, route, material digest, scope digest or D1 digest: those
/// are process-local or request-local and are not compared as the context.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryComparisonContext {
    pub range: HistoryRange,
    pub purpose: GenerationPurpose,
    /// `None` is "could not be determined" and never matches.
    pub durable_identity: Option<DurableWorkspaceIdentity>,
    pub send_classification: HistorySendClassification,
    pub restore_epoch: HistoryRestoreEpoch,
    pub target: HistoryTargetScope,
    pub axes: HistoryAxes,
}

/// A stored attempt's context and the two times the validity window needs.
/// The stored values are comparison anchors; they carry no authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedHistoryContext {
    pub context: HistoryComparisonContext,
    /// The attempt row's `created_at_ms`.
    pub created_at_ms: i64,
    /// The stored `eligibleUntilMs`.
    pub eligible_until_ms: u64,
    /// The stored D1 selection fields. They are not compared with the current
    /// turn (the D1 selection is today's); the requalifier recomputes the
    /// selection digest from them and the stored input rows (HC1-3).
    pub d1: HistoryD1Selection,
}

/// Why the current turn's context cannot be compared. The turn goes on
/// without history (K4/3 section 8): every candidate is excluded.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CurrentContextUnavailable {
    /// The builder recorded a closed reason that there is no context.
    Turn(HistoryUnavailableReason),
    /// An identity of the range is empty.
    Range,
    /// The durable workspace identity could not be determined.
    DurableIdentity,
    /// An axis of the current turn is unavailable.
    Axis(HistoryAxisName),
}

/// The current turn's context as the D-final snapshot's builder produced it.
#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(
    all(not(test), not(feature = "native-current-human-capture")),
    expect(
        dead_code,
        reason = "only the HS-1 builder's hand-off constructs it; the run entry that receives it is DI-1b's"
    )
)]
pub enum CurrentHistoryContext {
    /// A context. It can still hold an unavailable axis or no durable
    /// identity; [`CurrentHistoryContext::unavailable`] says so.
    Known(Box<HistoryComparisonContext>),
    /// The builder had no context.
    Unavailable(HistoryUnavailableReason),
}

impl CurrentHistoryContext {
    /// The context when every compared value of the current turn is present,
    /// else the reason history cannot be used in this turn.
    pub fn available(&self) -> Result<&HistoryComparisonContext, CurrentContextUnavailable> {
        let context = match self {
            Self::Unavailable(reason) => return Err(CurrentContextUnavailable::Turn(*reason)),
            Self::Known(context) => context.as_ref(),
        };
        if !context.range.is_complete() {
            return Err(CurrentContextUnavailable::Range);
        }
        if context.durable_identity.is_none() {
            return Err(CurrentContextUnavailable::DurableIdentity);
        }
        match axis_availability(&context.axes)
            .into_iter()
            .find(|(_, present)| !present)
        {
            Some((name, _)) => Err(CurrentContextUnavailable::Axis(name)),
            None => Ok(context),
        }
    }
}

fn axis_availability(axes: &HistoryAxes) -> [(HistoryAxisName, bool); 9] {
    fn present<T, R>(axis: &HistoryAxis<T, R>) -> bool {
        matches!(axis, HistoryAxis::Present(_))
    }
    [
        (HistoryAxisName::ReadingOrder, present(&axes.reading_order)),
        (HistoryAxisName::StoryTime, present(&axes.story_time)),
        (HistoryAxisName::Viewpoint, present(&axes.viewpoint)),
        (
            HistoryAxisName::KnowledgeHolder,
            present(&axes.knowledge_holder),
        ),
        (HistoryAxisName::Audience, present(&axes.audience)),
        (HistoryAxisName::Timeline, present(&axes.timeline)),
        (HistoryAxisName::Worldline, present(&axes.worldline)),
        (
            HistoryAxisName::NarrativeLayer,
            present(&axes.narrative_layer),
        ),
        (HistoryAxisName::Auto, present(&axes.auto)),
    ]
}

/// Why a recorded context does not match the current turn's: one closed
/// reason per compared item (no plaintext). K4/3 sections 4, 5 and 7.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextMismatch {
    ProjectMismatch,
    ChatSessionMismatch,
    SceneMismatch,
    SceneIncarnationMismatch,
    /// Both axes are present and differ.
    AxisChanged(HistoryAxisName),
    /// An axis is unavailable on either side. Two unavailable axes never
    /// match.
    AxisUnavailable(HistoryAxisName),
    ScopeBindingTokenChanged,
    ScopeBindingVersionChanged,
    PurposeMismatch,
    SendClassificationMismatch,
    /// The identities differ, or either is missing.
    DurableIdentityMismatch,
    RestoreEpochMismatch,
    /// The clock is at or after the end of the validity window.
    ValidityExpired,
    /// The clock is before the attempt's creation time.
    ClockBeforeCreation,
    /// The stored times cannot form a window (negative, out of range).
    ValidityWindowInvalid,
}

fn same_ref(current: &str, recorded: &str) -> bool {
    valid_ref(current) && current == recorded
}

fn compare_axis<T: Eq, R>(
    name: HistoryAxisName,
    current: &HistoryAxis<T, R>,
    recorded: &HistoryAxis<T, R>,
) -> Result<(), ContextMismatch> {
    match (current, recorded) {
        (HistoryAxis::Present(current), HistoryAxis::Present(recorded)) => {
            if current == recorded {
                Ok(())
            } else {
                Err(ContextMismatch::AxisChanged(name))
            }
        }
        _ => Err(ContextMismatch::AxisUnavailable(name)),
    }
}

/// Compare a recorded context with the current turn's (K4/3 sections 4 and
/// 7). Equality of opaque values only: tokens and digests are not parsed or
/// ordered, the monotone values (Scope binding token and version, restore
/// epoch) are never compared by size, and a value that is missing or
/// unavailable on either side does not match. The first difference in a fixed
/// order is the reason: range, the nine axes, the Scope binding, purpose, send
/// classification, durable identity, restore epoch, validity. `now_ms` is the
/// Native clock's value, supplied by the caller; this module reads no clock.
pub fn compare_context(
    current: &HistoryComparisonContext,
    recorded: &RecordedHistoryContext,
    now_ms: i64,
) -> Result<(), ContextMismatch> {
    let (current_range, recorded_range) = (&current.range, &recorded.context.range);
    if !same_ref(&current_range.project_id, &recorded_range.project_id) {
        return Err(ContextMismatch::ProjectMismatch);
    }
    if !same_ref(
        &current_range.chat_session_id,
        &recorded_range.chat_session_id,
    ) {
        return Err(ContextMismatch::ChatSessionMismatch);
    }
    if !same_ref(&current_range.scene_id, &recorded_range.scene_id) {
        return Err(ContextMismatch::SceneMismatch);
    }
    if !same_ref(
        &current_range.scene_incarnation_id,
        &recorded_range.scene_incarnation_id,
    ) {
        return Err(ContextMismatch::SceneIncarnationMismatch);
    }
    let (current_axes, recorded_axes) = (&current.axes, &recorded.context.axes);
    compare_axis(
        HistoryAxisName::ReadingOrder,
        &current_axes.reading_order,
        &recorded_axes.reading_order,
    )?;
    compare_axis(
        HistoryAxisName::StoryTime,
        &current_axes.story_time,
        &recorded_axes.story_time,
    )?;
    compare_axis(
        HistoryAxisName::Viewpoint,
        &current_axes.viewpoint,
        &recorded_axes.viewpoint,
    )?;
    compare_axis(
        HistoryAxisName::KnowledgeHolder,
        &current_axes.knowledge_holder,
        &recorded_axes.knowledge_holder,
    )?;
    compare_axis(
        HistoryAxisName::Audience,
        &current_axes.audience,
        &recorded_axes.audience,
    )?;
    compare_axis(
        HistoryAxisName::Timeline,
        &current_axes.timeline,
        &recorded_axes.timeline,
    )?;
    compare_axis(
        HistoryAxisName::Worldline,
        &current_axes.worldline,
        &recorded_axes.worldline,
    )?;
    compare_axis(
        HistoryAxisName::NarrativeLayer,
        &current_axes.narrative_layer,
        &recorded_axes.narrative_layer,
    )?;
    compare_axis(
        HistoryAxisName::Auto,
        &current_axes.auto,
        &recorded_axes.auto,
    )?;
    // The axes are compared first so that each change has its own reason;
    // the Scope binding's token and version then exclude the rest.
    if current.target.binding_token_digest != recorded.context.target.binding_token_digest {
        return Err(ContextMismatch::ScopeBindingTokenChanged);
    }
    if current.target.version != recorded.context.target.version {
        return Err(ContextMismatch::ScopeBindingVersionChanged);
    }
    if current.purpose != recorded.context.purpose {
        return Err(ContextMismatch::PurposeMismatch);
    }
    if current.send_classification != recorded.context.send_classification {
        return Err(ContextMismatch::SendClassificationMismatch);
    }
    match (
        &current.durable_identity,
        &recorded.context.durable_identity,
    ) {
        (Some(current), Some(recorded)) if current == recorded => {}
        _ => return Err(ContextMismatch::DurableIdentityMismatch),
    }
    if current.restore_epoch != recorded.context.restore_epoch {
        return Err(ContextMismatch::RestoreEpochMismatch);
    }
    check_validity_window(recorded, now_ms)
}

/// K4/3 section 7: the window is `[created_at_ms, end)`, and `end` is the
/// earlier of the stored `eligibleUntilMs` and `created_at_ms` plus the
/// current window (so shortening the window also applies to old attempts). A
/// clock before the creation time is outside the window.
fn check_validity_window(
    recorded: &RecordedHistoryContext,
    now_ms: i64,
) -> Result<(), ContextMismatch> {
    let created = recorded.created_at_ms;
    if created < 0 {
        return Err(ContextMismatch::ValidityWindowInvalid);
    }
    let window_end = created
        .checked_add(HISTORY_ELIGIBILITY_WINDOW_MS)
        .ok_or(ContextMismatch::ValidityWindowInvalid)?;
    let stored_end = i64::try_from(recorded.eligible_until_ms)
        .map_err(|_| ContextMismatch::ValidityWindowInvalid)?;
    if now_ms < created {
        return Err(ContextMismatch::ClockBeforeCreation);
    }
    if now_ms >= window_end.min(stored_end) {
        return Err(ContextMismatch::ValidityExpired);
    }
    Ok(())
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
    /// The body digest of the output message version the terminal wrote, as
    /// the receipt recorded it.
    pub output_body_digest: Option<OpaqueRef>,
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
        /// The capture lineage of this Human version (K4/3 section 6, rules
        /// 1 to 3), read in the same snapshot. Rule 4 is the requalification
        /// of the input's own references.
        lineage: HumanLineage,
    },
}

/// The result of the capture lineage of a past Human (K4/3 section 6). A
/// Human is a candidate only when its message version is a live Human
/// version, its capture is a superseded one of the same project, chat session
/// and Scene, and exactly one listed attempt holds it at ordinal 0.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HumanLineage {
    /// Rules 1 to 3 hold; `owner_attempt_id` is the one attempt that holds the
    /// version at ordinal 0.
    Qualified {
        owner_attempt_id: AttemptId,
    },
    Rejected(HumanLineageReason),
}

/// Why a Human is not a candidate (a closed set, no plaintext).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanLineageReason {
    /// The lineage was not read (the input was never materialized for it).
    Unresolved,
    /// Rule 1: the message version's origin is not human.
    HumanNotHuman,
    /// Rule 1: the message version is missing or was invalidated.
    MessageVersionInvalidated,
    /// Rule 2: the version has no capture (a version bound by
    /// `bind_human_message`, a legacy row).
    CaptureMissing,
    /// Rule 2: the capture is of another project, chat session or Scene.
    CaptureScopeMismatch,
    /// Rule 2: the capture is not superseded (current, cancelled or closed).
    CaptureNotSuperseded(HistoryCaptureState),
    /// Rule 3: no listed attempt holds the version at ordinal 0.
    NoOrdinalZeroAttempt,
    /// Rule 3: two or more listed attempts hold it at ordinal 0.
    MultipleOrdinalZeroAttempts,
    /// Rule 3: an attempt of the session could not be counted (an unknown
    /// binding version, an unreadable row), so "exactly one" cannot hold.
    OrdinalZeroUncountable,
    /// Rule 3: the one attempt that holds the version at ordinal 0 is not the
    /// attempt whose current turn it is (or, for an adopted Human, is the
    /// adopting attempt itself).
    OrdinalZeroAttemptMismatch,
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
    pub(crate) fn input_reference(&self) -> Option<InputReference> {
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
    /// The context the attempt recorded, read from its binding. `None` for a
    /// gated attempt (its slot is not a context of the known version).
    pub recorded: Option<RecordedHistoryContext>,
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
    /// Whether the attempt's history slot is a context of the known version.
    /// A gated attempt's reference rows were never read, so `inputs` is empty.
    pub context: HistoryContextState,
}

/// The state of an attempt's `historyTurnContext` slot, decided from the
/// binding before any reference row is read (HS1-2).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryContextState {
    /// A `HistoryTurnContextV1` of the known version. The traversal compares
    /// it with the current turn's context (HC1-2).
    Known,
    /// Not usable as history; the candidate and its descendants are excluded.
    Gated(HistoryContextGateReason),
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
    /// `Some` for a generated-output candidate (K4/3 section 6): the output of
    /// the attempt `root_attempt_id`. The root's inputs are then all
    /// requalified (the parent's turn), and `adopted_input_ordinals` is not
    /// used.
    pub output: Option<GeneratedOutput>,
}

/// The generated output a candidate stands for: the message version that the
/// parent attempt's terminal receipt names.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratedOutput {
    pub version_id: OpaqueRef,
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

/// Why the production `CurrentQualifier` (HC1-3) excludes a candidate and its
/// descendants (K4/3 sections 3 and 13). A closed set; no plaintext, no
/// identity or token.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(
    not(feature = "native-current-human-capture"),
    expect(
        dead_code,
        reason = "only the production requalifier (feature native-current-human-capture) constructs these reasons"
    )
)]
pub enum RequalificationReason {
    /// The message version is missing or was invalidated.
    MessageVersionInvalid,
    /// The message version belongs to another project or chat session.
    MessageVersionScopeMismatch,
    /// The message version's origin is not the one the input uses.
    MessageOriginMismatch,
    /// The message version's body digest is not the recorded one.
    MessageDigestChanged,
    /// A Source is not current (changed, missing, or not the recorded token).
    SourceStale,
    /// No current resolver exists for the Source's kind (unknown, excluded).
    SourceResolverMissing,
    /// The Revision is not the current approved one (bundle digest or id).
    RevisionStale,
    /// A2 reads the Revision as unavailable (for example the version 1 form).
    RevisionUnavailableByA2,
    DecisionStale,
    /// The canonical Freshness is not fresh now.
    FreshnessNotFresh,
    /// A typed-scope digest differs from the Revision's current one.
    ScopeDependencyChanged,
    /// The current A3 evaluation is not Eligible.
    DisclosureIneligible,
    /// A Scope reference that names the turn's own context (Scene Scope
    /// token, incarnation) is not the context the attempt was compared with.
    SceneScopeInconsistent,
    /// The recorded `(kind, target)` set is not the set the current state
    /// derives (rule 3 of the completeness rule).
    ExpectedSetMismatch(CompletenessViolation),
    /// A typed N/A does not follow the table that the input's type, use and
    /// source key derive (a forged or missing N/A, a reference where the
    /// table puts an N/A, the Raw Freshness reason).
    NotApplicableMismatch(CompletenessViolation),
    /// Another violation of the completeness rule found while requalifying.
    CompletenessViolated(CompletenessViolation),
    /// The D1 selection digest does not recompute from the stored rows, or a
    /// D1 reference is not the attempt's.
    D1RecomputeMismatch,
    /// The stored input rows do not form one current turn at ordinal 0.
    InputShapeInvalid,
    /// An Artifact input (unsupported).
    ArtifactUnsupported,
    /// The input cannot be mapped to a stored input row.
    InvalidInput,
}

/// What a `CurrentQualifier` says about an attempt or an input.
///
/// `Unavailable` is a stop of the whole run, not a typed absence: it means a
/// read failed (SQLite or IO, a malformed row, a validation stop such as a
/// cancel or a deadline), so a partial history must not be adopted. A typed
/// absence (no resolver for a Source kind, a Revision A2 reads as
/// unavailable, a Scene that is not in the mapping) is `Excluded` with a
/// closed reason, which drops that candidate and its descendants only.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(
    not(feature = "native-current-human-capture"),
    expect(
        dead_code,
        reason = "only the production qualifier (feature native-current-human-capture) answers with these statuses"
    )
)]
pub enum QualificationStatus {
    Current,
    Pending,
    Unavailable,
    #[cfg_attr(
        feature = "native-current-human-capture",
        expect(
            dead_code,
            reason = "the production qualifier excludes with a closed reason; only a test qualifier answers a bare rejection"
        )
    )]
    Ineligible,
    Excluded(RequalificationReason),
}

/// The storage adapter implements this with the existing current readers. A
/// pure traversal cannot turn identity/version strings into authority itself.
pub trait CurrentQualifier {
    fn qualify_attempt(
        &mut self,
        attempt: &AttemptSnapshot,
        current: &HistoryComparisonContext,
    ) -> QualificationStatus;

    fn qualify_input(
        &mut self,
        attempt: &AttemptSnapshot,
        ordinal: usize,
        input: &HistoryInput,
        current: &HistoryComparisonContext,
    ) -> QualificationStatus;

    /// The generated output of `parent` as a candidate's own reference (K4/3
    /// section 6): the message version `version_id` must be a live generated
    /// version of the parent with the body digest the parent's receipt
    /// recorded. The terminal receipt and the parent's inputs are judged by
    /// the traversal.
    fn qualify_generated_output(
        &mut self,
        parent: &AttemptSnapshot,
        version_id: &str,
        recorded_body_digest: &str,
        current: &HistoryComparisonContext,
    ) -> QualificationStatus;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IncompleteReason {
    /// The attempt's history slot is not a context of the known version
    /// (null, unavailable with a closed reason, or an unknown version). Its
    /// reference rows were not read.
    HistoryContextUnusable(HistoryContextGateReason),
    /// The attempt is of the known context version but no recorded context
    /// could be read for it.
    RecordedContextMissing,
    /// The current turn's context cannot be compared (K4/3 section 8): every
    /// candidate is excluded with this reason and the turn goes on.
    CurrentContextUnavailable(CurrentContextUnavailable),
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
    /// The attempt has neither a Human turn at ordinal 0 nor a succeeded
    /// output, so it yields no candidate.
    #[cfg_attr(
        not(feature = "native-current-human-capture"),
        expect(
            dead_code,
            reason = "only the session run (feature native-current-human-capture) plans candidates"
        )
    )]
    NoCandidateInAttempt,
    Cycle(AttemptId),
    BudgetExhausted,
    Cancelled,
    /// A past Human is not a candidate (capture lineage, K4/3 section 6).
    HumanLineage(HumanLineageReason),
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
    AuthorityUnavailable,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IneligibleReason {
    /// The recorded context differs from the current turn's in one item.
    Context(ContextMismatch),
    AuthorityRejected,
    /// The production qualifier excluded the candidate for a closed reason.
    Requalification(RequalificationReason),
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
    current: &'snapshot HistoryComparisonContext,
    /// The Native clock's value for this turn, supplied by the caller.
    now_ms: i64,
    qualifier: &'qualifier mut Q,
    budget: &'qualifier mut B,
    cancelled: &'qualifier mut C,
    header_cache: BTreeMap<AttemptId, Result<(), Failure>>,
    input_cache: BTreeMap<(AttemptId, usize), Result<Option<Descent>, Failure>>,
    complete_cache: BTreeMap<AttemptId, Result<Vec<AttemptId>, Failure>>,
    turn_cache: BTreeMap<AttemptId, Result<Vec<AttemptId>, Failure>>,
    visiting: BTreeSet<AttemptId>,
}

/// Where an input leads once it is current. A generated output leads to its
/// parent attempt, whose every input is requalified; an adopted past Human
/// leads to the one attempt whose current turn it was, of which only the
/// header and the Human itself are requalified (K4/3 section 6, rules 3 and
/// 4).
#[derive(Clone, Debug, Eq, PartialEq)]
enum Descent {
    Whole(AttemptId),
    HumanTurn(AttemptId),
}

/// The closed `Failure` of a qualifier's answer that is not `Current`.
fn status_failure(status: QualificationStatus) -> Option<Failure> {
    match status {
        QualificationStatus::Current => None,
        QualificationStatus::Pending => {
            Some(Failure::incomplete(IncompleteReason::PendingAuthority))
        }
        QualificationStatus::Unavailable => {
            Some(Failure::incomplete(IncompleteReason::AuthorityUnavailable))
        }
        QualificationStatus::Ineligible => {
            Some(Failure::ineligible(IneligibleReason::AuthorityRejected))
        }
        QualificationStatus::Excluded(reason) => Some(Failure::ineligible(
            IneligibleReason::Requalification(reason),
        )),
    }
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
        // The gate precedes every other check: a slot that is not a known
        // context is excluded whatever its reference rows would say (they
        // were not read) and whatever its recorded context is.
        let result = if let HistoryContextState::Gated(reason) = attempt.context {
            Err(Failure::incomplete(
                IncompleteReason::HistoryContextUnusable(reason),
            ))
        } else {
            match attempt.recorded.as_ref() {
                _ if attempt.reference_format == ReferenceFormat::LegacyV1 => {
                    // Version 1 rows have no input-use or typed N/A. The attempt
                    // and every descendant that adopts it are excluded; the turn
                    // goes on (K4/3 section 2).
                    Err(Failure::incomplete(IncompleteReason::LegacyReferenceFormat))
                }
                None => Err(Failure::incomplete(
                    IncompleteReason::RecordedContextMissing,
                )),
                Some(recorded) => match compare_context(self.current, recorded, self.now_ms) {
                    Err(mismatch) => Err(Failure::ineligible(IneligibleReason::Context(mismatch))),
                    Ok(()) => {
                        match status_failure(self.qualifier.qualify_attempt(&attempt, self.current))
                        {
                            None => Ok(()),
                            Some(failure) => Err(failure),
                        }
                    }
                },
            }
        };
        self.header_cache.insert(id.into(), result.clone());
        result
    }

    fn validate_input(
        &mut self,
        attempt: &AttemptSnapshot,
        ordinal: usize,
    ) -> Result<Option<Descent>, Failure> {
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
        // The lineage of a past Human (K4/3 section 6, rules 1 to 3) is read
        // from the same snapshot before the input is requalified (rule 4), so
        // a Human that is not a candidate is excluded for that reason.
        let rejected_lineage = match &input.kind {
            HistoryInputKind::HumanMessage {
                lineage: HumanLineage::Rejected(reason),
                ..
            } => Some(Failure::incomplete(IncompleteReason::HumanLineage(*reason))),
            _ => None,
        };
        let result = if let Some(failure) = rejected_lineage {
            Err(failure)
        } else {
            match status_failure(self.qualifier.qualify_input(
                attempt,
                ordinal,
                &input,
                self.current,
            )) {
                None => self.validate_lineage(attempt, &input),
                Some(failure) => Err(failure),
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
        // A gated parent has no terminal read; name the gate, not a missing
        // receipt, so the child is excluded for the parent's closed reason.
        if let HistoryContextState::Gated(reason) = parent_snapshot.context {
            return Err(Failure::incomplete(
                IncompleteReason::HistoryContextUnusable(reason),
            ));
        }
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
    ) -> Result<Option<Descent>, Failure> {
        match &input.kind {
            HistoryInputKind::GeneratedMessage {
                version_id,
                parent_attempt_id,
                receipt,
            } => {
                if !valid_ref(version_id) {
                    return Err(Failure::incomplete(IncompleteReason::InvalidReference));
                }
                Ok(self
                    .validate_parent_receipt(
                        attempt,
                        parent_attempt_id.as_ref(),
                        receipt.as_ref(),
                        Some(version_id),
                        None,
                    )?
                    .map(Descent::Whole))
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
                Ok(self
                    .validate_parent_receipt(
                        attempt,
                        producer_attempt_id.as_ref(),
                        receipt.as_ref(),
                        None,
                        Some(payload_digest),
                    )?
                    .map(Descent::Whole))
            }
            HistoryInputKind::HumanMessage {
                version_id,
                lineage,
            } => {
                if !valid_ref(version_id) {
                    return Err(Failure::incomplete(IncompleteReason::InvalidReference));
                }
                let owner = match lineage {
                    HumanLineage::Rejected(reason) => {
                        return Err(Failure::incomplete(IncompleteReason::HumanLineage(*reason)))
                    }
                    HumanLineage::Qualified { owner_attempt_id } => owner_attempt_id,
                };
                if !valid_ref(owner) {
                    return Err(Failure::incomplete(IncompleteReason::InvalidReference));
                }
                // K4/3 section 6, rule 3: the one attempt that holds this
                // Human at ordinal 0 is the attempt whose current turn it is.
                // An adopted Human leads to that attempt, whose context and
                // Human reference must hold too.
                let mismatch = Failure::incomplete(IncompleteReason::HumanLineage(
                    HumanLineageReason::OrdinalZeroAttemptMismatch,
                ));
                if input.input_use == InputUse::CurrentTurn {
                    if owner == &attempt.id {
                        Ok(None)
                    } else {
                        Err(mismatch)
                    }
                } else if owner == &attempt.id {
                    Err(mismatch)
                } else {
                    Ok(Some(Descent::HumanTurn(owner.clone())))
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
                if let Some(descent) = self.validate_input(&attempt, ordinal)? {
                    for ancestor in self.descend(&descent)? {
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

    fn descend(&mut self, descent: &Descent) -> Result<Vec<AttemptId>, Failure> {
        match descent {
            Descent::Whole(parent) => self.visit_complete(parent),
            Descent::HumanTurn(owner) => self.visit_human_turn(owner),
        }
    }

    /// The attempt whose current turn an adopted past Human was (K4/3 section
    /// 6, rule 3): its context must match and the Human must requalify
    /// (rule 4). The attempt's other inputs are not the Human's concern.
    fn visit_human_turn(&mut self, id: &str) -> Result<Vec<AttemptId>, Failure> {
        self.check_cancelled()?;
        if let Some(cached) = self.turn_cache.get(id) {
            return cached.clone();
        }
        let attempt = self
            .snapshot
            .attempts
            .get(id)
            .cloned()
            .ok_or_else(|| Failure::incomplete(IncompleteReason::MissingAttempt(id.into())))?;
        let result = (|| {
            self.validate_header(id)?;
            let current_human = attempt.inputs.first().is_some_and(|input| {
                input.input_use == InputUse::CurrentTurn
                    && matches!(input.kind, HistoryInputKind::HumanMessage { .. })
            });
            if !current_human {
                return Err(Failure::incomplete(IncompleteReason::HumanLineage(
                    HumanLineageReason::OrdinalZeroAttemptMismatch,
                )));
            }
            self.budget.consume_edge()?;
            self.validate_input(&attempt, 0)?;
            Ok(vec![id.to_owned()])
        })();
        self.turn_cache.insert(id.into(), result.clone());
        result
    }

    /// A generated output as a candidate (K4/3 section 6): the parent's
    /// header and every input requalify, the parent's terminal receipt names
    /// this output as a success, and the output message version is a live
    /// generated version of the parent with the digest the receipt recorded.
    fn visit_generated_output(
        &mut self,
        candidate: &Candidate,
        output: &GeneratedOutput,
    ) -> Result<Vec<AttemptId>, Failure> {
        self.check_cancelled()?;
        let parent_id = &candidate.root_attempt_id;
        if !valid_ref(&output.version_id) || !valid_ref(parent_id) {
            return Err(Failure::incomplete(IncompleteReason::InvalidReference));
        }
        let parent = self
            .snapshot
            .attempts
            .get(parent_id)
            .cloned()
            .ok_or_else(|| {
                Failure::incomplete(IncompleteReason::MissingAttempt(parent_id.clone()))
            })?;
        let visited = self.visit_complete(parent_id)?;
        let terminal = parent.terminal.as_ref().ok_or_else(|| {
            Failure::incomplete(IncompleteReason::MissingReceipt(parent_id.clone()))
        })?;
        let mismatch = || Failure::incomplete(IncompleteReason::ReceiptMismatch(parent_id.clone()));
        if !terminal.successful
            || &terminal.attempt_id != parent_id
            || terminal.output_version_id.as_deref() != Some(output.version_id.as_str())
        {
            return Err(mismatch());
        }
        let digest = terminal
            .output_body_digest
            .as_deref()
            .filter(|digest| valid_ref(digest))
            .ok_or_else(mismatch)?;
        self.budget.consume_edge()?;
        self.budget.consume_qualification_refs(1)?;
        if let Some(failure) = status_failure(self.qualifier.qualify_generated_output(
            &parent,
            &output.version_id,
            digest,
            self.current,
        )) {
            return Err(failure);
        }
        Ok(visited)
    }

    fn visit_candidate_root(&mut self, candidate: &Candidate) -> Result<Vec<AttemptId>, Failure> {
        if let Some(output) = &candidate.output {
            return self.visit_generated_output(candidate, output);
        }
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
            if let Some(descent) = self.validate_input(&attempt, ordinal)? {
                for ancestor in self.descend(&descent)? {
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
    current: &CurrentHistoryContext,
    now_ms: i64,
    budget: &mut B,
    qualifier: &mut Q,
    cancelled: &mut C,
) -> Result<HistoryOutcome, HistoryRunError> {
    if cancelled() {
        return Err(HistoryRunError::Cancelled);
    }
    let current = match current.available() {
        Ok(context) => context,
        Err(unavailable) => {
            // K4/3 section 8: a current axis that is unavailable excludes all
            // history and the turn goes on. Nothing was read, so no budget
            // is spent and no candidate is visited.
            return Ok(HistoryOutcome {
                candidates: candidates
                    .iter()
                    .map(|candidate| CandidateResult {
                        id: candidate.id.clone(),
                        disposition: CandidateDisposition::Excluded(Failure::incomplete(
                            IncompleteReason::CurrentContextUnavailable(unavailable),
                        )),
                        visited_attempts: Vec::new(),
                    })
                    .collect(),
            });
        }
    };
    let mut traversal = Traversal {
        snapshot,
        current,
        now_ms,
        qualifier,
        budget,
        cancelled,
        header_cache: BTreeMap::new(),
        input_cache: BTreeMap::new(),
        complete_cache: BTreeMap::new(),
        turn_cache: BTreeMap::new(),
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

/// Adapter for the Native storage hook: it reads the typed records of one
/// snapshot (HS-1, HC-1) into the pure traversal's inputs. A recorded context
/// is read from the attempt's binding (K4/3 section 4), the capture lineage of
/// a past Human from the capture and the ordinal 0 rows (section 6), and the
/// current artifact reader returns no producer receipt, which is preserved as
/// `None` and therefore fails closed in `reauthorize_history`. The session run
/// (`session_run`) derives the candidates of a chat session from the stored
/// attempts and runs the traversal with the production qualifier.
#[cfg_attr(not(test), allow(dead_code, unused_imports))]
mod generation_storage_adapter {
    use super::*;
    use anyhow::{anyhow, Context, Result};
    use std::collections::BTreeMap;

    use crate::narrative_extraction::{validation_terminated, ValidationTerminationReason};
    use crate::narrative_maintenance_connection::ParticipantSqlControl;
    use crate::nir1_generation::history_reads::{ExcludedHistoryAttempt, GenerationHistoryAttempt};
    use crate::nir1_generation::{
        with_generation_history_snapshot, GenerationHistoryMessage, GenerationHistoryReadBudget,
        GenerationHistorySnapshotCancellation, GenerationHistorySnapshotReader, InputRole,
        InputTarget, MessageOrigin, StoredAttempt, StoredTerminal,
    };
    use crate::state::ActiveWorkspaceSnapshot;

    #[cfg(feature = "native-current-human-capture")]
    pub(super) mod session_run;

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
            HistoryRunError::AuthorityUnavailable => {
                anyhow!("NIR1_GENERATION_HISTORY_AUTHORITY_UNAVAILABLE")
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
            output_body_digest: terminal
                .message_version
                .as_ref()
                .map(|version| version.body_digest.clone()),
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

    /// The capture lineage of a past Human (K4/3 section 6, rules 1 to 3):
    /// the message version is a live Human version, its capture is a
    /// superseded one of the attempt's project, chat session and Scene, and
    /// exactly one attempt of the enumerated session holds it at ordinal 0.
    /// Rule 4 is the requalification of the input's own references. Nothing is
    /// repaired: a version with no capture (`bind_human_message`, a legacy
    /// row) or no attempt is not a candidate.
    fn human_lineage(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        attempt: &StoredAttempt,
        version_id: &str,
        message: Option<&GenerationHistoryMessage>,
    ) -> Result<HumanLineage> {
        use HumanLineageReason as Reason;
        let reject = |reason| Ok(HumanLineage::Rejected(reason));
        let Some(message) = message else {
            return reject(Reason::MessageVersionInvalidated);
        };
        if message.version.origin != MessageOrigin::Human {
            return reject(Reason::HumanNotHuman);
        }
        let Some(capture) = reader.read_capture_by_message_version(version_id)? else {
            return reject(Reason::CaptureMissing);
        };
        if capture.project_id != attempt.binding.project_id
            || capture.chat_session_id != attempt.binding.chat_session_id
            || capture.scene_id != attempt.binding.scene.scene_id
        {
            return reject(Reason::CaptureScopeMismatch);
        }
        if capture.state != HistoryCaptureState::Superseded {
            return reject(Reason::CaptureNotSuperseded(capture.state));
        }
        let holders = reader.ordinal_zero_attempts(
            budget,
            &attempt.binding.project_id,
            &attempt.binding.chat_session_id,
            version_id,
        )?;
        // Two or more holders are a definite "not exactly one"; an attempt
        // that could not be counted makes "exactly one" unprovable.
        if holders.count() > 1 {
            return reject(Reason::MultipleOrdinalZeroAttempts);
        }
        if let Some(owner) = holders.sole_attempt() {
            return Ok(HumanLineage::Qualified {
                owner_attempt_id: owner.to_owned(),
            });
        }
        if holders.is_ambiguous() {
            return reject(Reason::OrdinalZeroUncountable);
        }
        reject(Reason::NoOrdinalZeroAttempt)
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
                        lineage: if resolve_lineage {
                            human_lineage(reader, budget, attempt, version_id, message.as_ref())?
                        } else {
                            HumanLineage::Rejected(HumanLineageReason::Unresolved)
                        },
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

    /// The context the attempt recorded, as the comparison reads it (K4/3
    /// section 4): the range and purpose from the binding, the durable
    /// identity, and the turn context's epoch, Scope binding and axes. `None`
    /// for a gated attempt, whose slot is not a context of the known version.
    /// Process-local values of the binding (caller, workspace binding digest,
    /// profile, route) are not carried.
    pub(super) fn recorded_context(stored: &StoredAttempt) -> Option<RecordedHistoryContext> {
        if stored.history_gate().is_some() {
            return None;
        }
        let Some(HistoryContextSlot::Context(context)) = &stored.binding.history_turn_context
        else {
            return None;
        };
        Some(RecordedHistoryContext {
            context: HistoryComparisonContext {
                range: HistoryRange {
                    project_id: stored.binding.project_id.clone(),
                    chat_session_id: stored.binding.chat_session_id.clone(),
                    scene_id: stored.binding.scene.scene_id.clone(),
                    scene_incarnation_id: stored.binding.scene.scene_incarnation_id.clone(),
                },
                purpose: stored.binding.purpose.clone(),
                durable_identity: stored.binding.durable_workspace_identity.clone(),
                send_classification: context.send_classification,
                restore_epoch: context.restore_epoch.clone(),
                target: context.target.clone(),
                axes: context.axes.clone(),
            },
            created_at_ms: stored.created_at_ms,
            eligible_until_ms: context.eligible_until_ms.get(),
            d1: context.d1.clone(),
        })
    }

    fn attempt(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        stored: &StoredAttempt,
        resolve_lineage: bool,
    ) -> Result<AttemptSnapshot> {
        // A gated attempt's reference rows were never read: `stored.inputs`
        // is empty, so no input is mapped and no row, message or artifact is
        // read for it.
        let context = stored
            .history_gate()
            .map_or(HistoryContextState::Known, HistoryContextState::Gated);
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
            recorded: recorded_context(stored),
            inputs,
            terminal: terminal_receipt(stored.terminal.as_ref()),
            project_id: Some(stored.binding.project_id.clone()),
            session_id: Some(stored.binding.chat_session_id.clone()),
            target_scene_id: Some(stored.binding.scene.scene_id.clone()),
            reference_format: stored.reference_format,
            context,
        })
    }

    /// The snapshot of an attempt the reader excluded by its binding (a
    /// legacy or unknown-version row, HC-1). Nothing but the row's identity is
    /// known: no input, no terminal and no target Scene. The closed reason is
    /// checked before everything else, so the other fields are never used.
    fn excluded_attempt(excluded: &ExcludedHistoryAttempt) -> AttemptSnapshot {
        AttemptSnapshot {
            id: excluded.id.clone(),
            recorded: None,
            inputs: Vec::new(),
            terminal: None,
            project_id: Some(excluded.project_id.clone()),
            session_id: Some(excluded.chat_session_id.clone()),
            target_scene_id: None,
            reference_format: ReferenceFormat::V2,
            context: HistoryContextState::Gated(excluded.reason),
        }
    }

    struct LoadedAttempt {
        /// `None` for an attempt excluded by its binding: it has no rows.
        stored: Option<StoredAttempt>,
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
        let read = match reader.read_attempt(budget, id) {
            Ok(read) => read,
            Err(error) if is_missing_row(&error) => return Ok(()),
            Err(error) => return Err(error),
        };
        let (key, stored, snapshot) = match read {
            GenerationHistoryAttempt::Stored(stored) => {
                let snapshot = attempt(reader, budget, &stored, false)?;
                (stored.id.clone(), Some(stored), snapshot)
            }
            GenerationHistoryAttempt::Excluded(excluded) => {
                (excluded.id.clone(), None, excluded_attempt(&excluded))
            }
        };
        attempts.insert(
            key,
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
            let Some(stored) = loaded.stored.as_ref() else {
                return Ok(());
            };
            let Some(input_ref) = stored.inputs.get(ordinal).cloned() else {
                return Ok(());
            };
            (stored.clone(), input_ref)
        };
        let mapped = input(reader, budget, &stored, ordinal, &input_ref, true)?;
        let loaded = attempts
            .get_mut(id)
            .ok_or_else(|| anyhow!("NIR1_GENERATION_HISTORY_ATTEMPT_MISSING: {id}"))?;
        loaded.snapshot.inputs[ordinal] = mapped;
        loaded.enriched_ordinals.insert(ordinal);
        Ok(())
    }

    /// The attempt an input leads to once it is materialized: the parent of a
    /// generated output (whole), or the attempt whose current turn an adopted
    /// past Human was (only its ordinal 0).
    enum Followed {
        Whole(AttemptId),
        HumanTurn(AttemptId),
    }

    fn followed(input: &HistoryInput) -> Option<Followed> {
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
            } => receipt
                .as_ref()
                .and_then(|_| parent_attempt_id.clone())
                .map(Followed::Whole),
            HistoryInputKind::HumanMessage {
                lineage: HumanLineage::Qualified { owner_attempt_id },
                ..
            } if input.input_use != InputUse::CurrentTurn => {
                Some(Followed::HumanTurn(owner_attempt_id.clone()))
            }
            _ => None,
        }
    }

    /// Load the attempt whose current turn an adopted past Human was, with its
    /// ordinal 0 input only.
    fn materialize_human_turn(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
        attempts: &mut BTreeMap<AttemptId, LoadedAttempt>,
        cancellation: &GenerationHistorySnapshotCancellation,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        ensure_snapshot_not_cancelled(cancellation, cancelled)?;
        load_attempt(reader, budget, id, attempts)?;
        enrich_input(reader, budget, id, 0, attempts)
    }

    fn follow(
        reader: &mut GenerationHistorySnapshotReader<'_>,
        budget: &mut GenerationHistoryReadBudget,
        followed: Followed,
        attempts: &mut BTreeMap<AttemptId, LoadedAttempt>,
        expanded: &mut BTreeSet<AttemptId>,
        cancellation: &GenerationHistorySnapshotCancellation,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        match followed {
            Followed::Whole(id) => materialize_all(
                reader,
                budget,
                &id,
                attempts,
                expanded,
                cancellation,
                cancelled,
            ),
            Followed::HumanTurn(id) => {
                materialize_human_turn(reader, budget, &id, attempts, cancellation, cancelled)
            }
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
            .and_then(|loaded| loaded.stored.as_ref())
            .map_or(0, |stored| stored.inputs.len());
        for ordinal in 0..input_count {
            ensure_snapshot_not_cancelled(cancellation, cancelled)?;
            enrich_input(reader, budget, id, ordinal, attempts)?;
        }
        let followed = attempts
            .get(id)
            .into_iter()
            .flat_map(|loaded| loaded.snapshot.inputs.iter())
            .filter_map(followed)
            .collect::<Vec<_>>();
        for next in followed {
            ensure_snapshot_not_cancelled(cancellation, cancelled)?;
            follow(
                reader,
                budget,
                next,
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
        if candidate.output.is_some() {
            // A generated output: the parent attempt and all its inputs.
            return materialize_all(
                reader,
                budget,
                &candidate.root_attempt_id,
                attempts,
                expanded,
                cancellation,
                cancelled,
            );
        }
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
        let followed = attempts
            .get(&candidate.root_attempt_id)
            .into_iter()
            .flat_map(|loaded| {
                candidate
                    .adopted_input_ordinals
                    .iter()
                    .filter_map(|ordinal| loaded.snapshot.inputs.get(*ordinal))
            })
            .filter_map(followed)
            .collect::<Vec<_>>();
        for next in followed {
            ensure_snapshot_not_cancelled(cancellation, cancelled)?;
            follow(
                reader,
                budget,
                next,
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
    #[expect(
        clippy::too_many_arguments,
        reason = "the participant control, the caller's whole-turn budget, the candidates, the current context and its clock, the qualifier and the cancel poll are independent inputs of one run"
    )]
    pub(crate) fn reauthorize_from_generation_snapshot<Q: CurrentQualifier, C: FnMut() -> bool>(
        workspace: &ActiveWorkspaceSnapshot,
        control: ParticipantSqlControl,
        caller_budget: &mut GenerationHistoryReadBudget,
        candidates: &[Candidate],
        current: &CurrentHistoryContext,
        now_ms: i64,
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
                // A current context that cannot be compared excludes every
                // candidate: no attempt row needs to be read for that.
                if current.available().is_ok() {
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
                    now_ms,
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
        use crate::nir1_generation::history_context::testing as history_context_testing;
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
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }

            fn qualify_input(
                &mut self,
                _attempt: &AttemptSnapshot,
                _ordinal: usize,
                _input: &HistoryInput,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }

            fn qualify_generated_output(
                &mut self,
                _parent: &AttemptSnapshot,
                _version_id: &str,
                _recorded_body_digest: &str,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }
        }

        /// The clock of the adapter tests: inside every stored attempt's
        /// window (created at 1 ms, eligible for 30 days).
        const NOW_MS: i64 = 1_000;

        fn comparison_context(scene_incarnation_id: &str) -> HistoryComparisonContext {
            let context = history_context_testing::sample_context();
            HistoryComparisonContext {
                range: HistoryRange {
                    project_id: "generation-project".into(),
                    chat_session_id: "generation-session".into(),
                    scene_id: "generation-scene".into(),
                    scene_incarnation_id: scene_incarnation_id.into(),
                },
                purpose: GenerationPurpose::Writing,
                durable_identity: Some(history_context_testing::sample_identity()),
                send_classification: context.send_classification,
                restore_epoch: context.restore_epoch,
                target: context.target,
                axes: context.axes,
            }
        }

        /// The current context that matches what `storage_attempt` records.
        fn complete_current(snapshot: &ActiveWorkspaceSnapshot) -> CurrentHistoryContext {
            let scene = snapshot
                .db()
                .db()
                .with_read_transaction(|connection| {
                    read_attempt_scene_binding_in_tx(
                        connection,
                        "generation-project",
                        "generation-scene",
                    )
                })
                .expect("generation Scene binding");
            CurrentHistoryContext::Known(Box::new(comparison_context(&scene.scene_incarnation_id)))
        }

        /// A matching pair for a checker run that has no storage.
        fn pure_pair() -> (RecordedHistoryContext, CurrentHistoryContext) {
            let context = comparison_context("incarnation-pure");
            (
                RecordedHistoryContext {
                    context: context.clone(),
                    created_at_ms: 1,
                    eligible_until_ms: 1_000_000,
                    d1: history_context_testing::sample_context().d1,
                },
                CurrentHistoryContext::Known(Box::new(context)),
            )
        }

        /// A current context history cannot be used with.
        fn unavailable_current() -> CurrentHistoryContext {
            CurrentHistoryContext::Unavailable(HistoryUnavailableReason::SceneScopeUnavailable)
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
            storage_attempt_edit(snapshot, inputs, qualifications, 1, |_| {})
        }

        /// Like `storage_attempt_with`, for an attempt created at
        /// `created_at_ms` whose binding `edit` changes before it is stored.
        fn storage_attempt_edit(
            snapshot: &ActiveWorkspaceSnapshot,
            inputs: Vec<InputReference>,
            qualifications: Vec<crate::nir1_generation::QualificationReference>,
            created_at_ms: i64,
            edit: impl FnOnce(&mut AttemptBinding),
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
            let mut binding = AttemptBinding {
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
                // A known-version context: the history gate (HS1-2)
                // reads reference rows only for such attempts.
                history_turn_context: Some(
                    crate::nir1_generation::history_context::HistoryContextSlot::Context(Box::new(
                        history_context_testing::sample_context(),
                    )),
                ),
                durable_workspace_identity: Some(history_context_testing::sample_identity()),
            };
            edit(&mut binding);
            create_attempt(
                db,
                NewAttempt {
                    binding,
                    payload_digest: digest,
                    inputs,
                    qualifications,
                    created_at_ms,
                    expires_at_ms: created_at_ms + 1,
                    budget: ReadBudget {
                        max_references: 32,
                        max_reference_bytes: 32_768,
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
                &unavailable_current(),
                NOW_MS,
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
                &unavailable_current(),
                NOW_MS,
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
                output: None,
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
                &unavailable_current(),
                NOW_MS,
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
                    output: None,
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
                &complete_current(&snapshot),
                NOW_MS,
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
                    output: None,
                },
                Candidate {
                    id: "candidate-2".into(),
                    root_attempt_id: "missing-2".into(),
                    adopted_input_ordinals: Vec::new(),
                    output: None,
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
                &pure_pair().1,
                NOW_MS,
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
                    Ok(reader
                        .read_attempt(shared_budget, &valid_attempt_id)?
                        .id()
                        .to_owned())
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
                    let stored = reader.read_attempt(shared_budget, id)?.into_stored()?;
                    attempt(reader, shared_budget, &stored, false)
                },
            )
            .expect("snapshot attempt")
        }

        fn run_checker(attempt: AttemptSnapshot) -> CandidateDisposition {
            let mut attempt = attempt;
            let (recorded, current) = pure_pair();
            attempt.recorded = Some(recorded);
            let id = attempt.id.clone();
            let history = HistorySnapshot::from_attempts([attempt]).expect("unique attempt");
            let candidate = Candidate {
                id: "candidate".into(),
                root_attempt_id: id,
                adopted_input_ordinals: vec![0],
                output: None,
            };
            let mut ledger = HistoryBudget::new(8, 8, 32);
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            reauthorize_history(
                &history,
                &[candidate],
                &current,
                NOW_MS,
                &mut ledger,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("history run")
            .candidates
            .remove(0)
            .disposition
        }

        /// Replace the `historyTurnContext` of one stored attempt, as another
        /// writer (or an import) would have stored it.
        fn store_history_slot(
            snapshot: &ActiveWorkspaceSnapshot,
            id: &str,
            slot: Option<serde_json::Value>,
        ) {
            snapshot
                .db()
                .db()
                .with_conn(|conn| {
                    let stored: String = conn.query_row(
                        "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                        [id],
                        |row| row.get(0),
                    )?;
                    let mut binding: serde_json::Value = serde_json::from_str(&stored)?;
                    binding["historyTurnContext"] = slot.unwrap_or(serde_json::Value::Null);
                    conn.execute(
                        "UPDATE nir1_generation_attempts SET binding_json=?2 WHERE id=?1",
                        rusqlite::params![id, grimodex_core::canonical_json_string(&binding)?],
                    )?;
                    Ok(())
                })
                .expect("store the history slot");
        }

        /// Make every reference row of one attempt unreadable: a reader that
        /// touches them fails.
        fn corrupt_reference_rows(snapshot: &ActiveWorkspaceSnapshot, id: &str) {
            snapshot
                .db()
                .db()
                .with_conn(|conn| {
                    for table in [
                        "nir1_generation_input_refs",
                        "nir1_generation_qualification_refs",
                    ] {
                        conn.execute(
                            &format!(
                                "UPDATE {table} SET reference_json='{{\"unreadable\":true}}'
                                 WHERE attempt_id=?1"
                            ),
                            [id],
                        )?;
                    }
                    Ok(())
                })
                .expect("corrupt the reference rows");
        }

        fn unavailable_slot(reason: &str) -> serde_json::Value {
            json!({"contract": "nir1-history-turn-context/1", "unavailable": reason})
        }

        #[test]
        fn history_gate_excludes_null_unknown_and_binding_limit_slots_with_closed_reasons() {
            let (_state, snapshot) = workspace_snapshot();
            let incomplete = storage_attempt_with(
                &snapshot,
                vec![raw_input()],
                raw_rows().into_iter().take(1).collect(),
            );
            let cases = [
                (
                    "writer-d-final-incomplete",
                    incomplete,
                    None,
                    HistoryContextGateReason::Unavailable(
                        HistoryUnavailableReason::DFinalIncomplete,
                    ),
                ),
                (
                    "null",
                    storage_attempt_with(&snapshot, vec![raw_input()], raw_rows()),
                    Some(None),
                    HistoryContextGateReason::Missing,
                ),
                (
                    "unknown-version",
                    storage_attempt_with(&snapshot, vec![raw_input()], raw_rows()),
                    Some(Some(json!({
                        "contract": "nir1-history-turn-context/2",
                        "shape": ["a later writer"]
                    }))),
                    HistoryContextGateReason::UnknownContract,
                ),
                (
                    "binding-limit",
                    storage_attempt_with(&snapshot, vec![raw_input()], raw_rows()),
                    Some(Some(unavailable_slot("binding-limit"))),
                    HistoryContextGateReason::Unavailable(HistoryUnavailableReason::BindingLimit),
                ),
                (
                    "workspace-identity-unavailable",
                    storage_attempt_with(&snapshot, vec![raw_input()], raw_rows()),
                    Some(Some(unavailable_slot("workspace-identity-unavailable"))),
                    HistoryContextGateReason::Unavailable(
                        HistoryUnavailableReason::WorkspaceIdentityUnavailable,
                    ),
                ),
            ];
            let control = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            for (_, id, slot, _) in &cases {
                if let Some(slot) = slot {
                    store_history_slot(&snapshot, id, slot.clone());
                }
                corrupt_reference_rows(&snapshot, id);
            }
            let mut candidates: Vec<Candidate> = cases
                .iter()
                .map(|(name, id, _, _)| Candidate {
                    id: (*name).into(),
                    root_attempt_id: id.clone(),
                    adopted_input_ordinals: vec![0],
                    output: None,
                })
                .collect();
            candidates.push(Candidate {
                id: "control".into(),
                root_attempt_id: control,
                adopted_input_ordinals: vec![0],
                output: None,
            });
            let mut caller_budget = budget();
            caller_budget.max_candidates = candidates.len();
            caller_budget.max_attempts = candidates.len();
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            // The unreadable reference rows would fail the whole snapshot if
            // the gate read them; every candidate gets its own closed reason.
            let outcome = reauthorize_from_generation_snapshot(
                &snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                &candidates,
                &complete_current(&snapshot),
                NOW_MS,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("a gated attempt never stops the turn");
            for ((name, _, _, reason), result) in cases.iter().zip(&outcome.candidates) {
                assert_eq!(
                    result.disposition,
                    CandidateDisposition::Excluded(Failure::Incomplete(
                        IncompleteReason::HistoryContextUnusable(*reason)
                    )),
                    "{name}"
                );
            }
            assert_eq!(
                outcome.candidates.last().expect("control").disposition,
                CandidateDisposition::Qualified,
                "a known context is read into the recorded context, matches the current one \
                 and is judged by the rest of the checker"
            );
        }

        /// HC-1 (K4/3 section 6, section 8): a legacy (version 1) binding and a
        /// binding of an unknown version exclude their candidate with a closed
        /// reason. They no longer fail the snapshot, so an independent
        /// candidate in the same turn is still judged.
        #[test]
        fn history_legacy_and_unknown_binding_versions_exclude_the_candidate_not_the_turn() {
            let (_state, snapshot) = workspace_snapshot();
            let legacy = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            let future = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            let control = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            let store_binding = |id: &str, edit: &dyn Fn(&mut serde_json::Value)| {
                snapshot
                    .db()
                    .db()
                    .with_conn(|conn| {
                        let stored: String = conn.query_row(
                            "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                            [id],
                            |row| row.get(0),
                        )?;
                        let mut binding: serde_json::Value = serde_json::from_str(&stored)?;
                        edit(&mut binding);
                        conn.execute(
                            "UPDATE nir1_generation_attempts SET binding_json=?2 WHERE id=?1",
                            rusqlite::params![id, grimodex_core::canonical_json_string(&binding)?],
                        )?;
                        Ok(())
                    })
                    .expect("store the binding");
            };
            // Version 1 never wrote `bindingVersion` and had one `sessionId`.
            store_binding(&legacy, &|binding| {
                let v2 = binding.clone();
                *binding = json!({
                    "projectId": v2["projectId"],
                    "sessionId": v2["chatSessionId"],
                    "profileId": v2["caller"]["profileId"],
                    "callerId": v2["caller"]["callerId"],
                    "callerEpoch": v2["caller"]["callerEpoch"],
                    "workspaceBindingDigest": v2["workspaceBindingDigest"],
                    "purpose": v2["purpose"],
                    "scopeDigest": v2["scopeDigest"],
                    "materialDigest": v2["materialDigest"],
                    "d1Digest": v2["d1Digest"],
                    "routeRevision": v2["routeRevision"],
                    "provider": v2["provider"],
                    "model": v2["model"],
                    "api": v2["api"],
                    "endpointIdentity": v2["endpointIdentity"],
                });
            });
            store_binding(&future, &|binding| {
                binding["bindingVersion"] = json!(3);
                binding["historyTurnContext"] = json!({"turn": "a later writer"});
            });
            corrupt_reference_rows(&snapshot, &legacy);
            corrupt_reference_rows(&snapshot, &future);
            let candidates = [
                ("legacy", legacy.clone()),
                ("future", future.clone()),
                ("control", control),
            ]
            .map(|(name, id)| Candidate {
                id: name.into(),
                root_attempt_id: id,
                adopted_input_ordinals: vec![0],
                output: None,
            });
            let mut caller_budget = budget();
            caller_budget.max_candidates = candidates.len();
            caller_budget.max_attempts = candidates.len();
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            let outcome = reauthorize_from_generation_snapshot(
                &snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                &candidates,
                &complete_current(&snapshot),
                NOW_MS,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("a legacy or unknown-version binding never stops the turn");
            let dispositions = outcome
                .candidates
                .iter()
                .map(|result| result.disposition.clone())
                .collect::<Vec<_>>();
            assert_eq!(
                dispositions,
                [
                    CandidateDisposition::Excluded(Failure::Incomplete(
                        IncompleteReason::HistoryContextUnusable(
                            HistoryContextGateReason::LegacyBinding
                        )
                    )),
                    CandidateDisposition::Excluded(Failure::Incomplete(
                        IncompleteReason::HistoryContextUnusable(
                            HistoryContextGateReason::UnsupportedBindingVersion
                        )
                    )),
                    CandidateDisposition::Qualified,
                ],
                "the control is judged by the checker, not stopped by the other rows"
            );
        }

        /// HC-1 (K4/3 section 6, section 8 row 1): a parent of an unknown
        /// binding version that has a succeeded terminal excludes the child
        /// that adopts its generated output (no usable receipt).
        /// It does not fail the snapshot, so an independent candidate in the
        /// same turn is still judged.
        #[test]
        fn history_unknown_version_parent_with_a_terminal_excludes_the_child_not_the_turn() {
            use crate::nir1_generation::{
                claim_attempt, finish_attempt, read_attempt, InputRole, InputTarget, InputUse,
                NewMessageBody,
            };
            use grimodex_core::narrative_nir1_receipt::{
                Completion, OutputChannel, OutputObserver, ProviderTerminal,
            };
            let (_state, snapshot) = workspace_snapshot();
            let db = snapshot.db().db();
            let parent = storage_attempt(&snapshot);
            let stored = read_attempt(
                db,
                &parent,
                ReadBudget {
                    max_references: 16,
                    max_reference_bytes: 16_384,
                },
            )
            .expect("parent");
            assert!(claim_attempt(
                db,
                &parent,
                &stored.binding,
                1,
                ReadBudget {
                    max_references: 16,
                    max_reference_bytes: 16_384,
                }
            )
            .expect("claim"));
            let mut observer = OutputObserver::new();
            observer
                .observe(OutputChannel::Text, b"answer")
                .expect("text");
            observer
                .observe(OutputChannel::Thinking, b"")
                .expect("thinking");
            observer
                .observe_terminal(ProviderTerminal::Complete)
                .expect("terminal");
            let terminal = finish_attempt(
                db,
                &parent,
                &observer.finish(Completion::Parsed),
                Some(NewMessageBody {
                    message_id: "unknown-version-parent-message".into(),
                    content: "answer".into(),
                    thinking: String::new(),
                }),
                1,
            )
            .expect("finish");
            let output = terminal.message_version.expect("generated output");
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chat_messages(id,session_id,role,content)
                     VALUES ('unknown-version-current-human','generation-session','user','next')",
                    [],
                )?;
                Ok(())
            })
            .expect("current human body");
            let human = crate::nir1_generation::bind_human_message(
                db,
                "generation-project",
                "generation-session",
                "unknown-version-current-human",
                1,
            )
            .expect("bind the current human");
            let message_input =
                |role, version_id: &str, parent: Option<&str>, input_use| InputReference {
                    role,
                    target: InputTarget::Message {
                        version_id: version_id.into(),
                        parent_attempt_id: parent.map(str::to_owned),
                    },
                    input_use,
                };
            // A conversation attempt starts with its current turn; the
            // adopted generated output is its input 1.
            let child = storage_attempt_with(
                &snapshot,
                vec![
                    message_input(InputRole::User, &human.id, None, InputUse::CurrentTurn),
                    message_input(
                        InputRole::Assistant,
                        &output.id,
                        Some(&parent),
                        InputUse::AdoptedHistory,
                    ),
                ],
                {
                    use crate::nir1_generation::QualificationReference as Row;
                    use NotApplicableReason as Na;
                    use QualificationKind as K;
                    let scope = |ordinal, role, version: &str| {
                        Row::scope(
                            ordinal,
                            role,
                            scope_identity(role, &[STORAGE_SCENE]).expect("scope identity"),
                            version,
                        )
                    };
                    let rows = |ordinal: usize, source: &str, decision, d1: Row| {
                        vec![
                            Row::present(ordinal, K::Source, source, "v0"),
                            Row::not_applicable(ordinal, K::Revision, Na::NotARevision),
                            Row::not_applicable(ordinal, K::Decision, decision),
                            Row::not_applicable(ordinal, K::Freshness, Na::ImmutableMessageVersion),
                            Row::not_applicable(ordinal, K::Index, Na::NotIndexDerived),
                            scope(ordinal, ScopeRole::QuerySceneScope, "scope-token"),
                            scope(ordinal, ScopeRole::QuerySceneIncarnation, "incarnation-1"),
                            d1,
                        ]
                    };
                    let mut all = rows(
                        0,
                        &human.id,
                        Na::HumanAuthored,
                        Row::not_applicable(0, K::D1, Na::FixedUserSlot),
                    );
                    all.extend(rows(
                        1,
                        &output.id,
                        Na::DerivedFromParents,
                        Row::present(1, K::D1, "d1-selection", "d1-digest"),
                    ));
                    all
                },
            );
            let control = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            // The run of a later build: the parent keeps its terminal.
            db.with_conn(|conn| {
                let stored: String = conn.query_row(
                    "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                    [&parent],
                    |row| row.get(0),
                )?;
                let mut binding: serde_json::Value = serde_json::from_str(&stored)?;
                binding["bindingVersion"] = json!(3);
                conn.execute(
                    "UPDATE nir1_generation_attempts SET binding_json=?2 WHERE id=?1",
                    rusqlite::params![parent, grimodex_core::canonical_json_string(&binding)?],
                )?;
                Ok(())
            })
            .expect("store the later version");
            let candidates =
                [("child", child, 1), ("control", control, 0)].map(|(name, id, ordinal)| {
                    Candidate {
                        id: name.into(),
                        root_attempt_id: id,
                        adopted_input_ordinals: vec![ordinal],
                        output: None,
                    }
                });
            let mut caller_budget = budget();
            caller_budget.max_candidates = candidates.len();
            caller_budget.max_reference_count = 64;
            caller_budget.max_reference_bytes = 65_536;
            caller_budget.remaining_qualification_refs = 64;
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            let outcome = reauthorize_from_generation_snapshot(
                &snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                &candidates,
                &complete_current(&snapshot),
                NOW_MS,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("an unknown-version parent with a terminal never stops the turn");
            let dispositions = outcome
                .candidates
                .iter()
                .map(|result| result.disposition.clone())
                .collect::<Vec<_>>();
            assert_eq!(
                dispositions,
                [
                    // The reader gives the parent no receipt, so the adopted
                    // output has none to check; the parent is not traversed.
                    CandidateDisposition::Excluded(Failure::Incomplete(
                        IncompleteReason::MissingReceipt(parent)
                    )),
                    CandidateDisposition::Qualified,
                ]
            );
        }

        #[test]
        fn history_gate_maps_a_gated_attempt_without_inputs_and_keeps_the_known_form() {
            let (_state, snapshot) = workspace_snapshot();
            let known = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            let gated = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            store_history_slot(&snapshot, &gated, Some(unavailable_slot("binding-limit")));
            corrupt_reference_rows(&snapshot, &gated);
            let known = read_snapshot_attempt(&snapshot, &known);
            assert_eq!(known.context, HistoryContextState::Known);
            assert_eq!(known.inputs.len(), 1);
            let gated = read_snapshot_attempt(&snapshot, &gated);
            assert_eq!(
                gated.context,
                HistoryContextState::Gated(HistoryContextGateReason::Unavailable(
                    HistoryUnavailableReason::BindingLimit
                ))
            );
            assert!(gated.inputs.is_empty());
            assert!(gated.terminal.is_none());
            assert_eq!(gated.target_scene_id.as_deref(), Some(STORAGE_SCENE));
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
                    // The one-row fixture is structurally incomplete, so the
                    // writer stored `d-final-incomplete`. Restore a known
                    // context so this attempt still reaches its reference
                    // rows and the version 1 exclusion is what is tested.
                    let stored: String = conn.query_row(
                        "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                        [&v1_id],
                        |row| row.get(0),
                    )?;
                    let mut binding: AttemptBinding = serde_json::from_str(&stored)?;
                    binding.history_turn_context = Some(
                        crate::nir1_generation::history_context::HistoryContextSlot::Context(
                            Box::new(history_context_testing::sample_context()),
                        ),
                    );
                    conn.execute(
                        "UPDATE nir1_generation_attempts SET binding_json=?2 WHERE id=?1",
                        rusqlite::params![
                            v1_id,
                            grimodex_core::canonical_json_string(&serde_json::to_value(&binding)?)?
                        ],
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

        /// Run the adapter over `ids` as candidates (adopting input 0) and
        /// return each candidate's disposition.
        fn run_candidates(
            snapshot: &ActiveWorkspaceSnapshot,
            ids: &[String],
            current: &CurrentHistoryContext,
            now_ms: i64,
        ) -> Vec<CandidateDisposition> {
            let candidates: Vec<Candidate> = ids
                .iter()
                .map(|id| Candidate {
                    id: format!("candidate-{id}"),
                    root_attempt_id: id.clone(),
                    adopted_input_ordinals: vec![0],
                    output: None,
                })
                .collect();
            let mut caller_budget = budget();
            caller_budget.max_reference_count = 256;
            caller_budget.max_reference_bytes = 262_144;
            caller_budget.remaining_qualification_refs = 256;
            caller_budget.remaining_nodes = 32;
            caller_budget.remaining_edges = 32;
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            reauthorize_from_generation_snapshot(
                snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                &candidates,
                current,
                now_ms,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("history run")
            .candidates
            .into_iter()
            .map(|result| result.disposition)
            .collect()
        }

        /// K4/3 section 4: the caller's ID and session, the workspace binding
        /// digest, the profile and its epoch, the route and the material,
        /// scope and D1 digests are process-local or request-local. A
        /// difference in them alone does not exclude an attempt, and they are
        /// not part of the recorded context.
        #[test]
        fn context_does_not_compare_process_local_values() {
            let (_state, snapshot) = workspace_snapshot();
            let plain = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            let other_digest = format!("sha256:{}", "1".repeat(64));
            let moved =
                storage_attempt_edit(&snapshot, vec![raw_input()], raw_rows(), 1, |binding| {
                    binding.caller.caller_id = "another-caller".into();
                    binding.caller.caller_session_id = "another-caller-session".into();
                    binding.caller.profile_id = "another-profile".into();
                    binding.caller.caller_epoch = 99;
                    binding.workspace_binding_digest = other_digest.clone();
                    binding.route_revision = "another-route".into();
                    binding.scope_digest = other_digest.clone();
                    binding.material_digest = other_digest.clone();
                    binding.d1_digest = other_digest.clone();
                    binding.provider = "another-endpoint".into();
                    binding.model = "another-model".into();
                    binding.api = "another-api".into();
                    binding.endpoint_identity = other_digest.clone();
                });
            let outcome = run_candidates(
                &snapshot,
                &[plain.clone(), moved.clone()],
                &complete_current(&snapshot),
                NOW_MS,
            );
            assert_eq!(
                outcome,
                vec![CandidateDisposition::Qualified; 2],
                "a cold reopen or another route does not exclude history"
            );
            // The recorded context is the same for both.
            let plain = read_snapshot_attempt(&snapshot, &plain);
            let moved = read_snapshot_attempt(&snapshot, &moved);
            assert_eq!(plain.recorded, moved.recorded);
            let recorded = plain.recorded.expect("a known context is recorded");
            assert_eq!(recorded.created_at_ms, 1);
            assert_eq!(
                recorded.eligible_until_ms,
                (1 + HISTORY_ELIGIBILITY_WINDOW_MS) as u64,
                "the storage writer derives eligibleUntilMs from the row"
            );
            assert_eq!(recorded.context.range.chat_session_id, "generation-session");
            assert_eq!(
                recorded.context.durable_identity,
                Some(history_context_testing::sample_identity())
            );
        }

        /// The stored `eligibleUntilMs` and `created_at_ms` come from the row;
        /// the clock is the caller's (this module reads no clock).
        #[test]
        fn validity_window_applies_to_stored_attempts() {
            let (_state, snapshot) = workspace_snapshot();
            let created = 5_000;
            let id =
                storage_attempt_edit(&snapshot, vec![raw_input()], raw_rows(), created, |_| {});
            let current = complete_current(&snapshot);
            let run = |now_ms| {
                run_candidates(&snapshot, std::slice::from_ref(&id), &current, now_ms).remove(0)
            };
            let reason = |mismatch| {
                CandidateDisposition::Excluded(Failure::Ineligible(IneligibleReason::Context(
                    mismatch,
                )))
            };
            assert_eq!(
                run(created - 1),
                reason(ContextMismatch::ClockBeforeCreation)
            );
            assert_eq!(run(created), CandidateDisposition::Qualified);
            assert_eq!(
                run(created + HISTORY_ELIGIBILITY_WINDOW_MS - 1),
                CandidateDisposition::Qualified
            );
            assert_eq!(
                run(created + HISTORY_ELIGIBILITY_WINDOW_MS),
                reason(ContextMismatch::ValidityExpired)
            );
        }

        /// K4/3 section 6 and Mandatory defenses: an attempt without a usable
        /// context (null, unavailable, binding-limit) is never promoted. It
        /// has no recorded context to compare, whatever else its binding
        /// holds, and nothing later repairs it.
        #[test]
        fn no_repair_context_less_attempts_are_never_promoted() {
            let (_state, snapshot) = workspace_snapshot();
            let cases = [
                ("null", None),
                ("binding-limit", Some(unavailable_slot("binding-limit"))),
                (
                    "d-final-incomplete",
                    Some(unavailable_slot("d-final-incomplete")),
                ),
            ];
            let mut ids = Vec::new();
            for (_, slot) in &cases {
                // The binding still carries a durable identity and every
                // other value of a full attempt.
                let id = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
                store_history_slot(&snapshot, &id, slot.clone());
                ids.push(id);
            }
            for ((name, _), id) in cases.iter().zip(&ids) {
                let read = read_snapshot_attempt(&snapshot, id);
                assert!(read.recorded.is_none(), "{name}");
                assert!(
                    matches!(read.context, HistoryContextState::Gated(_)),
                    "{name}"
                );
            }
            let outcome = run_candidates(&snapshot, &ids, &complete_current(&snapshot), NOW_MS);
            for ((name, _), disposition) in cases.iter().zip(outcome) {
                assert!(
                    matches!(
                        disposition,
                        CandidateDisposition::Excluded(Failure::Incomplete(
                            IncompleteReason::HistoryContextUnusable(_)
                        ))
                    ),
                    "{name}: {disposition:?}"
                );
            }
        }

        /// K4/3 section 8: an unavailable current axis excludes all history;
        /// the traversal reads nothing and the turn goes on. The adapter does
        /// not even read the candidates' rows.
        #[test]
        fn current_axis_unavailable_excludes_all_history_without_reading_rows() {
            let (_state, snapshot) = workspace_snapshot();
            let id = storage_attempt_with(&snapshot, vec![raw_input()], raw_rows());
            let mut context = comparison_context("unused");
            context.axes.story_time = HistoryAxis::Unavailable(
                crate::nir1_generation::history_context::HistoryStoryTimeUnavailable::KeyAmbiguous,
            );
            let current = CurrentHistoryContext::Known(Box::new(context));
            let mut caller_budget = budget();
            let nodes = caller_budget.remaining_nodes;
            let attempts = caller_budget.max_attempts;
            let mut qualifier = AllowCurrent;
            let mut cancelled = || false;
            let outcome = reauthorize_from_generation_snapshot(
                &snapshot,
                ParticipantSqlControl::default(),
                &mut caller_budget,
                &[Candidate {
                    id: "candidate".into(),
                    root_attempt_id: id,
                    adopted_input_ordinals: vec![0],
                    output: None,
                }],
                &current,
                NOW_MS,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("the turn goes on");
            assert_eq!(
                outcome.candidates[0].disposition,
                CandidateDisposition::Excluded(Failure::Incomplete(
                    IncompleteReason::CurrentContextUnavailable(CurrentContextUnavailable::Axis(
                        HistoryAxisName::StoryTime
                    ))
                ))
            );
            assert_eq!(caller_budget.remaining_nodes, nodes, "no node was visited");
            assert_eq!(caller_budget.max_attempts, attempts);
        }
    }
}

#[allow(unused_imports)]
pub(crate) use generation_storage_adapter::reauthorize_from_generation_snapshot;
#[cfg(feature = "native-current-human-capture")]
#[allow(unused_imports)]
pub(crate) use generation_storage_adapter::session_run::{
    reauthorize_session_history, reauthorize_session_history_for_turn,
    reauthorize_session_history_for_turn_in_tx, reauthorize_session_history_in_tx,
    HistoryAttemptMaterial, HistoryMessageMaterial, InFlightAttempt, NoHistory,
    SessionCandidateKind, SessionCandidateResult, SessionHistoryOutcome, SessionHistoryRequest,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nir1_generation::history_context::testing as history_context_testing;
    use crate::nir1_generation::history_context::{HistoryDigestDomain, HistoryInt};
    use crate::nir1_generation::scope_identity;

    struct AllowCurrent {
        pending_graph: bool,
    }

    impl CurrentQualifier for AllowCurrent {
        fn qualify_attempt(
            &mut self,
            _attempt: &AttemptSnapshot,
            _current: &HistoryComparisonContext,
        ) -> QualificationStatus {
            QualificationStatus::Current
        }

        fn qualify_input(
            &mut self,
            _attempt: &AttemptSnapshot,
            _ordinal: usize,
            input: &HistoryInput,
            _current: &HistoryComparisonContext,
        ) -> QualificationStatus {
            if self.pending_graph && matches!(&input.kind, HistoryInputKind::GraphEvidence { .. }) {
                QualificationStatus::Pending
            } else {
                QualificationStatus::Current
            }
        }

        fn qualify_generated_output(
            &mut self,
            _parent: &AttemptSnapshot,
            _version_id: &str,
            _recorded_body_digest: &str,
            _current: &HistoryComparisonContext,
        ) -> QualificationStatus {
            QualificationStatus::Current
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

    /// The clock of the pure tests: inside every attempt's window.
    const NOW_MS: i64 = 1_000;
    const CREATED_AT_MS: i64 = 100;

    fn comparison_context() -> HistoryComparisonContext {
        let context = history_context_testing::sample_context();
        HistoryComparisonContext {
            range: HistoryRange {
                project_id: "project-q".into(),
                chat_session_id: "session-q".into(),
                scene_id: TARGET_SCENE.into(),
                scene_incarnation_id: "incarnation-q".into(),
            },
            purpose: GenerationPurpose::Writing,
            durable_identity: Some(history_context_testing::sample_identity()),
            send_classification: context.send_classification,
            restore_epoch: context.restore_epoch,
            target: context.target,
            axes: context.axes,
        }
    }

    fn recorded_context() -> RecordedHistoryContext {
        RecordedHistoryContext {
            context: comparison_context(),
            created_at_ms: CREATED_AT_MS,
            eligible_until_ms: (CREATED_AT_MS + HISTORY_ELIGIBILITY_WINDOW_MS) as u64,
            d1: crate::nir1_generation::history_context::testing::sample_context().d1,
        }
    }

    /// The current turn's context, equal to what every test attempt recorded.
    fn current_context() -> CurrentHistoryContext {
        CurrentHistoryContext::Known(Box::new(comparison_context()))
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
            output_body_digest: None,
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
            recorded: Some(recorded_context()),
            inputs,
            terminal,
            project_id: None,
            session_id: None,
            target_scene_id: Some(TARGET_SCENE.into()),
            reference_format: ReferenceFormat::V2,
            context: HistoryContextState::Known,
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
            output: None,
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
            &current_context(),
            NOW_MS,
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
            output: None,
        }];
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &candidates,
            &current_context(),
            NOW_MS,
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
                output: None,
            },
            Candidate {
                id: "good-candidate".into(),
                root_attempt_id: "good".into(),
                adopted_input_ordinals: vec![0],
                output: None,
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
            &current_context(),
            NOW_MS,
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: true,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
    fn missing_recorded_context_fails_closed_before_input_adoption() {
        let mut root = attempt("root", vec![raw("source")], None);
        root.recorded = None;
        let graph = snapshot(vec![root]);
        let candidate = Candidate {
            id: "missing-recorded-context".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(
                IncompleteReason::RecordedContextMissing
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
    fn current_turn_human_held_by_its_own_attempt_is_adopted() {
        let human = history_input(
            HistoryInputKind::HumanMessage {
                version_id: "human:v1".into(),
                lineage: HumanLineage::Qualified {
                    owner_attempt_id: "root".into(),
                },
            },
            InputUse::CurrentTurn,
        );
        let graph = snapshot(vec![attempt("root", vec![human], None)]);
        let candidate = Candidate {
            id: "current-human".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
    fn context_mismatch_and_capture_less_human_fail_closed() {
        let mut stale = attempt("stale", vec![raw("source")], None);
        stale
            .recorded
            .as_mut()
            .expect("recorded context")
            .context
            .target
            .binding_token_digest = history_context_testing::digest(
            HistoryDigestDomain::ScopeBindingToken,
            "an older Scope binding token",
        );
        let legacy = history_input(
            HistoryInputKind::HumanMessage {
                version_id: "legacy".into(),
                lineage: HumanLineage::Rejected(HumanLineageReason::CaptureMissing),
            },
            InputUse::AdoptedHistory,
        );
        let graph = snapshot(vec![stale, attempt("legacy-root", vec![legacy], None)]);
        let candidates = [
            Candidate {
                id: "stale".into(),
                root_attempt_id: "stale".into(),
                adopted_input_ordinals: vec![0],
                output: None,
            },
            Candidate {
                id: "legacy".into(),
                root_attempt_id: "legacy-root".into(),
                adopted_input_ordinals: vec![0],
                output: None,
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
            &current_context(),
            NOW_MS,
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete");

        assert!(matches!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Ineligible(IneligibleReason::Context(
                ContextMismatch::ScopeBindingTokenChanged
            )))
        ));
        assert!(matches!(
            outcome.candidates[1].disposition,
            CandidateDisposition::Excluded(Failure::Incomplete(IncompleteReason::HumanLineage(
                HumanLineageReason::CaptureMissing
            )))
        ));
    }

    #[test]
    fn shared_budget_is_not_reset_and_exhaustion_excludes_the_unverified_candidate() {
        let graph = snapshot(vec![
            attempt("a", vec![raw("source-a")], None),
            attempt("b", vec![raw("source-b")], None),
        ]);
        let candidates = [
            Candidate {
                id: "a".into(),
                root_attempt_id: "a".into(),
                adopted_input_ordinals: vec![0],
                output: None,
            },
            Candidate {
                id: "b".into(),
                root_attempt_id: "b".into(),
                adopted_input_ordinals: vec![0],
                output: None,
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
            &current_context(),
            NOW_MS,
            &mut remaining,
            &mut current,
            &mut cancelled,
        );

        // K4/3 section 8: an exhausted budget excludes the candidate whose
        // verification was not finished and keeps the one that was.
        let outcome = run.expect("an exhausted budget is not a stop of the run");
        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Qualified
        );
        assert_eq!(
            outcome.candidates[1].disposition,
            CandidateDisposition::Excluded(Failure::incomplete(IncompleteReason::BudgetExhausted))
        );
    }

    fn run_candidates(graph: &HistorySnapshot, candidates: &[Candidate]) -> Vec<CandidateResult> {
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        reauthorize_history(
            graph,
            candidates,
            &current_context(),
            NOW_MS,
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("history run should complete")
        .candidates
    }

    fn human_candidate(id: &str, root: &str) -> Candidate {
        Candidate {
            id: id.into(),
            root_attempt_id: root.into(),
            adopted_input_ordinals: vec![0],
            output: None,
        }
    }

    fn output_candidate(id: &str, parent: &str, version: &str) -> Candidate {
        Candidate {
            id: id.into(),
            root_attempt_id: parent.into(),
            adopted_input_ordinals: Vec::new(),
            output: Some(GeneratedOutput {
                version_id: version.into(),
            }),
        }
    }

    fn adopted_human(owner: &str) -> HistoryInput {
        history_input(
            HistoryInputKind::HumanMessage {
                version_id: "human:v1".into(),
                lineage: HumanLineage::Qualified {
                    owner_attempt_id: owner.into(),
                },
            },
            InputUse::AdoptedHistory,
        )
    }

    #[test]
    fn human_lineage_rule_3_the_holder_must_be_the_attempt_whose_turn_it_is() {
        // Rule 3: the one attempt that holds the Human at ordinal 0 is the
        // attempt whose current turn it is. A current-turn Human whose holder
        // is another attempt is out; an adopted Human leads to its holder
        // and is out when the adopting attempt is the holder itself.
        let graph = snapshot(vec![
            attempt("elsewhere", vec![owned_human("someone-else")], None),
            attempt("self-adopter", vec![adopted_human("self-adopter")], None),
            attempt("adopter", vec![adopted_human("holder")], None),
            attempt("holder", vec![owned_human("holder")], None),
        ]);
        let results = run_candidates(
            &graph,
            &[
                human_candidate("elsewhere", "elsewhere"),
                human_candidate("self-adopter", "self-adopter"),
                human_candidate("adopter", "adopter"),
                human_candidate("holder", "holder"),
            ],
        );
        let mismatch = CandidateDisposition::Excluded(Failure::incomplete(
            IncompleteReason::HumanLineage(HumanLineageReason::OrdinalZeroAttemptMismatch),
        ));
        assert_eq!(results[0].disposition, mismatch);
        assert_eq!(results[1].disposition, mismatch);
        assert_eq!(results[2].disposition, CandidateDisposition::Qualified);
        assert_eq!(
            results[2].visited_attempts,
            vec!["adopter".to_string(), "holder".to_string()]
        );
        assert_eq!(results[3].disposition, CandidateDisposition::Qualified);
    }

    #[test]
    fn adopted_human_is_out_with_the_holder_when_the_holders_context_does_not_match() {
        let mut stale_holder = attempt("holder", vec![owned_human("holder")], None);
        stale_holder
            .recorded
            .as_mut()
            .expect("recorded context")
            .context
            .target
            .binding_token_digest = history_context_testing::digest(
            HistoryDigestDomain::ScopeBindingToken,
            "an older Scope binding token",
        );
        let graph = snapshot(vec![
            attempt("adopter", vec![adopted_human("holder")], None),
            stale_holder,
        ]);
        let results = run_candidates(&graph, &[human_candidate("adopter", "adopter")]);
        assert_eq!(
            results[0].disposition,
            CandidateDisposition::Excluded(Failure::ineligible(IneligibleReason::Context(
                ContextMismatch::ScopeBindingTokenChanged
            )))
        );
    }

    #[test]
    fn human_lineage_rejections_are_closed_reasons_checked_before_the_qualifier() {
        struct Never;
        impl CurrentQualifier for Never {
            fn qualify_attempt(
                &mut self,
                _attempt: &AttemptSnapshot,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }
            fn qualify_input(
                &mut self,
                _attempt: &AttemptSnapshot,
                _ordinal: usize,
                _input: &HistoryInput,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                panic!("a rejected lineage is not requalified");
            }
            fn qualify_generated_output(
                &mut self,
                _parent: &AttemptSnapshot,
                _version_id: &str,
                _recorded_body_digest: &str,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }
        }
        let reasons = [
            HumanLineageReason::Unresolved,
            HumanLineageReason::HumanNotHuman,
            HumanLineageReason::MessageVersionInvalidated,
            HumanLineageReason::CaptureMissing,
            HumanLineageReason::CaptureScopeMismatch,
            HumanLineageReason::CaptureNotSuperseded(HistoryCaptureState::Current),
            HumanLineageReason::CaptureNotSuperseded(HistoryCaptureState::Cancelled),
            HumanLineageReason::CaptureNotSuperseded(HistoryCaptureState::Closed),
            HumanLineageReason::NoOrdinalZeroAttempt,
            HumanLineageReason::MultipleOrdinalZeroAttempts,
            HumanLineageReason::OrdinalZeroUncountable,
        ];
        for reason in reasons {
            let human = history_input(
                HistoryInputKind::HumanMessage {
                    version_id: "human:v1".into(),
                    lineage: HumanLineage::Rejected(reason),
                },
                InputUse::CurrentTurn,
            );
            let graph = snapshot(vec![attempt("root", vec![human], None)]);
            let mut qualifier = Never;
            let mut remaining = budget();
            let mut cancelled = || false;
            let outcome = reauthorize_history(
                &graph,
                &[human_candidate("candidate", "root")],
                &current_context(),
                NOW_MS,
                &mut remaining,
                &mut qualifier,
                &mut cancelled,
            )
            .expect("history run should complete");
            assert_eq!(
                outcome.candidates[0].disposition,
                CandidateDisposition::Excluded(Failure::incomplete(
                    IncompleteReason::HumanLineage(reason)
                )),
                "{reason:?}"
            );
        }
    }

    fn receipt_for_output(
        attempt_id: &str,
        output_version: &str,
        body_digest: Option<&str>,
    ) -> TerminalReceipt {
        TerminalReceipt {
            output_body_digest: body_digest.map(str::to_owned),
            ..receipt(attempt_id, "receipt", Some(output_version))
        }
    }

    #[test]
    fn generated_output_candidate_needs_the_parents_succeeded_receipt_of_this_output() {
        let parent = |terminal: Option<TerminalReceipt>| {
            attempt(
                "parent",
                vec![owned_human("parent"), raw("source")],
                terminal,
            )
        };
        let graph = |terminal: Option<TerminalReceipt>| snapshot(vec![parent(terminal)]);
        let candidate = [output_candidate("output", "parent", "m1")];
        // A succeeded receipt that names the output and its digest: adopted,
        // with the parent's whole turn visited.
        let results = run_candidates(
            &graph(Some(receipt_for_output("parent", "m1", Some("sha256:out")))),
            &candidate,
        );
        assert_eq!(results[0].disposition, CandidateDisposition::Qualified);
        assert_eq!(results[0].visited_attempts, vec!["parent".to_string()]);
        let missing = |reason| CandidateDisposition::Excluded(Failure::incomplete(reason));
        // No receipt at all.
        assert_eq!(
            run_candidates(&graph(None), &candidate)[0].disposition,
            missing(IncompleteReason::MissingReceipt("parent".into()))
        );
        // A receipt that is not a success.
        let mut failed = receipt_for_output("parent", "m1", Some("sha256:out"));
        failed.successful = false;
        assert_eq!(
            run_candidates(&graph(Some(failed)), &candidate)[0].disposition,
            missing(IncompleteReason::ReceiptMismatch("parent".into()))
        );
        // A receipt that names another output, one for another attempt, and
        // one that records no body digest.
        for terminal in [
            receipt_for_output("parent", "another-output", Some("sha256:out")),
            receipt_for_output("another-attempt", "m1", Some("sha256:out")),
            receipt_for_output("parent", "m1", None),
        ] {
            assert_eq!(
                run_candidates(&graph(Some(terminal)), &candidate)[0].disposition,
                missing(IncompleteReason::ReceiptMismatch("parent".into()))
            );
        }
    }

    #[test]
    fn generated_output_candidate_is_out_when_the_parents_turn_or_the_output_is() {
        let terminal = || Some(receipt_for_output("parent", "m1", Some("sha256:out")));
        // The parent's own input is stale: the output goes with it.
        struct RejectRaw;
        impl CurrentQualifier for RejectRaw {
            fn qualify_attempt(
                &mut self,
                _attempt: &AttemptSnapshot,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }
            fn qualify_input(
                &mut self,
                _attempt: &AttemptSnapshot,
                _ordinal: usize,
                input: &HistoryInput,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                if matches!(input.kind, HistoryInputKind::RawSource { .. }) {
                    QualificationStatus::Excluded(RequalificationReason::SourceStale)
                } else {
                    QualificationStatus::Current
                }
            }
            fn qualify_generated_output(
                &mut self,
                _parent: &AttemptSnapshot,
                _version_id: &str,
                _recorded_body_digest: &str,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Excluded(RequalificationReason::MessageVersionInvalid)
            }
        }
        let graph = snapshot(vec![attempt(
            "parent",
            vec![owned_human("parent"), raw("source")],
            terminal(),
        )]);
        let mut qualifier = RejectRaw;
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[output_candidate("output", "parent", "m1")],
            &current_context(),
            NOW_MS,
            &mut remaining,
            &mut qualifier,
            &mut cancelled,
        )
        .expect("history run should complete");
        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::ineligible(IneligibleReason::Requalification(
                RequalificationReason::SourceStale
            )))
        );
        // With the input current, the output itself is judged by the live
        // message version.
        struct RejectOutput;
        impl CurrentQualifier for RejectOutput {
            fn qualify_attempt(
                &mut self,
                _attempt: &AttemptSnapshot,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }
            fn qualify_input(
                &mut self,
                _attempt: &AttemptSnapshot,
                _ordinal: usize,
                _input: &HistoryInput,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                QualificationStatus::Current
            }
            fn qualify_generated_output(
                &mut self,
                _parent: &AttemptSnapshot,
                version_id: &str,
                recorded_body_digest: &str,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                assert_eq!((version_id, recorded_body_digest), ("m1", "sha256:out"));
                QualificationStatus::Excluded(RequalificationReason::MessageVersionInvalid)
            }
        }
        let mut qualifier = RejectOutput;
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[output_candidate("output", "parent", "m1")],
            &current_context(),
            NOW_MS,
            &mut remaining,
            &mut qualifier,
            &mut cancelled,
        )
        .expect("history run should complete");
        assert_eq!(
            outcome.candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::ineligible(IneligibleReason::Requalification(
                RequalificationReason::MessageVersionInvalid
            )))
        );
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
                output: None,
            },
            Candidate {
                id: "second".into(),
                root_attempt_id: "second".into(),
                adopted_input_ordinals: vec![0],
                output: None,
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
            &current_context(),
            NOW_MS,
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

    /// The Human of `owner`'s current turn, held at ordinal 0 by `owner`.
    fn owned_human(owner: &str) -> HistoryInput {
        history_input(
            HistoryInputKind::HumanMessage {
                version_id: "human:v1".into(),
                lineage: HumanLineage::Qualified {
                    owner_attempt_id: owner.into(),
                },
            },
            InputUse::CurrentTurn,
        )
    }

    fn current_human() -> HistoryInput {
        owned_human("root")
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
        // `owner-turn` is the attempt whose current turn an adopted past
        // Human was.
        let graph = snapshot(vec![
            root,
            attempt("owner-turn", vec![owned_human("owner-turn")], None),
        ]);
        let candidate = Candidate {
            id: "candidate".into(),
            root_attempt_id: "root".into(),
            adopted_input_ordinals: vec![0],
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
                        lineage: HumanLineage::Qualified {
                            owner_attempt_id: "owner-turn".into(),
                        },
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
            output: None,
        };
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &[candidate],
            &current_context(),
            NOW_MS,
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
            output: None,
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
            &current_context(),
            NOW_MS,
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
                output: None,
            },
            Candidate {
                id: "parent".into(),
                root_attempt_id: "parent".into(),
                adopted_input_ordinals: vec![0],
                output: None,
            },
            Candidate {
                id: "independent".into(),
                root_attempt_id: "independent".into(),
                adopted_input_ordinals: vec![0],
                output: None,
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
            &current_context(),
            NOW_MS,
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

    fn gated(mut attempt: AttemptSnapshot, reason: HistoryContextGateReason) -> AttemptSnapshot {
        attempt.context = HistoryContextState::Gated(reason);
        attempt
    }

    fn gate_reason(reason: HistoryUnavailableReason) -> IncompleteReason {
        IncompleteReason::HistoryContextUnusable(HistoryContextGateReason::Unavailable(reason))
    }

    #[test]
    fn history_gate_d_final_incomplete_excludes_candidate_and_descendants() {
        // The parent's reference rows look complete and its receipt is
        // valid: nothing but the slot excludes it. A structure-only checker
        // would otherwise qualify an output that breaks rule 3.
        let parent = gated(
            attempt(
                "parent",
                vec![raw("source-x")],
                Some(receipt("parent", "receipt-parent", Some("m1"))),
            ),
            HistoryContextGateReason::Unavailable(HistoryUnavailableReason::DFinalIncomplete),
        );
        let graph = snapshot(vec![
            attempt(
                "child",
                vec![generated("m1", "parent", "receipt-parent")],
                None,
            ),
            parent,
            attempt("independent", vec![raw("source")], None),
        ]);
        let candidates = ["child", "parent", "independent"].map(|id| Candidate {
            id: id.into(),
            root_attempt_id: id.into(),
            adopted_input_ordinals: vec![0],
            output: None,
        });
        let mut current = AllowCurrent {
            pending_graph: false,
        };
        let mut remaining = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &candidates,
            &current_context(),
            NOW_MS,
            &mut remaining,
            &mut current,
            &mut cancelled,
        )
        .expect("the turn is not stopped");
        let reason = gate_reason(HistoryUnavailableReason::DFinalIncomplete);
        assert_eq!(
            outcome.candidates[0].disposition,
            excluded(reason.clone()),
            "a descendant of a gated attempt carries the parent's closed reason"
        );
        assert_eq!(outcome.candidates[1].disposition, excluded(reason));
        assert_eq!(
            outcome.candidates[2].disposition,
            CandidateDisposition::Qualified,
            "an independent branch survives"
        );
    }

    #[test]
    fn history_gate_precedes_the_completeness_checker_and_the_context_check() {
        let reason = gate_reason(HistoryUnavailableReason::DFinalIncomplete);
        let gate =
            HistoryContextGateReason::Unavailable(HistoryUnavailableReason::DFinalIncomplete);
        // A complete structure and a matching context: the slot still excludes.
        assert_eq!(
            disposition_of_attempt(gated(attempt("root", vec![raw("source")], None), gate)),
            excluded(reason.clone())
        );
        // An incomplete structure under a gated slot is reported as the gate,
        // not as the completeness rule (the checker never sees the rows).
        assert_eq!(
            disposition_of_attempt(gated(
                attempt(
                    "root",
                    vec![without_kind(raw("source"), QualificationKind::Freshness)],
                    None,
                ),
                gate,
            )),
            excluded(reason.clone())
        );
        // A missing or different recorded context does not change the gate's
        // verdict: the gate precedes the context comparison.
        let mut no_recorded = gated(attempt("root", vec![raw("source")], None), gate);
        no_recorded.recorded = None;
        assert_eq!(
            disposition_of_attempt(no_recorded),
            excluded(reason.clone())
        );
        let mut other_context = gated(attempt("root", vec![raw("source")], None), gate);
        other_context
            .recorded
            .as_mut()
            .expect("recorded context")
            .context
            .restore_epoch
            .number = HistoryInt::new(999).expect("int");
        assert_eq!(disposition_of_attempt(other_context), excluded(reason));
        // A known context: the completeness rule applies.
        assert_eq!(
            disposition(without_kind(raw("source"), QualificationKind::Freshness)),
            excluded(IncompleteReason::MissingQualification(
                QualificationKind::Freshness
            ))
        );
        // A known context whose recorded context could not be read.
        let mut unfilled = attempt("root", vec![raw("source")], None);
        unfilled.recorded = None;
        assert_eq!(
            disposition_of_attempt(unfilled),
            excluded(IncompleteReason::RecordedContextMissing)
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

    // ---- HC1-2: the comparison of the turn's context (K4/3 sections 4, 5, 7) ----

    use crate::nir1_generation::history_context::{
        HistoryAuto, HistoryEffectiveAxis, HistoryPhaseSetting, HistoryPrincipal,
        HistoryReadingOrderUnavailable, HistoryScopeRef, HistoryScopeRefUnavailable,
        HistoryStoryTimeUnavailable, HistoryViewpointUnavailable,
    };

    fn other(
        domain: HistoryDigestDomain,
    ) -> crate::nir1_generation::history_context::HistoryDigest {
        history_context_testing::digest(domain, "another value")
    }

    fn compared(recorded: &RecordedHistoryContext) -> Result<(), ContextMismatch> {
        compare_context(&comparison_context(), recorded, NOW_MS)
    }

    fn excluded_by(mismatch: ContextMismatch) -> CandidateDisposition {
        CandidateDisposition::Excluded(Failure::Ineligible(IneligibleReason::Context(mismatch)))
    }

    #[test]
    fn context_equal_when_every_compared_field_matches() {
        assert_eq!(compared(&recorded_context()), Ok(()));
        assert_eq!(
            disposition(raw("source")),
            CandidateDisposition::Qualified,
            "the traversal accepts the same pair"
        );
    }

    /// A recorded value that differs in exactly one compared item is
    /// excluded for that item, never for another one.
    #[test]
    fn context_mismatch_is_reported_per_field() {
        type Mutate = fn(&mut RecordedHistoryContext);
        let cases: Vec<(&str, Mutate, ContextMismatch)> = vec![
            (
                "project",
                |r| r.context.range.project_id = "another-project".into(),
                ContextMismatch::ProjectMismatch,
            ),
            (
                "chat session",
                |r| r.context.range.chat_session_id = "another-session".into(),
                ContextMismatch::ChatSessionMismatch,
            ),
            (
                "scene",
                |r| r.context.range.scene_id = "another-scene".into(),
                ContextMismatch::SceneMismatch,
            ),
            (
                "scene incarnation",
                |r| r.context.range.scene_incarnation_id = "another-incarnation".into(),
                ContextMismatch::SceneIncarnationMismatch,
            ),
            (
                "readingOrder",
                |r| {
                    if let HistoryAxis::Present(reading) = &mut r.context.axes.reading_order {
                        reading.rank = HistoryInt::new(reading.rank.get() + 1).expect("int");
                    }
                },
                ContextMismatch::AxisChanged(HistoryAxisName::ReadingOrder),
            ),
            (
                "storyTime",
                |r| {
                    if let HistoryAxis::Present(story) = &mut r.context.axes.story_time {
                        story.raw_key_digest = other(HistoryDigestDomain::StoryRawKey);
                    }
                },
                ContextMismatch::AxisChanged(HistoryAxisName::StoryTime),
            ),
            (
                "viewpoint",
                |r| {
                    r.context.axes.viewpoint = HistoryAxis::Present(
                        crate::nir1_generation::history_context::HistoryViewpoint {
                            pov_digest: other(HistoryDigestDomain::PovCharacter),
                        },
                    )
                },
                ContextMismatch::AxisChanged(HistoryAxisName::Viewpoint),
            ),
            (
                "knowledgeHolder",
                |r| {
                    r.context.axes.knowledge_holder = HistoryAxis::Present(HistoryPrincipal::Reader)
                },
                ContextMismatch::AxisChanged(HistoryAxisName::KnowledgeHolder),
            ),
            (
                "audience",
                |r| {
                    r.context.axes.audience = HistoryAxis::Present(HistoryPrincipal::Character(
                        other(HistoryDigestDomain::PrincipalCharacter),
                    ))
                },
                ContextMismatch::AxisChanged(HistoryAxisName::Audience),
            ),
            (
                "timeline",
                |r| {
                    r.context.axes.timeline = HistoryAxis::Present(HistoryScopeRef {
                        ref_digest: other(HistoryDigestDomain::TimelineRef),
                    })
                },
                ContextMismatch::AxisChanged(HistoryAxisName::Timeline),
            ),
            (
                "worldline",
                |r| {
                    r.context.axes.worldline = HistoryAxis::Present(HistoryScopeRef {
                        ref_digest: other(HistoryDigestDomain::WorldlineRef),
                    })
                },
                ContextMismatch::AxisChanged(HistoryAxisName::Worldline),
            ),
            (
                "narrativeLayer",
                |r| {
                    r.context.axes.narrative_layer = HistoryAxis::Present(HistoryScopeRef {
                        ref_digest: other(HistoryDigestDomain::NarrativeLayerRef),
                    })
                },
                ContextMismatch::AxisChanged(HistoryAxisName::NarrativeLayer),
            ),
            (
                "auto",
                |r| {
                    r.context.axes.auto = HistoryAxis::Present(HistoryAuto {
                        setting: HistoryPhaseSetting::Reading,
                        axis: HistoryEffectiveAxis::Reading,
                        fallback: None,
                    })
                },
                ContextMismatch::AxisChanged(HistoryAxisName::Auto),
            ),
            (
                "Scope binding token",
                |r| {
                    r.context.target.binding_token_digest =
                        other(HistoryDigestDomain::ScopeBindingToken)
                },
                ContextMismatch::ScopeBindingTokenChanged,
            ),
            (
                "Scope binding version",
                |r| {
                    r.context.target.version =
                        HistoryInt::new(r.context.target.version.get() + 1).expect("int")
                },
                ContextMismatch::ScopeBindingVersionChanged,
            ),
            (
                "purpose",
                |r| r.context.purpose = GenerationPurpose::Review,
                ContextMismatch::PurposeMismatch,
            ),
            (
                "durable workspace id",
                |r| {
                    r.context.durable_identity = Some(
                        DurableWorkspaceIdentity::from_parts(
                            "another-workspace",
                            "/canonical/workspace/root",
                        )
                        .expect("identity"),
                    )
                },
                ContextMismatch::DurableIdentityMismatch,
            ),
            (
                "durable canonical locator",
                |r| {
                    r.context.durable_identity = Some(
                        DurableWorkspaceIdentity::from_parts("workspace-id", "/another/root")
                            .expect("identity"),
                    )
                },
                ContextMismatch::DurableIdentityMismatch,
            ),
            (
                "restore epoch id",
                |r| r.context.restore_epoch.id_digest = other(HistoryDigestDomain::RestoreEpochId),
                ContextMismatch::RestoreEpochMismatch,
            ),
            (
                "restore epoch number",
                |r| {
                    r.context.restore_epoch.number =
                        HistoryInt::new(r.context.restore_epoch.number.get() + 1).expect("int")
                },
                ContextMismatch::RestoreEpochMismatch,
            ),
        ];
        for (name, mutate, expected) in cases {
            let mut recorded = recorded_context();
            mutate(&mut recorded);
            assert_eq!(compared(&recorded), Err(expected), "{name}");
            let mut stale = attempt("root", vec![raw("source")], None);
            stale.recorded = Some(recorded);
            assert_eq!(
                disposition_of_attempt(stale),
                excluded_by(expected),
                "{name} excludes the candidate"
            );
        }
        // Equal send classification is the only value; the comparison still
        // names the item (the enum has one case today).
        let mut recorded = recorded_context();
        recorded.context.send_classification = HistorySendClassification::LocalOnly;
        assert_eq!(compared(&recorded), Ok(()));
    }

    fn set_axis_unavailable(context: &mut HistoryComparisonContext, name: HistoryAxisName) {
        let axes = &mut context.axes;
        match name {
            HistoryAxisName::ReadingOrder => {
                axes.reading_order = HistoryAxis::Unavailable(
                    HistoryReadingOrderUnavailable::SceneNotInAuthorityMapping,
                )
            }
            HistoryAxisName::StoryTime => {
                axes.story_time =
                    HistoryAxis::Unavailable(HistoryStoryTimeUnavailable::KeyNotProvided)
            }
            HistoryAxisName::Viewpoint => {
                axes.viewpoint = HistoryAxis::Unavailable(HistoryViewpointUnavailable::NotProvided)
            }
            HistoryAxisName::KnowledgeHolder => {
                axes.knowledge_holder = HistoryAxis::Unavailable(
                    crate::nir1_generation::history_context::HistoryPrincipalUnavailable::BindingNotExplicit,
                )
            }
            HistoryAxisName::Audience => {
                axes.audience = HistoryAxis::Unavailable(
                    crate::nir1_generation::history_context::HistoryPrincipalUnavailable::BindingNotExplicit,
                )
            }
            HistoryAxisName::Timeline => {
                axes.timeline = HistoryAxis::Unavailable(HistoryScopeRefUnavailable::Unresolved)
            }
            HistoryAxisName::Worldline => {
                axes.worldline = HistoryAxis::Unavailable(HistoryScopeRefUnavailable::Any)
            }
            HistoryAxisName::NarrativeLayer => {
                axes.narrative_layer =
                    HistoryAxis::Unavailable(HistoryScopeRefUnavailable::BindingNotExplicit)
            }
            HistoryAxisName::Auto => {
                axes.auto = HistoryAxis::Unavailable(
                    crate::nir1_generation::history_context::HistoryAutoUnavailable::SceneNotInAuthorityMapping,
                )
            }
        }
    }

    const ALL_AXES: [HistoryAxisName; 9] = [
        HistoryAxisName::ReadingOrder,
        HistoryAxisName::StoryTime,
        HistoryAxisName::Viewpoint,
        HistoryAxisName::KnowledgeHolder,
        HistoryAxisName::Audience,
        HistoryAxisName::Timeline,
        HistoryAxisName::Worldline,
        HistoryAxisName::NarrativeLayer,
        HistoryAxisName::Auto,
    ];

    #[test]
    fn context_unavailable_on_both_sides_is_not_a_match() {
        for name in ALL_AXES {
            // Unavailable on both sides.
            let mut current = comparison_context();
            set_axis_unavailable(&mut current, name);
            let mut recorded = recorded_context();
            set_axis_unavailable(&mut recorded.context, name);
            assert_eq!(
                compare_context(&current, &recorded, NOW_MS),
                Err(ContextMismatch::AxisUnavailable(name)),
                "{name:?} on both sides"
            );
            // Unavailable only on the recorded side, or only on the current.
            let mut only_recorded = recorded_context();
            set_axis_unavailable(&mut only_recorded.context, name);
            assert_eq!(
                compared(&only_recorded),
                Err(ContextMismatch::AxisUnavailable(name)),
                "{name:?} recorded"
            );
            assert_eq!(
                compare_context(&current, &recorded_context(), NOW_MS),
                Err(ContextMismatch::AxisUnavailable(name)),
                "{name:?} current"
            );
        }
        // Neither identity is present.
        let mut current = comparison_context();
        current.durable_identity = None;
        let mut recorded = recorded_context();
        recorded.context.durable_identity = None;
        assert_eq!(
            compare_context(&current, &recorded, NOW_MS),
            Err(ContextMismatch::DurableIdentityMismatch)
        );
    }

    #[test]
    fn context_missing_or_unknown_values_never_match() {
        // A recorded identity that could not be determined.
        let mut recorded = recorded_context();
        recorded.context.durable_identity = None;
        assert_eq!(
            compared(&recorded),
            Err(ContextMismatch::DurableIdentityMismatch)
        );
        // An empty identity of the range never equals an empty one.
        for (name, mismatch, set) in [
            (
                "project",
                ContextMismatch::ProjectMismatch,
                (|c: &mut HistoryComparisonContext| c.range.project_id = String::new())
                    as fn(&mut HistoryComparisonContext),
            ),
            ("session", ContextMismatch::ChatSessionMismatch, |c| {
                c.range.chat_session_id = String::new()
            }),
            ("scene", ContextMismatch::SceneMismatch, |c| {
                c.range.scene_id = String::new()
            }),
            (
                "incarnation",
                ContextMismatch::SceneIncarnationMismatch,
                |c| c.range.scene_incarnation_id = String::new(),
            ),
        ] {
            let mut current = comparison_context();
            set(&mut current);
            let mut recorded = recorded_context();
            set(&mut recorded.context);
            assert_eq!(
                compare_context(&current, &recorded, NOW_MS),
                Err(mismatch),
                "{name}"
            );
        }
    }

    /// K4/3 section 8: an unavailable current axis excludes all history and
    /// the turn goes on. Nothing is read or charged and no authority reader
    /// is asked.
    #[test]
    fn current_axis_unavailable_excludes_all_history_and_the_turn_continues() {
        struct CountingQualifier(usize);
        impl CurrentQualifier for CountingQualifier {
            fn qualify_attempt(
                &mut self,
                _attempt: &AttemptSnapshot,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                self.0 += 1;
                QualificationStatus::Current
            }
            fn qualify_input(
                &mut self,
                _attempt: &AttemptSnapshot,
                _ordinal: usize,
                _input: &HistoryInput,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                self.0 += 1;
                QualificationStatus::Current
            }
            fn qualify_generated_output(
                &mut self,
                _parent: &AttemptSnapshot,
                _version_id: &str,
                _recorded_body_digest: &str,
                _current: &HistoryComparisonContext,
            ) -> QualificationStatus {
                self.0 += 1;
                QualificationStatus::Current
            }
        }

        let mut currents: Vec<(String, CurrentHistoryContext, CurrentContextUnavailable)> =
            ALL_AXES
                .iter()
                .map(|&name| {
                    let mut context = comparison_context();
                    set_axis_unavailable(&mut context, name);
                    (
                        format!("{name:?}"),
                        CurrentHistoryContext::Known(Box::new(context)),
                        CurrentContextUnavailable::Axis(name),
                    )
                })
                .collect();
        let mut no_identity = comparison_context();
        no_identity.durable_identity = None;
        currents.push((
            "durable identity".into(),
            CurrentHistoryContext::Known(Box::new(no_identity)),
            CurrentContextUnavailable::DurableIdentity,
        ));
        let mut no_range = comparison_context();
        no_range.range.scene_incarnation_id = String::new();
        currents.push((
            "range".into(),
            CurrentHistoryContext::Known(Box::new(no_range)),
            CurrentContextUnavailable::Range,
        ));
        currents.push((
            "the builder's reason".into(),
            CurrentHistoryContext::Unavailable(HistoryUnavailableReason::SceneScopeUnavailable),
            CurrentContextUnavailable::Turn(HistoryUnavailableReason::SceneScopeUnavailable),
        ));
        let graph = snapshot(vec![
            attempt("a", vec![raw("source")], None),
            attempt("b", vec![raw("source")], None),
        ]);
        let candidates = [
            Candidate {
                id: "a".into(),
                root_attempt_id: "a".into(),
                adopted_input_ordinals: vec![0],
                output: None,
            },
            Candidate {
                id: "b".into(),
                root_attempt_id: "b".into(),
                adopted_input_ordinals: vec![0],
                output: None,
            },
        ];
        for (name, current, unavailable) in currents {
            let mut qualifier = CountingQualifier(0);
            let mut ledger = SharedLedger {
                nodes: 4,
                edges: 4,
                qualification_refs: 64,
            };
            let mut cancelled = || false;
            let outcome = reauthorize_history(
                &graph,
                &candidates,
                &current,
                NOW_MS,
                &mut ledger,
                &mut qualifier,
                &mut cancelled,
            )
            .unwrap_or_else(|error| panic!("{name}: the turn must continue: {error:?}"));
            assert_eq!(outcome.candidates.len(), 2, "{name}");
            for result in &outcome.candidates {
                assert_eq!(
                    result.disposition,
                    CandidateDisposition::Excluded(Failure::Incomplete(
                        IncompleteReason::CurrentContextUnavailable(unavailable)
                    )),
                    "{name}"
                );
                assert!(result.visited_attempts.is_empty(), "{name}");
            }
            assert_eq!(qualifier.0, 0, "{name}: no authority reader was asked");
            assert_eq!(
                (ledger.nodes, ledger.edges, ledger.qualification_refs),
                (4, 4, 64),
                "{name}: nothing was charged"
            );
        }
    }

    /// Cancellation still wins over an unavailable current context.
    #[test]
    fn cancellation_is_checked_before_the_current_context() {
        let graph = snapshot(Vec::new());
        let mut qualifier = AllowCurrent {
            pending_graph: false,
        };
        let mut ledger = budget();
        let mut cancelled = || true;
        assert_eq!(
            reauthorize_history(
                &graph,
                &[],
                &CurrentHistoryContext::Unavailable(
                    HistoryUnavailableReason::SceneScopeUnavailable
                ),
                NOW_MS,
                &mut ledger,
                &mut qualifier,
                &mut cancelled,
            ),
            Err(HistoryRunError::Cancelled)
        );
    }

    fn recorded_at(created_at_ms: i64, eligible_until_ms: u64) -> RecordedHistoryContext {
        RecordedHistoryContext {
            created_at_ms,
            eligible_until_ms,
            ..recorded_context()
        }
    }

    #[test]
    fn validity_window_boundaries_and_clock_rollback() {
        let created = 1_000_000;
        let window = HISTORY_ELIGIBILITY_WINDOW_MS;
        let at = |recorded: &RecordedHistoryContext, now_ms| {
            compare_context(&comparison_context(), recorded, now_ms)
        };
        // The default window: [created, created + 30 days).
        let normal = recorded_at(created, (created + window) as u64);
        assert_eq!(
            at(&normal, created - 1),
            Err(ContextMismatch::ClockBeforeCreation)
        );
        assert_eq!(at(&normal, 0), Err(ContextMismatch::ClockBeforeCreation));
        assert_eq!(at(&normal, created), Ok(()));
        assert_eq!(at(&normal, created + window - 1), Ok(()));
        assert_eq!(
            at(&normal, created + window),
            Err(ContextMismatch::ValidityExpired)
        );
        assert_eq!(at(&normal, i64::MAX), Err(ContextMismatch::ValidityExpired));
        // A stored `eligibleUntilMs` earlier than the window wins.
        let early = recorded_at(created, (created + 5_000) as u64);
        assert_eq!(at(&early, created + 4_999), Ok(()));
        assert_eq!(
            at(&early, created + 5_000),
            Err(ContextMismatch::ValidityExpired)
        );
        // One later than the current window is cut at `created + window`
        // (a shorter window also applies to old attempts).
        let late = recorded_at(created, (created + window + 7_000) as u64);
        assert_eq!(at(&late, created + window - 1), Ok(()));
        assert_eq!(
            at(&late, created + window),
            Err(ContextMismatch::ValidityExpired)
        );
        // The builder's placeholder (0) is never valid, and neither are
        // times that cannot form a window.
        assert_eq!(
            at(&recorded_at(created, 0), created),
            Err(ContextMismatch::ValidityExpired)
        );
        assert_eq!(
            at(&recorded_at(-1, 10), 0),
            Err(ContextMismatch::ValidityWindowInvalid)
        );
        assert_eq!(
            at(&recorded_at(i64::MAX - 10, u64::MAX), i64::MAX),
            Err(ContextMismatch::ValidityWindowInvalid)
        );
        assert_eq!(
            at(&recorded_at(created, u64::MAX), created),
            Err(ContextMismatch::ValidityWindowInvalid)
        );
        // The comparison runs after the rest: a changed epoch is reported
        // before the window.
        let mut stale = recorded_at(created, 0);
        stale.context.restore_epoch.number =
            HistoryInt::new(stale.context.restore_epoch.number.get() + 1).expect("int");
        assert_eq!(
            at(&stale, created),
            Err(ContextMismatch::RestoreEpochMismatch)
        );
        // The traversal reports the same.
        let mut expired = attempt("root", vec![raw("source")], None);
        expired.recorded = Some(recorded_at(CREATED_AT_MS, (CREATED_AT_MS + 10) as u64));
        assert_eq!(
            disposition_of_attempt(expired),
            excluded_by(ContextMismatch::ValidityExpired)
        );
    }

    #[test]
    fn epoch_only_difference_excludes_every_candidate() {
        let mut by_number = attempt("by-number", vec![raw("source")], None);
        let mut by_id = attempt("by-id", vec![raw("source")], None);
        let same = attempt("same", vec![raw("source")], None);
        let number = by_number.recorded.as_mut().expect("recorded");
        number.context.restore_epoch.number =
            HistoryInt::new(number.context.restore_epoch.number.get() + 1).expect("int");
        by_id
            .recorded
            .as_mut()
            .expect("recorded")
            .context
            .restore_epoch
            .id_digest = other(HistoryDigestDomain::RestoreEpochId);
        let graph = snapshot(vec![by_number, by_id, same]);
        let candidates = ["by-number", "by-id", "same"].map(|id| Candidate {
            id: id.into(),
            root_attempt_id: id.into(),
            adopted_input_ordinals: vec![0],
            output: None,
        });
        let mut qualifier = AllowCurrent {
            pending_graph: false,
        };
        let mut ledger = budget();
        let mut cancelled = || false;
        let outcome = reauthorize_history(
            &graph,
            &candidates,
            &current_context(),
            NOW_MS,
            &mut ledger,
            &mut qualifier,
            &mut cancelled,
        )
        .expect("history run");
        let dispositions: Vec<_> = outcome
            .candidates
            .iter()
            .map(|result| result.disposition.clone())
            .collect();
        assert_eq!(
            dispositions,
            vec![
                excluded_by(ContextMismatch::RestoreEpochMismatch),
                excluded_by(ContextMismatch::RestoreEpochMismatch),
                CandidateDisposition::Qualified,
            ]
        );
    }

    /// K4/3 section 7: a cold reopen keeps the identity; a copy or a move of
    /// the folder does not; moving it back restores the same identity (a
    /// non-monotone value is compared with the recorded one).
    #[test]
    fn durable_identity_cold_reopen_matches_and_copy_or_move_does_not() {
        let base = std::env::temp_dir().join(format!("grimodex-hc12-{}", uuid::Uuid::new_v4()));
        let original = base.join("novel");
        std::fs::create_dir_all(&original).expect("workspace folder");
        let identity = |root: &std::path::Path| {
            DurableWorkspaceIdentity::from_workspace_root("workspace-id", root)
        };
        let compare_with = |current: Option<DurableWorkspaceIdentity>,
                            recorded: Option<DurableWorkspaceIdentity>| {
            let mut current_context = comparison_context();
            current_context.durable_identity = current;
            let mut recorded_context = recorded_context();
            recorded_context.context.durable_identity = recorded;
            compare_context(&current_context, &recorded_context, NOW_MS)
        };

        let recorded = identity(&original);
        assert!(recorded.is_some());
        // Cold reopen: the same folder, a new process.
        assert_eq!(compare_with(identity(&original), recorded.clone()), Ok(()));
        // A copy of the folder is another locator.
        let copied = base.join("novel-copy");
        std::fs::create_dir_all(&copied).expect("copied folder");
        assert_eq!(
            compare_with(identity(&copied), recorded.clone()),
            Err(ContextMismatch::DurableIdentityMismatch)
        );
        // Moving the folder changes the locator...
        let moved = base.join("novel-moved");
        std::fs::rename(&original, &moved).expect("move");
        assert_eq!(
            compare_with(identity(&moved), recorded.clone()),
            Err(ContextMismatch::DurableIdentityMismatch)
        );
        // ...and moving it back to the original path restores the identity.
        std::fs::rename(&moved, &original).expect("move back");
        assert_eq!(compare_with(identity(&original), recorded.clone()), Ok(()));
        // A different workspace id in the same folder is another identity.
        assert_eq!(
            compare_with(
                DurableWorkspaceIdentity::from_workspace_root("another-id", &original),
                recorded
            ),
            Err(ContextMismatch::DurableIdentityMismatch)
        );
        // A folder the OS cannot resolve has no identity, which never matches.
        assert_eq!(identity(&base.join("missing")), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
