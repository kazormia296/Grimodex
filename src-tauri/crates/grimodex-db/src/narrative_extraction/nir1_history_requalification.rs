//! The production `CurrentQualifier` of the history traversal (HC1-3, K4/3
//! sections 3 and 13).
//!
//! History is re-authorized every turn. The pure traversal
//! (`nir1_generation_history`) decides lineage, order, budget and the closed
//! reasons; this module answers the two questions it cannot answer without
//! the database: is an attempt's recorded D1 selection still the one its
//! stored rows give, and is every reference of an input still current?
//!
//! * The qualifier reads only through the snapshot's own read transaction
//!   ([`HistoryAuthorityConnection`]) and the existing current readers: the
//!   Source resolvers, the live message version row, and the A3 evaluation
//!   (`evaluate_nir1_entity_relation_disclosure`, which includes the exact A2
//!   Revision reader and the canonical Freshness gate). It writes nothing and
//!   stores no qualification: a recorded value is a comparison anchor, never
//!   an authority.
//! * References are compared by their class (K4/3 section 13), which comes
//!   from the reference's kind and Scope role, never from an identity string.
//!   Dependency references (Source tokens, the Revision bundle digest, the
//!   Decision token, typed-scope digests) must be exactly current. Context
//!   references (the project's scope-authority token, reveal state, the
//!   target Scene's body Source, material scene proofs, the Freshness token)
//!   are recorded and not compared: the A3 evaluation, which must be Eligible
//!   now, judges them. The one exception of Q8 is the Raw Source of the
//!   attempt's own target Scene body.
//! * The expected `(kind, target)` set of rule 3 is derived by the very
//!   function D-final uses (`expected_targets_for_inputs`) from the current
//!   Revision, and handed to the shared completeness rule.
//! * A typed absence (no resolver for a Source kind, a Revision A2 reads as
//!   unavailable, an Artifact input) excludes the candidate with a closed
//!   reason. Only a failed read (SQLite or IO, a malformed row, a validation
//!   stop) stops the run: the qualifier answers `Unavailable` and keeps the
//!   error for the run entry ([`HistoryRequalifier::take_stop`]).
//! * One A3 evaluation is made per `(Revision, target Scene)` per turn and
//!   shared by every attempt. `revalidate_nir1_entity_relation_disclosure` is
//!   never called: it compares the evaluation of an earlier request with this
//!   one, and an earlier request's context is not a history dependency.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the history run entry that builds a requalifier inside the snapshot is HC1-4's"
    )
)]

use std::collections::BTreeMap;
use std::rc::Rc;

use anyhow::Error;
use grimodex_core::canonical_json_digest;

use super::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDisclosureRead,
};
use super::nir1_packing::{authority_binding, expected_targets_for_inputs};
use super::scene_scope_projection;
use super::source_revision::{is_validation_terminated, resolve_source_revision};
use super::NativeNir1AuthorityBinding;
use crate::nir1_generation::history_context::{
    HistoryD1Selection, HistoryDigest, HistoryDigestDomain,
};
use crate::nir1_generation::history_reads::{
    read_history_message_version_facts, HistoryAuthorityConnection,
};
use crate::nir1_generation::{
    check_input_completeness, d1_selection_digest, CompletenessContext, CompletenessReason,
    D1SelectionParameters, InputReference, InputUse, MessageOrigin, QualificationBody,
    QualificationKind, QualificationReference as StoredQualificationReference, ScopeRole,
};
use crate::nir1_generation_history::{
    AttemptSnapshot, CurrentQualifier, HistoryComparisonContext, HistoryInput, HistoryInputKind,
    QualificationStatus, RequalificationReason,
};

/// What a single check decides when it does not pass.
enum Verdict {
    /// The candidate is excluded with a closed reason; the run goes on.
    Exclude(RequalificationReason),
    /// The authority is Pending (Graph-derived input).
    Pending,
    /// A read failed. The run stops; nothing partial is adopted.
    Stop(Error),
}

impl From<RequalificationReason> for Verdict {
    fn from(reason: RequalificationReason) -> Self {
        Self::Exclude(reason)
    }
}

type Check = Result<(), Verdict>;

/// One A3 evaluation of a `(Revision, target Scene)`, shared for the turn.
struct RevisionFacts {
    binding: NativeNir1AuthorityBinding,
    /// The digest of each of the Revision's typed-scope bindings, in index
    /// order (the digest D-final recorded as the `typed-scope` version).
    typed_scope_digests: Vec<String>,
}

type RevisionJudgement = Result<Rc<RevisionFacts>, RequalificationReason>;

/// The source kinds with a current resolver the qualifier may call outside a
/// caller-owned validation context. Anything else is an unknown Source.
fn source_kind_for_key(source_key: &str) -> Option<&'static str> {
    if scene_scope_projection::scene_id_from_source_key(source_key).is_ok() {
        return Some(scene_scope_projection::SOURCE_KIND);
    }
    if source_key
        .strip_prefix("project:scene:")
        .is_some_and(|id| !id.is_empty())
    {
        return Some("scene-body");
    }
    if source_key
        .strip_prefix("codex-relation:")
        .is_some_and(|id| !id.is_empty())
    {
        return Some("codex-relation");
    }
    if source_key
        .strip_prefix("codex:")
        .is_some_and(|id| !id.is_empty())
    {
        return Some("codex-entry");
    }
    None
}

/// Map the closed reason string of an A3 `Unavailable` to the requalifier's
/// closed reason. The string is never kept or shown.
fn classify_unavailable(reason: &str) -> RequalificationReason {
    use RequalificationReason as R;
    match reason {
        _ if reason.starts_with("revision-material-contract-") => R::RevisionUnavailableByA2,
        "canonical-freshness-unavailable" => R::FreshnessNotFresh,
        "source-revision-changed"
        | "revision-material-mismatch"
        | "revision-material-authority-mismatch" => R::SourceStale,
        "revision-not-found"
        | "revision-not-current"
        | "revision-restore-invalidated"
        | "revision-kind-mismatch"
        | "revision-envelope-invalid"
        | "revision-payload-invalid"
        | "revision-payload-binding-invalid" => R::RevisionStale,
        "revision-not-human-approved" | "revision-decision-ambiguous" => R::DecisionStale,
        _ => R::DisclosureIneligible,
    }
}

/// A Source reader error that is a typed absence or refusal of the Source
/// itself (missing, changed, a key the resolver rejects), as opposed to a
/// failed read.
fn is_source_absence(error: &Error) -> bool {
    let rendered = format!("{error:#}");
    [
        "NEX_SOURCE_MISSING",
        "NEX_SOURCE_STALE",
        "NEX_SOURCE_KEY_INVALID",
        "NEX_SOURCE_PROJECT_MISMATCH",
    ]
    .iter()
    .any(|code| rendered.contains(code))
}

/// The production [`CurrentQualifier`]. One per turn, built inside the
/// snapshot from the reader's [`HistoryAuthorityConnection`]; it holds the
/// turn's caches and, once a read has failed, the error that stops the run.
pub(crate) struct HistoryRequalifier<'connection> {
    authority: HistoryAuthorityConnection<'connection>,
    stop: Option<Error>,
    revisions: BTreeMap<(String, String), RevisionJudgement>,
    sources: BTreeMap<String, Result<String, RequalificationReason>>,
    /// A3 evaluations made, for the once-per-turn invariant.
    a3_evaluations: usize,
}

impl<'connection> HistoryRequalifier<'connection> {
    pub(crate) fn new(authority: HistoryAuthorityConnection<'connection>) -> Self {
        Self {
            authority,
            stop: None,
            revisions: BTreeMap::new(),
            sources: BTreeMap::new(),
            a3_evaluations: 0,
        }
    }

    /// The error of the read that stopped the run, if one did. The run entry
    /// returns it instead of the traversal's closed `AuthorityUnavailable`.
    pub(crate) fn take_stop(&mut self) -> Option<Error> {
        self.stop.take()
    }

    /// Whether a read has failed (the qualifier then answers `Unavailable`).
    pub(crate) fn has_stopped(&self) -> bool {
        self.stop.is_some()
    }

    /// The number of A3 evaluations this turn made.
    #[cfg(test)]
    pub(crate) fn a3_evaluation_count(&self) -> usize {
        self.a3_evaluations
    }

    fn status(&mut self, check: Check) -> QualificationStatus {
        match check {
            Ok(()) => QualificationStatus::Current,
            Err(Verdict::Exclude(reason)) => QualificationStatus::Excluded(reason),
            Err(Verdict::Pending) => QualificationStatus::Pending,
            Err(Verdict::Stop(error)) => {
                self.stop.get_or_insert(error);
                QualificationStatus::Unavailable
            }
        }
    }

    // -----------------------------------------------------------------
    // The attempt
    // -----------------------------------------------------------------

    fn check_attempt(
        &self,
        attempt: &AttemptSnapshot,
        current: &HistoryComparisonContext,
    ) -> Check {
        use RequalificationReason as R;
        let recorded = attempt.recorded.as_ref().ok_or(R::InputShapeInvalid)?;
        if attempt.target_scene_id.as_deref() != Some(current.range.scene_id.as_str())
            || attempt.project_id.as_deref() != Some(current.range.project_id.as_str())
            || attempt.session_id.as_deref() != Some(current.range.chat_session_id.as_str())
        {
            return Err(R::InputShapeInvalid.into());
        }
        // K4/3 section 5: a conversation attempt is exactly one current turn
        // at ordinal 0; a material-only input set has none.
        let conversation = attempt
            .inputs
            .iter()
            .any(|input| input_is_message(&input.kind));
        if attempt.inputs.is_empty() {
            return Err(R::InputShapeInvalid.into());
        }
        for (ordinal, input) in attempt.inputs.iter().enumerate() {
            let is_current = input.input_use == InputUse::CurrentTurn;
            if is_current != (conversation && ordinal == 0) {
                return Err(R::InputShapeInvalid.into());
            }
        }
        // The D1 selection digest recomputes from the stored input rows and
        // the context's d1 fields: it checks that the recorded selection is
        // the one those rows give (not that today's budget would select it).
        let references: Option<Vec<InputReference>> = attempt
            .inputs
            .iter()
            .map(HistoryInput::input_reference)
            .collect();
        let references = references.ok_or(R::D1RecomputeMismatch)?;
        let recomputed = d1_selection_digest(&d1_parameters(&recorded.d1), &references)
            .map_err(|_| R::D1RecomputeMismatch)?;
        if recomputed != recorded.d1.selection_digest.as_str() {
            return Err(R::D1RecomputeMismatch.into());
        }
        Ok(())
    }

    // -----------------------------------------------------------------
    // The current readers, with the turn's caches
    // -----------------------------------------------------------------

    /// The current token of a Source key through the existing resolver, once
    /// per key per turn. A kind without a resolver is unknown (excluded); a
    /// missing or changed Source is a typed absence; any other failure stops
    /// the run.
    fn current_source_token(
        &mut self,
        project_id: &str,
        source_key: &str,
    ) -> Result<String, Verdict> {
        if let Some(cached) = self.sources.get(source_key) {
            return cached.clone().map_err(Verdict::from);
        }
        let Some(kind) = source_kind_for_key(source_key) else {
            let result = Err(RequalificationReason::SourceResolverMissing);
            self.sources.insert(source_key.to_owned(), result.clone());
            return result.map_err(Verdict::from);
        };
        // The project of a Source is the turn's: the resolvers check it.
        let result = match resolve_source_revision(
            self.authority.connection(),
            project_id,
            "",
            kind,
            source_key,
        ) {
            Ok(current) => Ok(current.revision_token),
            Err(error) if is_validation_terminated(&error) => return Err(Verdict::Stop(error)),
            Err(error) if is_source_absence(&error) => Err(RequalificationReason::SourceStale),
            Err(error) => return Err(Verdict::Stop(error)),
        };
        self.sources.insert(source_key.to_owned(), result.clone());
        result.map_err(Verdict::from)
    }

    /// The A3 evaluation of `(revision, scene)`, once per turn.
    fn revision_facts(
        &mut self,
        project_id: &str,
        revision_id: &str,
        scene_id: &str,
    ) -> Result<Rc<RevisionFacts>, Verdict> {
        let key = (revision_id.to_owned(), scene_id.to_owned());
        if let Some(cached) = self.revisions.get(&key) {
            return cached.clone().map_err(Verdict::from);
        }
        self.a3_evaluations += 1;
        let judgement: RevisionJudgement = match evaluate_nir1_entity_relation_disclosure(
            self.authority.connection(),
            project_id,
            revision_id,
            scene_id,
        ) {
            Err(error) => return Err(Verdict::Stop(error)),
            Ok(Nir1EntityRelationDisclosureRead::Unavailable { reason }) => {
                Err(classify_unavailable(&reason))
            }
            Ok(Nir1EntityRelationDisclosureRead::Eligible(disclosure)) => {
                // A reader result that is not the exact human approval, or has
                // an empty required field, is not an eligible disclosure; it
                // is pure data, not a failed read.
                match authority_binding(&disclosure) {
                    Err(_) => Err(RequalificationReason::DisclosureIneligible),
                    Ok(binding) => {
                        let digests: Result<Vec<String>, _> =
                            binding
                                .scope()
                                .typed_scope_bindings()
                                .iter()
                                .map(|scope| {
                                    serde_json::to_value(scope).map_err(Error::from).and_then(
                                        |value| canonical_json_digest(&value).map_err(Error::from),
                                    )
                                })
                                .collect();
                        match digests {
                            Err(_) => Err(RequalificationReason::DisclosureIneligible),
                            Ok(typed_scope_digests) => Ok(Rc::new(RevisionFacts {
                                binding,
                                typed_scope_digests,
                            })),
                        }
                    }
                }
            }
        };
        self.revisions.insert(key, judgement.clone());
        judgement.map_err(Verdict::from)
    }

    // -----------------------------------------------------------------
    // One input
    // -----------------------------------------------------------------

    fn check_input(
        &mut self,
        attempt: &AttemptSnapshot,
        input: &HistoryInput,
        current: &HistoryComparisonContext,
    ) -> Check {
        use RequalificationReason as R;
        let project_id = current.range.project_id.as_str();
        let scene_id = attempt
            .target_scene_id
            .as_deref()
            .ok_or(R::InputShapeInvalid)?;
        if scene_id != current.range.scene_id {
            return Err(R::InputShapeInvalid.into());
        }
        let recorded = attempt.recorded.as_ref().ok_or(R::InputShapeInvalid)?;
        match &input.kind {
            HistoryInputKind::Artifact { .. } => return Err(R::ArtifactUnsupported.into()),
            // Graph-derived input needs the Index reference, whose form is
            // Pending: the candidate stays out until it is confirmed.
            HistoryInputKind::GraphEvidence { .. } => return Err(Verdict::Pending),
            HistoryInputKind::InvalidMessageBinding { .. } => {
                return Err(R::MessageVersionInvalid.into())
            }
            _ => {}
        }
        let reference = input.input_reference().ok_or(R::InvalidInput)?;

        // A Revision input is judged by the current evaluation first: the
        // expected set of rule 3 is derived from the current Revision.
        let facts = match &input.kind {
            HistoryInputKind::AcceptedRevision {
                revision_id,
                bundle_digest,
            } => {
                let facts = self.revision_facts(project_id, revision_id, scene_id)?;
                if facts.binding.bundle_digest() != bundle_digest {
                    return Err(R::RevisionStale.into());
                }
                Some(facts)
            }
            _ => None,
        };

        // Rule 3: the recorded references are exactly the set the current
        // state derives, through the shared completeness rule. It also
        // re-derives the typed N/A from the input's type, use and source key.
        let bindings: Vec<&NativeNir1AuthorityBinding> =
            facts.iter().map(|facts| &facts.binding).collect();
        let expected = expected_targets_for_inputs(
            project_id,
            scene_id,
            std::slice::from_ref(&reference),
            &bindings,
        )
        .map_err(|_| R::InvalidInput)?;
        let rows: Vec<StoredQualificationReference> = input
            .qualifications
            .references
            .iter()
            .map(|row| StoredQualificationReference {
                input_ordinal: 0,
                kind: row.kind,
                body: row.body.clone(),
            })
            .collect();
        let rows: Vec<&StoredQualificationReference> = rows.iter().collect();
        check_input_completeness(
            0,
            &reference,
            &rows,
            &CompletenessContext {
                target_scene_id: scene_id,
                expected_targets: Some(&expected),
            },
        )
        .map_err(classify_completeness)?;

        for row in &input.qualifications.references {
            let QualificationBody::Present {
                identity,
                version,
                scope_role,
            } = &row.body
            else {
                continue;
            };
            match row.kind {
                QualificationKind::Source => {
                    self.check_source(project_id, scene_id, current, input, identity, version)?
                }
                QualificationKind::Revision => {
                    let facts = facts.as_ref().ok_or(R::InvalidInput)?;
                    if version != facts.binding.bundle_digest() {
                        return Err(R::RevisionStale.into());
                    }
                }
                QualificationKind::Decision => {
                    let facts = facts.as_ref().ok_or(R::InvalidInput)?;
                    if version != facts.binding.decision_token() {
                        return Err(R::DecisionStale.into());
                    }
                }
                // The Freshness reference (feed position included) is a
                // context reference: recorded, not compared. The A3
                // evaluation above is Eligible only when the canonical
                // Freshness is fresh now.
                QualificationKind::Freshness => {}
                // Present only for a Graph-derived input, which returned
                // above; the table makes it a typed N/A for the others.
                QualificationKind::Index => return Err(R::InvalidInput.into()),
                QualificationKind::Scope => {
                    let role = scope_role.ok_or(R::InvalidInput)?;
                    self.check_scope(role, identity, version, current, facts.as_deref())?
                }
                QualificationKind::D1 => {
                    if version != recorded.d1.selection_digest.as_str() {
                        return Err(R::D1RecomputeMismatch.into());
                    }
                }
            }
        }
        Ok(())
    }

    fn check_source(
        &mut self,
        project_id: &str,
        scene_id: &str,
        current: &HistoryComparisonContext,
        input: &HistoryInput,
        identity: &str,
        version: &str,
    ) -> Check {
        use RequalificationReason as R;
        match &input.kind {
            HistoryInputKind::HumanMessage { version_id, .. } => {
                self.check_message_version(current, version_id, MessageOrigin::Human, None, version)
            }
            HistoryInputKind::GeneratedMessage {
                version_id,
                parent_attempt_id,
                ..
            } => self.check_message_version(
                current,
                version_id,
                MessageOrigin::Generated,
                Some(parent_attempt_id.as_deref()),
                version,
            ),
            HistoryInputKind::RawSource { .. } => {
                // Q8 (K4/3 section 12): the attempt's own target Scene body is
                // recorded and not compared, and is not a dependency of the
                // generated output. This is the only exception. Another
                // Scene's body is an exact dependency.
                if identity == format!("project:scene:{scene_id}") {
                    return Ok(());
                }
                self.check_source_token(project_id, identity, version)
            }
            // The Sources of a Revision (material basis and Evidence, the
            // anchor projections included) are exact dependencies, also when
            // one names the target Scene's body.
            HistoryInputKind::AcceptedRevision { .. } => {
                self.check_source_token(project_id, identity, version)
            }
            _ => Err(R::InvalidInput.into()),
        }
    }

    fn check_source_token(&mut self, project_id: &str, source_key: &str, token: &str) -> Check {
        if self.current_source_token(project_id, source_key)? == token {
            Ok(())
        } else {
            Err(RequalificationReason::SourceStale.into())
        }
    }

    /// The live message version row (not invalidated) must belong to the
    /// turn's project and chat session, have the origin the input uses (and
    /// for a generated output the same parent attempt), and carry the
    /// recorded body digest.
    fn check_message_version(
        &mut self,
        current: &HistoryComparisonContext,
        version_id: &str,
        origin: MessageOrigin,
        parent: Option<Option<&str>>,
        recorded_digest: &str,
    ) -> Check {
        use RequalificationReason as R;
        let facts = read_history_message_version_facts(&self.authority, version_id)
            .map_err(Verdict::Stop)?
            .ok_or(R::MessageVersionInvalid)?;
        if facts.project_id != current.range.project_id
            || facts.chat_session_id != current.range.chat_session_id
        {
            return Err(R::MessageVersionScopeMismatch.into());
        }
        if facts.origin != origin {
            return Err(R::MessageOriginMismatch.into());
        }
        if let Some(parent) = parent {
            if facts.parent_attempt_id.as_deref() != parent {
                return Err(R::MessageOriginMismatch.into());
            }
        }
        if facts.body_digest != recorded_digest {
            return Err(R::MessageDigestChanged.into());
        }
        Ok(())
    }

    fn check_scope(
        &mut self,
        role: ScopeRole,
        identity: &str,
        version: &str,
        current: &HistoryComparisonContext,
        facts: Option<&RevisionFacts>,
    ) -> Check {
        use RequalificationReason as R;
        match role {
            // Dependency: the digest of the Revision's own typed scope.
            ScopeRole::TypedScope => {
                let facts = facts.ok_or(R::InvalidInput)?;
                let components = crate::nir1_generation::parse_scope_identity(role, identity)
                    .ok_or(R::InvalidInput)?;
                let index: usize = components
                    .get(1)
                    .and_then(|index| index.parse().ok())
                    .ok_or(R::InvalidInput)?;
                match facts.typed_scope_digests.get(index) {
                    Some(digest) if digest == version => Ok(()),
                    _ => Err(R::ScopeDependencyChanged.into()),
                }
            }
            // Turn-context references: the turn's own context is compared
            // once per attempt (`compare_context`). Here only the recorded
            // value is tied to that compared context, so a row that does not
            // agree with its attempt's context cannot be adopted.
            ScopeRole::QuerySceneScope => {
                let digest = HistoryDigest::of(HistoryDigestDomain::ScopeBindingToken, version)
                    .map_err(|_| R::SceneScopeInconsistent)?;
                if digest == current.target.binding_token_digest {
                    Ok(())
                } else {
                    Err(R::SceneScopeInconsistent.into())
                }
            }
            ScopeRole::QuerySceneIncarnation => {
                if version == current.range.scene_incarnation_id {
                    Ok(())
                } else {
                    Err(R::SceneScopeInconsistent.into())
                }
            }
            // `axes.auto` is a turn-context value compared by the context.
            ScopeRole::ScopeAxis => Ok(()),
            // Request-context references: recorded, not compared (Q9). The A3
            // evaluation re-judges them against the state of this turn.
            ScopeRole::ProjectAuthority
            | ScopeRole::RevealState
            | ScopeRole::QuerySceneSource
            | ScopeRole::MaterialSceneProof => Ok(()),
        }
    }
}

fn input_is_message(kind: &HistoryInputKind) -> bool {
    matches!(
        kind,
        HistoryInputKind::HumanMessage { .. }
            | HistoryInputKind::GeneratedMessage { .. }
            | HistoryInputKind::InvalidMessageBinding { .. }
    )
}

fn d1_parameters(d1: &HistoryD1Selection) -> D1SelectionParameters {
    D1SelectionParameters {
        estimator_version: d1.estimator_version.as_wire().to_owned(),
        selector_budget_tokens: d1.selector_budget_tokens.get(),
        used_tokens: d1.used_tokens.get(),
        remaining_tokens: d1.remaining_tokens.get(),
    }
}

/// A violation of the shared completeness rule, with the reason class the
/// closed set names: rule 3, the typed N/A table, or any other.
fn classify_completeness(
    violation: crate::nir1_generation::CompletenessViolation,
) -> RequalificationReason {
    match violation.reason {
        CompletenessReason::ExpectedTargetMissing | CompletenessReason::UnexpectedTarget => {
            RequalificationReason::ExpectedSetMismatch(violation)
        }
        CompletenessReason::ReferenceAndNotApplicable
        | CompletenessReason::DuplicateNotApplicable
        | CompletenessReason::NotApplicableNotInTable
        | CompletenessReason::NotApplicableReasonMismatch
        | CompletenessReason::ReferenceNotInTable => {
            RequalificationReason::NotApplicableMismatch(violation)
        }
        _ => RequalificationReason::CompletenessViolated(violation),
    }
}

impl CurrentQualifier for HistoryRequalifier<'_> {
    fn qualify_attempt(
        &mut self,
        attempt: &AttemptSnapshot,
        current: &HistoryComparisonContext,
    ) -> QualificationStatus {
        if self.has_stopped() {
            return QualificationStatus::Unavailable;
        }
        let check = self.check_attempt(attempt, current);
        self.status(check)
    }

    fn qualify_input(
        &mut self,
        attempt: &AttemptSnapshot,
        _ordinal: usize,
        input: &HistoryInput,
        current: &HistoryComparisonContext,
    ) -> QualificationStatus {
        if self.has_stopped() {
            return QualificationStatus::Unavailable;
        }
        let check = self.check_input(attempt, input, current);
        self.status(check)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::nir1_packing::tests::{
        prepared_sql_budget, DfFinalFixture, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE,
    };
    use crate::narrative_extraction::scope_storage_authority_tests::{patch, save_body};
    use crate::narrative_extraction::{NativeNir1FinalQualifications, NativeNir1PreparedInputs};
    use crate::nir1_generation::history_context::HistoryContextSlot;
    use crate::nir1_generation::{
        GenerationPurpose, InputTarget, NotApplicableReason, ReferenceFormat,
    };
    use crate::nir1_generation_history::{
        CurrentHistoryContext, HistoryContextState, HistoryRange, QualificationReference,
        QualificationSet, RecordedHistoryContext,
    };
    use anyhow::Result;

    const SESSION: &str = "nir1-prepared-db-session";

    /// A past attempt built from a real D-final output and the history slot
    /// the product builder made for it, with the current turn's comparison
    /// context taken from the same snapshot (so the two agree).
    struct Past {
        attempt: AttemptSnapshot,
        current: HistoryComparisonContext,
        projection: NativeNir1PreparedInputs,
        finalized: NativeNir1FinalQualifications,
    }

    fn history_input(
        projection: &NativeNir1PreparedInputs,
        finalized: &NativeNir1FinalQualifications,
        ordinal: usize,
    ) -> HistoryInput {
        let input = &projection.input_references()[ordinal];
        let kind = match &input.target {
            InputTarget::Message { version_id, .. } => HistoryInputKind::HumanMessage {
                version_id: version_id.clone(),
                explicitly_bound: true,
            },
            InputTarget::RawSource {
                source_key,
                revision_token,
            } => HistoryInputKind::RawSource {
                source_key: source_key.clone(),
                revision_token: revision_token.clone(),
            },
            InputTarget::AcceptedRevision {
                revision_id,
                bundle_digest,
            } => HistoryInputKind::AcceptedRevision {
                revision_id: revision_id.clone(),
                bundle_digest: bundle_digest.clone(),
            },
            other => panic!("unexpected D-final input {other:?}"),
        };
        HistoryInput {
            kind,
            input_use: input.input_use,
            qualifications: QualificationSet {
                references: finalized
                    .qualifications
                    .iter()
                    .filter(|row| row.input_ordinal == ordinal)
                    .map(|row| QualificationReference {
                        kind: row.kind,
                        body: row.body.clone(),
                    })
                    .collect(),
            },
        }
    }

    fn past(fixture: &DfFinalFixture) -> Result<Past> {
        let projection = fixture.project()?;
        let finalized = projection.finalize_qualifications(100_000)?;
        let draft = projection.history_draft(&finalized);
        let HistoryContextSlot::Context(context) = draft.slot else {
            panic!("a complete D-final output records a context");
        };
        let incarnation = projection.authority_bindings()[0]
            .scope()
            .query_scene_incarnation_id()
            .to_owned();
        let comparison = HistoryComparisonContext {
            range: HistoryRange {
                project_id: RAW_SOURCE_PROJECT.into(),
                chat_session_id: SESSION.into(),
                scene_id: RAW_SOURCE_SCENE.into(),
                scene_incarnation_id: incarnation,
            },
            purpose: GenerationPurpose::Writing,
            durable_identity: draft.durable_workspace_identity,
            send_classification: context.send_classification,
            restore_epoch: context.restore_epoch.clone(),
            target: context.target.clone(),
            axes: context.axes.clone(),
        };
        let inputs = (0..projection.input_references().len())
            .map(|ordinal| history_input(&projection, &finalized, ordinal))
            .collect();
        let attempt = AttemptSnapshot {
            id: "past-attempt".into(),
            recorded: Some(RecordedHistoryContext {
                context: comparison.clone(),
                created_at_ms: 1,
                eligible_until_ms: 1_000_000_000_000,
                d1: context.d1,
            }),
            inputs,
            terminal: None,
            project_id: Some(RAW_SOURCE_PROJECT.into()),
            session_id: Some(SESSION.into()),
            target_scene_id: Some(RAW_SOURCE_SCENE.into()),
            reference_format: ReferenceFormat::V2,
            context: HistoryContextState::Known,
        };
        Ok(Past {
            attempt,
            current: comparison,
            projection,
            finalized,
        })
    }

    /// Run `check` with a requalifier over a participant read transaction.
    fn with_qualifier<T>(
        fixture: &DfFinalFixture,
        check: impl FnOnce(&mut HistoryRequalifier<'_>) -> T,
    ) -> Result<T> {
        fixture
            .snapshot
            .db()
            .with_participant_read_transaction_bounded(
                fixture.snapshot.participant(),
                prepared_sql_budget(),
                |conn| {
                    let mut qualifier =
                        HistoryRequalifier::new(HistoryAuthorityConnection::for_test(conn));
                    Ok(check(&mut qualifier))
                },
            )
    }

    fn input_status(
        fixture: &DfFinalFixture,
        past: &Past,
        attempt: &AttemptSnapshot,
        ordinal: usize,
    ) -> Result<QualificationStatus> {
        with_qualifier(fixture, |qualifier| {
            qualifier.qualify_input(attempt, ordinal, &attempt.inputs[ordinal], &past.current)
        })
    }

    fn excluded(reason: RequalificationReason) -> QualificationStatus {
        QualificationStatus::Excluded(reason)
    }

    const HUMAN: usize = 0;
    const RAW: usize = 1;
    const REVISION: usize = 2;

    /// Replace the version of every present row of `kind` (and `role`) of one
    /// input, returning how many rows changed.
    fn set_version(
        attempt: &mut AttemptSnapshot,
        ordinal: usize,
        kind: QualificationKind,
        role: Option<ScopeRole>,
        version: &str,
    ) -> usize {
        let mut changed = 0;
        for row in &mut attempt.inputs[ordinal].qualifications.references {
            if row.kind != kind {
                continue;
            }
            if let QualificationBody::Present {
                version: stored,
                scope_role,
                ..
            } = &mut row.body
            {
                if role.is_none() || *scope_role == role {
                    *stored = version.to_owned();
                    changed += 1;
                }
            }
        }
        changed
    }

    #[test]
    fn requalify_a_real_d_final_attempt_is_current_for_every_input() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        assert_eq!(past.attempt.inputs.len(), 4);
        let statuses = with_qualifier(&fixture, |qualifier| {
            let mut statuses = vec![qualifier.qualify_attempt(&past.attempt, &past.current)];
            for ordinal in 0..past.attempt.inputs.len() {
                statuses.push(qualifier.qualify_input(
                    &past.attempt,
                    ordinal,
                    &past.attempt.inputs[ordinal],
                    &past.current,
                ));
            }
            (
                statuses,
                qualifier.a3_evaluation_count(),
                qualifier.has_stopped(),
            )
        })?;
        assert_eq!(
            statuses.0,
            vec![QualificationStatus::Current; 5],
            "every input of a real D-final attempt requalifies"
        );
        // The two Revisions of the fixture, one A3 evaluation each.
        assert_eq!(statuses.1, 2);
        assert!(!statuses.2);
        Ok(())
    }

    #[test]
    fn expected_set_is_derived_by_the_same_function_as_d_final() -> Result<()> {
        use super::super::nir1_packing::expected_targets_for_inputs;

        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let bindings: Vec<&NativeNir1AuthorityBinding> =
            past.projection.authority_bindings().iter().collect();
        let shared = expected_targets_for_inputs(
            past.projection.project_id(),
            past.projection.query_scene_id(),
            past.projection.input_references(),
            &bindings,
        )?;
        assert_eq!(shared, past.projection.expected_qualification_targets()?);
        Ok(())
    }

    #[test]
    fn requalify_source_message_version_checks_the_live_row() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        // A changed recorded digest is not the live row's.
        let mut changed = past.attempt.clone();
        assert_eq!(
            set_version(
                &mut changed,
                HUMAN,
                QualificationKind::Source,
                None,
                "sha256:other"
            ),
            1
        );
        assert_eq!(
            input_status(&fixture, &past, &changed, HUMAN)?,
            excluded(RequalificationReason::MessageDigestChanged)
        );
        // The current turn's chat session is not the version's.
        let mut other_session = past.current.clone();
        other_session.range.chat_session_id = "another-session".into();
        let other = Past {
            attempt: past.attempt.clone(),
            current: other_session,
            projection: fixture.project()?,
            finalized: past.finalized.clone(),
        };
        assert_eq!(
            input_status(&fixture, &other, &other.attempt, HUMAN)?,
            excluded(RequalificationReason::MessageVersionScopeMismatch)
        );
        // A Human version used as a generated output is the wrong origin.
        let mut generated = past.attempt.clone();
        let HistoryInputKind::HumanMessage { version_id, .. } = &generated.inputs[HUMAN].kind
        else {
            panic!("ordinal 0 is the Human");
        };
        generated.inputs[HUMAN].kind = HistoryInputKind::GeneratedMessage {
            version_id: version_id.clone(),
            parent_attempt_id: Some("parent".into()),
            receipt: None,
        };
        assert!(matches!(
            input_status(&fixture, &past, &generated, HUMAN)?,
            QualificationStatus::Excluded(_)
        ));
        // A renderer edit of the chat message invalidates the version.
        fixture.snapshot.db().db().with_conn(|conn| {
            conn.execute(
                "UPDATE chat_messages SET content='edited by the renderer'
                  WHERE id='nir1-prepared-db-human'",
                [],
            )?;
            Ok(())
        })?;
        assert_eq!(
            input_status(&fixture, &past, &past.attempt, HUMAN)?,
            excluded(RequalificationReason::MessageVersionInvalid)
        );
        Ok(())
    }

    #[test]
    fn target_body_source_is_recorded_but_not_compared_for_the_target_scene_only() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        // The Raw of the attempt's own target Scene: any recorded token passes
        // (Q8), also after the body changed.
        let mut changed = past.attempt.clone();
        assert_eq!(
            set_version(
                &mut changed,
                RAW,
                QualificationKind::Source,
                None,
                "v0@stale"
            ),
            1
        );
        assert_eq!(
            input_status(&fixture, &past, &changed, RAW)?,
            QualificationStatus::Current
        );
        // The product writers: a body save, then a metadata patch of the
        // target Scene itself (the Scene's own Source token moves).
        let db = fixture.snapshot.db().db();
        save_body(
            db,
            RAW_SOURCE_SCENE,
            "edited-later",
            "2026-10-18T01:00:00.000Z",
        )?;
        patch(
            db,
            RAW_SOURCE_SCENE,
            "target-title",
            "title",
            serde_json::json!("Retitled target"),
            true,
            "2026-10-18T01:00:01.000Z",
        )?;
        assert_eq!(
            input_status(&fixture, &past, &past.attempt, RAW)?,
            QualificationStatus::Current,
            "the target Scene's own body is not a dependency"
        );
        Ok(())
    }

    /// A Raw input over `source_key` with the rows D-final would write for a
    /// Raw that is not the target Scene's body (a test-writer form: the
    /// product writer makes none).
    fn other_raw(past: &Past, source_key: &str, token: &str) -> HistoryInput {
        let mut input = past.attempt.inputs[RAW].clone();
        input.kind = HistoryInputKind::RawSource {
            source_key: source_key.into(),
            revision_token: token.into(),
        };
        for row in &mut input.qualifications.references {
            match (&row.kind, &mut row.body) {
                (
                    QualificationKind::Source,
                    QualificationBody::Present {
                        identity, version, ..
                    },
                ) => {
                    *identity = source_key.into();
                    *version = token.into();
                }
                (QualificationKind::Freshness, QualificationBody::NotApplicable { reason }) => {
                    *reason = NotApplicableReason::ExactSourceToken
                }
                _ => {}
            }
        }
        input
    }

    fn with_input(past: &Past, ordinal: usize, input: HistoryInput) -> AttemptSnapshot {
        let mut attempt = past.attempt.clone();
        attempt.inputs[ordinal] = input;
        attempt
    }

    #[test]
    fn requalify_source_raw_token_is_exact_for_another_scene() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let other_scene: String = fixture.snapshot.db().db().with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM tree_nodes
                  WHERE project_id=?1 AND node_type='scene' AND id<>?2 ORDER BY id LIMIT 1",
                rusqlite::params![RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
                |row| row.get(0),
            )?)
        })?;
        let key = format!("project:scene:{other_scene}");
        let token = fixture.snapshot.db().with_read_transaction(|conn| {
            Ok(
                resolve_source_revision(conn, RAW_SOURCE_PROJECT, "", "scene-body", &key)?
                    .revision_token,
            )
        })?;
        let current = other_raw(&past, &key, &token);
        let attempt = with_input(&past, RAW, current);
        assert_eq!(
            input_status(&fixture, &past, &attempt, RAW)?,
            QualificationStatus::Current
        );
        let stale = with_input(&past, RAW, other_raw(&past, &key, "v0@stale"));
        assert_eq!(
            input_status(&fixture, &past, &stale, RAW)?,
            excluded(RequalificationReason::SourceStale)
        );
        // A Source kind without a resolver is unknown (excluded, not a stop).
        let unknown = with_input(&past, RAW, other_raw(&past, "artifact-store:xyz", "t"));
        assert_eq!(
            with_qualifier(&fixture, |q| {
                let status = q.qualify_input(&unknown, RAW, &unknown.inputs[RAW], &past.current);
                (status, q.has_stopped())
            })?,
            (
                excluded(RequalificationReason::SourceResolverMissing),
                false
            )
        );
        Ok(())
    }

    #[test]
    fn requalify_revision_exact_bundle_digest_decision_and_dependency_refs() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let cases: [(
            &str,
            QualificationKind,
            Option<ScopeRole>,
            RequalificationReason,
        ); 4] = [
            (
                "revision",
                QualificationKind::Revision,
                None,
                RequalificationReason::RevisionStale,
            ),
            (
                "decision",
                QualificationKind::Decision,
                None,
                RequalificationReason::DecisionStale,
            ),
            (
                "material basis source",
                QualificationKind::Source,
                None,
                RequalificationReason::SourceStale,
            ),
            (
                "typed scope",
                QualificationKind::Scope,
                Some(ScopeRole::TypedScope),
                RequalificationReason::ScopeDependencyChanged,
            ),
        ];
        for (name, kind, role, reason) in cases {
            let mut changed = past.attempt.clone();
            assert!(
                set_version(&mut changed, REVISION, kind, role, "sha256:changed") >= 1,
                "{name}"
            );
            assert_eq!(
                input_status(&fixture, &past, &changed, REVISION)?,
                excluded(reason),
                "{name}"
            );
        }
        Ok(())
    }

    /// The statuses of the attempt and of its four inputs, with the stop flag.
    fn full_statuses(
        fixture: &DfFinalFixture,
        past: &Past,
    ) -> Result<(Vec<QualificationStatus>, bool)> {
        with_qualifier(fixture, |qualifier| {
            let mut statuses = vec![qualifier.qualify_attempt(&past.attempt, &past.current)];
            for ordinal in 0..past.attempt.inputs.len() {
                statuses.push(qualifier.qualify_input(
                    &past.attempt,
                    ordinal,
                    &past.attempt.inputs[ordinal],
                    &past.current,
                ));
            }
            (statuses, qualifier.has_stopped())
        })
    }

    fn settle_freshness(db: &crate::Database) -> Result<()> {
        use crate::narrative_extraction::incremental_freshness::{
            run_incremental_freshness_cycle, IncrementalFreshnessCycleOutcome,
        };
        while matches!(
            run_incremental_freshness_cycle(db)?,
            IncrementalFreshnessCycleOutcome::Processed(_)
        ) {}
        Ok(())
    }

    const REVISION_B: usize = 3;

    #[test]
    fn requalify_freshness_ignores_feed_position_only_writes() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let current = vec![QualificationStatus::Current; 5];
        assert_eq!(full_statuses(&fixture, &past)?, (current.clone(), false));
        let db = fixture.snapshot.db().db();
        // Body saves of the evidence Scene, the target Scene and the anchor Scene
        // move the Feed position (and the Scenes' own body Source tokens) but
        // not the canonical Freshness of the approved Revisions.
        save_body(
            db,
            "a3-source",
            "fresh-evidence",
            "2026-10-18T03:00:00.000Z",
        )?;
        save_body(
            db,
            RAW_SOURCE_SCENE,
            "fresh-target",
            "2026-10-18T03:00:01.000Z",
        )?;
        save_body(db, "nir1", "fresh-anchor", "2026-10-18T03:00:02.000Z")?;
        assert_eq!(
            full_statuses(&fixture, &past)?,
            (current.clone(), false),
            "before the Freshness cycle"
        );
        settle_freshness(db)?;
        assert_eq!(
            full_statuses(&fixture, &past)?,
            (current, false),
            "after the Freshness cycle"
        );
        Ok(())
    }

    #[test]
    fn requalify_freshness_follows_a_real_source_change_without_stopping() -> Result<()> {
        use crate::domain_writes::{
            apply_codex_rename, CodexRenameApplyPayload, CodexRenameUndoUpdate,
        };

        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let db = fixture.snapshot.db().db();
        let entry_version: i64 = db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT version FROM codex_entries WHERE id = 'nir1-bob'",
                [],
                |row| row.get(0),
            )?)
        })?;
        // A Codex edit of an Entity both Revisions name.
        apply_codex_rename(
            db,
            CodexRenameApplyPayload {
                request_id: "hc1-fresh-rename-request".into(),
                project_id: RAW_SOURCE_PROJECT.into(),
                session_id: "hc1-fresh-rename-session".into(),
                surface: Some("hc1".into()),
                entry_id: "nir1-bob".into(),
                updated_at: "2026-10-18T04:00:00.000Z".into(),
                updates: vec![CodexRenameUndoUpdate {
                    kind: "codex-summary".into(),
                    ref_id: "nir1-bob".into(),
                    detail_definition_id: None,
                    base_version: entry_version,
                    value: "Robert".into(),
                    char_count: None,
                    placed_beat_preview: None,
                }],
                event_summary: "{}".into(),
                event_uid: "hc1-fresh-rename-event".into(),
                timestamp: 1,
                redo: false,
                original_transaction_id: None,
                undo_journal_id: None,
            },
        )?;
        for phase in ["before the Freshness cycle", "after the Freshness cycle"] {
            let (statuses, stopped) = full_statuses(&fixture, &past)?;
            assert!(!stopped, "{phase}: an excluded input does not stop the run");
            assert_eq!(statuses[0], QualificationStatus::Current, "{phase}");
            assert_eq!(statuses[1 + HUMAN], QualificationStatus::Current, "{phase}");
            assert_eq!(statuses[1 + RAW], QualificationStatus::Current, "{phase}");
            for ordinal in [REVISION, REVISION_B] {
                assert_eq!(
                    statuses[1 + ordinal],
                    excluded(RequalificationReason::SourceStale),
                    "{phase}: Revision input {ordinal}"
                );
            }
            settle_freshness(db)?;
        }
        Ok(())
    }

    #[test]
    fn requalify_freshness_follows_an_anchor_scene_delete_without_stopping() -> Result<()> {
        use crate::domain_writes::{tree_node_delete, TreeNodeDeletePayload};
        use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;

        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let db = fixture.snapshot.db().db();
        tree_node_delete(
            db,
            TreeNodeDeletePayload {
                project_id: RAW_SOURCE_PROJECT.into(),
                request_id: "hc1-fresh-delete-request".into(),
                session_id: "hc1-fresh-delete-session".into(),
                event_uid: "hc1-fresh-delete-event".into(),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                node_id: "nir1".into(),
                canonical_payload: None,
            },
        )?;
        for phase in ["before the Freshness cycle", "after the Freshness cycle"] {
            let (statuses, stopped) = full_statuses(&fixture, &past)?;
            assert!(!stopped, "{phase}");
            assert_eq!(statuses[0], QualificationStatus::Current, "{phase}");
            assert_eq!(statuses[1 + HUMAN], QualificationStatus::Current, "{phase}");
            assert_eq!(statuses[1 + RAW], QualificationStatus::Current, "{phase}");
            for ordinal in [REVISION, REVISION_B] {
                assert!(
                    matches!(
                        statuses[1 + ordinal],
                        QualificationStatus::Excluded(
                            RequalificationReason::SourceStale
                                | RequalificationReason::RevisionStale
                                | RequalificationReason::DisclosureIneligible
                        )
                    ),
                    "{phase}: Revision input {ordinal}: {:?}",
                    statuses[1 + ordinal]
                );
            }
            settle_freshness(db)?;
        }
        Ok(())
    }

    #[test]
    fn context_refs_are_recorded_but_not_compared() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        for (name, kind, role) in [
            ("freshness", QualificationKind::Freshness, None),
            (
                "project scope authority",
                QualificationKind::Scope,
                Some(ScopeRole::ProjectAuthority),
            ),
            (
                "reveal state",
                QualificationKind::Scope,
                Some(ScopeRole::RevealState),
            ),
            (
                "scene source",
                QualificationKind::Scope,
                Some(ScopeRole::QuerySceneSource),
            ),
            (
                "material scene proof",
                QualificationKind::Scope,
                Some(ScopeRole::MaterialSceneProof),
            ),
            (
                "scope axis",
                QualificationKind::Scope,
                Some(ScopeRole::ScopeAxis),
            ),
        ] {
            let mut changed = past.attempt.clone();
            assert!(
                set_version(&mut changed, REVISION, kind, role, "context-changed") >= 1,
                "{name}"
            );
            assert_eq!(
                input_status(&fixture, &past, &changed, REVISION)?,
                QualificationStatus::Current,
                "{name} is recorded, not compared"
            );
        }
        Ok(())
    }

    #[test]
    fn expected_set_rule_rejects_missing_and_extra_targets_for_revision_inputs() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        // Missing: drop one of the Revision's Source references (every kind
        // keeps one, so only the set rule can see it).
        let mut missing = past.attempt.clone();
        let mut dropped = false;
        missing.inputs[REVISION]
            .qualifications
            .references
            .retain(|row| {
                if row.kind == QualificationKind::Source {
                    return std::mem::replace(&mut dropped, true);
                }
                true
            });
        let status = input_status(&fixture, &past, &missing, REVISION)?;
        assert!(
            matches!(
                status,
                QualificationStatus::Excluded(RequalificationReason::ExpectedSetMismatch(v))
                    if v.reason == CompletenessReason::ExpectedTargetMissing
            ),
            "{status:?}"
        );
        // Extra: a Source the current Revision does not name.
        let mut extra = past.attempt.clone();
        extra.inputs[REVISION]
            .qualifications
            .references
            .push(QualificationReference {
                kind: QualificationKind::Source,
                body: QualificationBody::Present {
                    identity: "codex:not-in-the-revision".into(),
                    version: "t".into(),
                    scope_role: None,
                },
            });
        let status = input_status(&fixture, &past, &extra, REVISION)?;
        assert!(
            matches!(
                status,
                QualificationStatus::Excluded(RequalificationReason::ExpectedSetMismatch(v))
                    if v.reason == CompletenessReason::UnexpectedTarget
            ),
            "{status:?}"
        );
        // The Human and the Raw have expected sets too.
        let mut human = past.attempt.clone();
        human.inputs[HUMAN]
            .qualifications
            .references
            .push(QualificationReference {
                kind: QualificationKind::Source,
                body: QualificationBody::Present {
                    identity: "an-extra-message-version".into(),
                    version: "t".into(),
                    scope_role: None,
                },
            });
        assert!(matches!(
            input_status(&fixture, &past, &human, HUMAN)?,
            QualificationStatus::Excluded(RequalificationReason::ExpectedSetMismatch(_))
        ));
        Ok(())
    }

    #[test]
    fn na_is_rederived_from_the_input_type_and_source_key() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        // The target Scene's body Raw takes the target-scene reason; the
        // other reason is a forgery for this key.
        let mut forged = past.attempt.clone();
        for row in &mut forged.inputs[RAW].qualifications.references {
            if let QualificationBody::NotApplicable { reason } = &mut row.body {
                if *reason == NotApplicableReason::TargetSceneBodyNotADependency {
                    *reason = NotApplicableReason::ExactSourceToken;
                }
            }
        }
        let status = input_status(&fixture, &past, &forged, RAW)?;
        assert!(
            matches!(
                status,
                QualificationStatus::Excluded(RequalificationReason::NotApplicableMismatch(_))
            ),
            "{status:?}"
        );
        // A reference where the table puts an N/A.
        let mut reference_and_na = past.attempt.clone();
        reference_and_na.inputs[HUMAN]
            .qualifications
            .references
            .push(QualificationReference {
                kind: QualificationKind::Revision,
                body: QualificationBody::Present {
                    identity: "r".into(),
                    version: "v".into(),
                    scope_role: None,
                },
            });
        assert!(matches!(
            input_status(&fixture, &past, &reference_and_na, HUMAN)?,
            QualificationStatus::Excluded(RequalificationReason::NotApplicableMismatch(_))
        ));
        Ok(())
    }

    #[test]
    fn d1_recompute_rejects_a_changed_selection_input_or_parameter() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let attempt_status = |attempt: &AttemptSnapshot| -> Result<QualificationStatus> {
            with_qualifier(&fixture, |q| q.qualify_attempt(attempt, &past.current))
        };
        assert_eq!(attempt_status(&past.attempt)?, QualificationStatus::Current);
        // A parameter of the selection.
        let mut parameter = past.attempt.clone();
        let recorded = parameter.recorded.as_mut().expect("recorded");
        recorded.d1.used_tokens = crate::nir1_generation::history_context::HistoryInt::new(
            recorded.d1.used_tokens.get() + 1,
        )?;
        recorded.d1.remaining_tokens = crate::nir1_generation::history_context::HistoryInt::new(
            recorded.d1.remaining_tokens.get() - 1,
        )?;
        assert_eq!(
            attempt_status(&parameter)?,
            excluded(RequalificationReason::D1RecomputeMismatch)
        );
        // The estimator-independent budget.
        let mut budget = past.attempt.clone();
        budget
            .recorded
            .as_mut()
            .expect("recorded")
            .d1
            .selector_budget_tokens = crate::nir1_generation::history_context::HistoryInt::new(7)?;
        assert_eq!(
            attempt_status(&budget)?,
            excluded(RequalificationReason::D1RecomputeMismatch)
        );
        // A selection input: a different target, a different order.
        let mut target = past.attempt.clone();
        target.inputs[RAW].kind = HistoryInputKind::RawSource {
            source_key: "project:scene:another".into(),
            revision_token: "t".into(),
        };
        assert_eq!(
            attempt_status(&target)?,
            excluded(RequalificationReason::D1RecomputeMismatch)
        );
        let mut reordered = past.attempt.clone();
        reordered.inputs.swap(REVISION, REVISION + 1);
        assert_eq!(
            attempt_status(&reordered)?,
            excluded(RequalificationReason::D1RecomputeMismatch)
        );
        // A D1 reference that is not the attempt's selection digest.
        let mut reference = past.attempt.clone();
        assert!(
            set_version(
                &mut reference,
                RAW,
                QualificationKind::D1,
                None,
                "sha256:other"
            ) >= 1
        );
        assert_eq!(
            input_status(&fixture, &past, &reference, RAW)?,
            excluded(RequalificationReason::D1RecomputeMismatch)
        );
        Ok(())
    }

    #[test]
    fn requalify_index_graph_is_pending_and_artifact_is_unsupported() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let mut graph = past.attempt.clone();
        graph.inputs[RAW].kind = HistoryInputKind::GraphEvidence {
            evidence_ref: "evidence".into(),
            source_key: "project:scene:x".into(),
            revision_token: "t".into(),
        };
        assert_eq!(
            input_status(&fixture, &past, &graph, RAW)?,
            QualificationStatus::Pending
        );
        let mut artifact = past.attempt.clone();
        artifact.inputs[RAW].kind = HistoryInputKind::Artifact {
            artifact_id: "artifact".into(),
            payload_digest: "sha256:x".into(),
            producer_attempt_id: None,
            receipt: None,
        };
        assert_eq!(
            input_status(&fixture, &past, &artifact, RAW)?,
            excluded(RequalificationReason::ArtifactUnsupported)
        );
        Ok(())
    }

    #[test]
    fn a2_unavailable_revision_is_excluded_not_a_run_stop() -> Result<()> {
        use crate::narrative_extraction::nir1_entity_relation::tests::{
            approve_typed_revision, create_typed_run, create_version_one_revision_for_test,
            request_for_run,
        };

        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let db = fixture.snapshot.db().db();
        create_typed_run(db, "version-one-run")?;
        let created = create_version_one_revision_for_test(
            db,
            request_for_run(db, "version-one-run", "version-one-proposal"),
        )?;
        approve_typed_revision(db, "version-one-run", &created)?;
        let revision_id = created["revisionId"]
            .as_str()
            .expect("revision id")
            .to_owned();
        let mut legacy = past.attempt.clone();
        legacy.inputs[REVISION].kind = HistoryInputKind::AcceptedRevision {
            revision_id: revision_id.clone(),
            bundle_digest: "sha256:any".into(),
        };
        let (status, stopped) = with_qualifier(&fixture, |q| {
            let status =
                q.qualify_input(&legacy, REVISION, &legacy.inputs[REVISION], &past.current);
            (status, q.has_stopped())
        })?;
        assert_eq!(
            status,
            excluded(RequalificationReason::RevisionUnavailableByA2)
        );
        assert!(!stopped, "a typed absence never stops the run");
        Ok(())
    }

    #[test]
    fn typed_revision_not_eligible_by_a3_excludes_the_candidate() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        // The same Revisions judged for the earliest Scene of the project: a
        // Revision anchored after the query Scene is not disclosable there.
        // The current A3 evaluation decides, whatever the recorded context
        // references say (they cannot raise a disclosure).
        let early_scene = "a3-source";
        let revision = past.projection.authority_bindings()[0]
            .revision_id()
            .to_owned();
        let direct = fixture.snapshot.db().with_read_transaction(|conn| {
            evaluate_nir1_entity_relation_disclosure(
                conn,
                RAW_SOURCE_PROJECT,
                &revision,
                early_scene,
            )
        })?;
        let Nir1EntityRelationDisclosureRead::Unavailable { reason } = direct else {
            panic!("the Revision is not disclosable for the earliest Scene");
        };
        assert!(reason.starts_with("a3-"), "{reason}");
        let mut moved = past.attempt.clone();
        moved.target_scene_id = Some(early_scene.into());
        let mut current = past.current.clone();
        current.range.scene_id = early_scene.into();
        // Forge every request-context reference: nothing recorded can make
        // the current evaluation Eligible.
        for role in [
            ScopeRole::ProjectAuthority,
            ScopeRole::RevealState,
            ScopeRole::QuerySceneSource,
            ScopeRole::MaterialSceneProof,
        ] {
            set_version(
                &mut moved,
                REVISION,
                QualificationKind::Scope,
                Some(role),
                "forged",
            );
        }
        set_version(
            &mut moved,
            REVISION,
            QualificationKind::Freshness,
            None,
            "forged",
        );
        let status = with_qualifier(&fixture, |q| {
            q.qualify_input(&moved, REVISION, &moved.inputs[REVISION], &current)
        })?;
        assert_eq!(
            status,
            excluded(RequalificationReason::DisclosureIneligible)
        );
        Ok(())
    }

    #[test]
    fn a3_evaluation_runs_once_per_revision_and_target_scene_per_turn() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let mut second = past.attempt.clone();
        second.id = "second-attempt".into();
        let counts = with_qualifier(&fixture, |q| {
            for attempt in [&past.attempt, &second, &past.attempt] {
                for ordinal in [REVISION, REVISION + 1] {
                    assert_eq!(
                        q.qualify_input(attempt, ordinal, &attempt.inputs[ordinal], &past.current),
                        QualificationStatus::Current
                    );
                }
            }
            q.a3_evaluation_count()
        })?;
        assert_eq!(
            counts, 2,
            "two Revisions, six input checks, two evaluations"
        );
        Ok(())
    }

    #[test]
    fn history_requalification_never_calls_revalidate() {
        // The whole history path (the traversal, the snapshot reads and this
        // requalifier) never names a `revalidate` function, directly or
        // through a wrapper written in these files.
        for (name, source) in [
            (
                "nir1_history_requalification.rs",
                include_str!("nir1_history_requalification.rs"),
            ),
            (
                "nir1_generation_history.rs",
                include_str!("../nir1_generation_history.rs"),
            ),
            (
                "nir1_generation/history_reads.rs",
                include_str!("../nir1_generation/history_reads.rs"),
            ),
        ] {
            let production = source
                .split("#[cfg(test)]")
                .next()
                .expect("production part");
            for line in production.lines() {
                let code = line.trim_start();
                if code.starts_with("//") {
                    continue;
                }
                assert!(
                    !code.to_ascii_lowercase().contains("revalidate"),
                    "{name}: revalidate must not be used: {line}"
                );
            }
        }
    }

    #[test]
    fn requalification_writes_nothing() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let counts = |conn: &rusqlite::Connection| -> Result<BTreeMap<String, i64>> {
            let mut names = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
                  AND name NOT LIKE '%_fts%'",
            )?;
            let names: Vec<String> = names
                .query_map([], |row| row.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            names
                .into_iter()
                .map(|name| {
                    let count =
                        conn.query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |row| {
                            row.get(0)
                        })?;
                    Ok((name, count))
                })
                .collect()
        };
        let (before, after, changes) = fixture
            .snapshot
            .db()
            .with_participant_read_transaction_bounded(
                fixture.snapshot.participant(),
                prepared_sql_budget(),
                |conn| {
                    let before = counts(conn)?;
                    let changes_before = conn.total_changes();
                    let mut qualifier =
                        HistoryRequalifier::new(HistoryAuthorityConnection::for_test(conn));
                    assert_eq!(
                        qualifier.qualify_attempt(&past.attempt, &past.current),
                        QualificationStatus::Current
                    );
                    for ordinal in 0..past.attempt.inputs.len() {
                        assert_eq!(
                            qualifier.qualify_input(
                                &past.attempt,
                                ordinal,
                                &past.attempt.inputs[ordinal],
                                &past.current
                            ),
                            QualificationStatus::Current
                        );
                    }
                    Ok((before, counts(conn)?, conn.total_changes() - changes_before))
                },
            )?;
        assert_eq!(before, after, "no row count changed");
        assert_eq!(changes, 0, "no statement changed a row");
        Ok(())
    }

    #[test]
    fn classify_unavailable_maps_the_a3_reason_strings_to_closed_reasons() {
        use RequalificationReason as R;
        for (reason, expected) in [
            (
                "revision-material-contract-superseded",
                R::RevisionUnavailableByA2,
            ),
            (
                "revision-material-contract-unsupported",
                R::RevisionUnavailableByA2,
            ),
            (
                "revision-material-contract-mixed",
                R::RevisionUnavailableByA2,
            ),
            ("canonical-freshness-unavailable", R::FreshnessNotFresh),
            ("source-revision-changed", R::SourceStale),
            ("revision-material-mismatch", R::SourceStale),
            ("revision-not-found", R::RevisionStale),
            ("revision-restore-invalidated", R::RevisionStale),
            ("revision-not-human-approved", R::DecisionStale),
            ("a3-reading-before-query-violation", R::DisclosureIneligible),
            ("a3-phase-future", R::DisclosureIneligible),
            ("something-new", R::DisclosureIneligible),
        ] {
            assert_eq!(classify_unavailable(reason), expected, "{reason}");
        }
    }

    #[test]
    fn a_failed_read_stops_the_run_and_keeps_the_error() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        // The column the message read needs is gone: a failed read (SQLite
        // error), not a typed absence. The qualifier answers Unavailable (the
        // run stops), keeps the error, and adopts nothing afterwards; it never
        // excludes the candidate as if the version were invalid.
        fixture.snapshot.db().db().with_conn(|conn| {
            conn.execute_batch(
                "ALTER TABLE nir1_generation_message_versions
                 RENAME COLUMN invalidated TO invalidated_gone",
            )?;
            Ok(())
        })?;
        let (status, again, kept) = with_qualifier(&fixture, |qualifier| {
            let status = qualifier.qualify_input(
                &past.attempt,
                HUMAN,
                &past.attempt.inputs[HUMAN],
                &past.current,
            );
            // Any later question gets the same answer without a read.
            let again = qualifier.qualify_input(
                &past.attempt,
                RAW,
                &past.attempt.inputs[RAW],
                &past.current,
            );
            (status, again, qualifier.take_stop().is_some())
        })?;
        assert_eq!(status, QualificationStatus::Unavailable);
        assert_eq!(again, QualificationStatus::Unavailable);
        assert!(kept, "the error is kept for the run entry");
        Ok(())
    }

    #[test]
    fn the_traversal_maps_the_requalifier_into_closed_exclusions_and_a_run_stop() -> Result<()> {
        use crate::nir1_generation_history::{
            reauthorize_history, Candidate, CandidateDisposition, Failure, HistoryBudget,
            HistoryRunError, HistorySnapshot, IneligibleReason,
        };

        let fixture = DfFinalFixture::new()?;
        let mut past = past(&fixture)?;
        // This fixture has no story time or POV, so its own axes can never
        // match; the traversal test gives both sides the same complete axes
        // (the requalifier does not read the axes: `compare_context` does).
        let axes = crate::nir1_generation::history_context::testing::sample_context().axes;
        past.current.axes = axes.clone();
        past.attempt
            .recorded
            .as_mut()
            .expect("recorded")
            .context
            .axes = axes;
        let candidate = Candidate {
            id: "candidate".into(),
            root_attempt_id: past.attempt.id.clone(),
            adopted_input_ordinals: vec![0, 1, 2, 3],
        };
        let current = CurrentHistoryContext::Known(Box::new(past.current.clone()));
        let run = |attempt: &AttemptSnapshot| -> Result<_> {
            let snapshot = HistorySnapshot::from_attempts([attempt.clone()]).expect("snapshot");
            fixture
                .snapshot
                .db()
                .with_participant_read_transaction_bounded(
                    fixture.snapshot.participant(),
                    prepared_sql_budget(),
                    |conn| {
                        let mut qualifier =
                            HistoryRequalifier::new(HistoryAuthorityConnection::for_test(conn));
                        let mut budget = HistoryBudget::new(32, 32, 256);
                        let mut cancelled = || false;
                        let outcome = reauthorize_history(
                            &snapshot,
                            std::slice::from_ref(&candidate),
                            &current,
                            1_000,
                            &mut budget,
                            &mut qualifier,
                            &mut cancelled,
                        );
                        Ok((outcome, qualifier.take_stop().is_some()))
                    },
                )
        };
        // The real attempt is adopted whole.
        let (outcome, stopped) = run(&past.attempt)?;
        assert_eq!(
            outcome.expect("outcome").candidates[0].disposition,
            CandidateDisposition::Qualified
        );
        assert!(!stopped);
        // A stale dependency excludes the candidate with the closed reason.
        let mut stale = past.attempt.clone();
        assert!(
            set_version(
                &mut stale,
                REVISION,
                QualificationKind::Decision,
                None,
                "sha256:changed"
            ) >= 1
        );
        let (outcome, _) = run(&stale)?;
        assert_eq!(
            outcome.expect("outcome").candidates[0].disposition,
            CandidateDisposition::Excluded(Failure::Ineligible(IneligibleReason::Requalification(
                RequalificationReason::DecisionStale
            )))
        );
        // A failed read stops the whole run (never a partial history) and the
        // error is the qualifier's, not a closed reason.
        fixture.snapshot.db().db().with_conn(|conn| {
            conn.execute_batch(
                "ALTER TABLE nir1_generation_message_versions
                 RENAME COLUMN invalidated TO invalidated_gone",
            )?;
            Ok(())
        })?;
        let (outcome, stopped) = run(&past.attempt)?;
        assert_eq!(outcome, Err(HistoryRunError::AuthorityUnavailable));
        assert!(stopped, "the read error is kept for the run entry");
        Ok(())
    }

    #[test]
    fn the_reader_hands_out_the_connection_of_its_own_read_snapshot() -> Result<()> {
        use crate::narrative_maintenance_connection::ParticipantSqlControl;
        use crate::nir1_generation::{
            with_generation_history_snapshot, GenerationHistoryReadBudget,
            GenerationHistorySnapshotSqlBudget, GenerationHistorySqlLedger,
        };
        use std::time::{Duration, Instant};

        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let mut budget = GenerationHistoryReadBudget {
            max_attempts: 8,
            sql: Some(GenerationHistorySqlLedger::new(
                GenerationHistorySnapshotSqlBudget {
                    max_vm_steps: 200_000_000,
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
        };
        let statuses = with_generation_history_snapshot(
            &fixture.snapshot,
            ParticipantSqlControl::default(),
            &mut budget,
            |reader, _budget, _cancellation| {
                let mut qualifier = HistoryRequalifier::new(reader.authority_connection());
                let mut statuses = vec![qualifier.qualify_attempt(&past.attempt, &past.current)];
                for ordinal in 0..past.attempt.inputs.len() {
                    statuses.push(qualifier.qualify_input(
                        &past.attempt,
                        ordinal,
                        &past.attempt.inputs[ordinal],
                        &past.current,
                    ));
                }
                Ok(statuses)
            },
        )?;
        assert_eq!(statuses, vec![QualificationStatus::Current; 5]);
        Ok(())
    }

    #[test]
    fn target_body_exception_does_not_reach_a_revision_source_of_the_same_key() -> Result<()> {
        let fixture = DfFinalFixture::new()?;
        let past = past(&fixture)?;
        let target_body = format!("project:scene:{RAW_SOURCE_SCENE}");
        let current_token = fixture.snapshot.db().with_read_transaction(|conn| {
            Ok(
                resolve_source_revision(conn, RAW_SOURCE_PROJECT, "", "scene-body", &target_body)?
                    .revision_token,
            )
        })?;
        let (raw_stale, revision_stale, revision_current) = with_qualifier(&fixture, |q| {
            let raw = &past.attempt.inputs[RAW];
            let revision = &past.attempt.inputs[REVISION];
            (
                // The Raw of the target Scene's body: recorded, not compared.
                q.check_source(
                    RAW_SOURCE_PROJECT,
                    RAW_SOURCE_SCENE,
                    &past.current,
                    raw,
                    &target_body,
                    "v0@stale",
                ),
                // The same key as a Revision's Evidence Source is an exact
                // dependency (Q8 reaches only the Raw input).
                q.check_source(
                    RAW_SOURCE_PROJECT,
                    RAW_SOURCE_SCENE,
                    &past.current,
                    revision,
                    &target_body,
                    "v0@stale",
                ),
                q.check_source(
                    RAW_SOURCE_PROJECT,
                    RAW_SOURCE_SCENE,
                    &past.current,
                    revision,
                    &target_body,
                    &current_token,
                ),
            )
        })?;
        assert!(raw_stale.is_ok());
        assert!(matches!(
            revision_stale,
            Err(Verdict::Exclude(RequalificationReason::SourceStale))
        ));
        assert!(revision_current.is_ok());
        Ok(())
    }

    #[test]
    fn source_kinds_with_a_resolver_are_recognized_by_key_and_nothing_else() {
        for (key, kind) in [
            ("project:scene:abc", Some("scene-body")),
            ("codex:entity-1", Some("codex-entry")),
            ("codex-relation:edge-1", Some("codex-relation")),
            (
                "project:scene-scope-projection:abc",
                Some(scene_scope_projection::SOURCE_KIND),
            ),
            // Empty ids, other kinds and look-alikes have no resolver here.
            ("project:scene:", None),
            ("codex:", None),
            ("snapshot:run", None),
            ("project:scope-authority:p", None),
            ("project:nir1-entity-relation-eligibility:p", None),
            ("artifact:x", None),
            ("scene:abc", None),
        ] {
            assert_eq!(source_kind_for_key(key), kind, "{key}");
        }
    }
}
