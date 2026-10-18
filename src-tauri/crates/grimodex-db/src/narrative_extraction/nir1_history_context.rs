//! The history turn context builder (K4/3 sections 2, 4 and 7; HS1-4).
//!
//! D-final reads the prepared inputs in one participant read transaction. The
//! builder runs inside that transaction and records, as digests, integers and
//! closed enums, what the turn's context is: the project's restore epoch, the
//! target Scene's Scope binding (token digest and version), the nine axes
//! (`readingOrder`, `storyTime`, `viewpoint`, `knowledgeHolder`, `audience`,
//! `timeline`, `worldline`, `narrativeLayer`, `auto`) and the send
//! classification. It builds in two stages:
//!
//! 1. inside the snapshot, everything except the D1 selection fields
//!    ([`HistoryContextStage`]);
//! 2. after the render, when the usage is known, [`finish_history_draft`] adds
//!    the D1 fields and decides `d-final-incomplete`.
//!
//! A reason that a value cannot be built is a closed enum, never plaintext:
//! the turn is not stopped for it (the attempt is created with an unavailable
//! slot that no history reader uses). A SQLite or IO error is not such a
//! reason; it propagates and stops the turn. The builder writes nothing and
//! carries no authority: the storage writer re-derives `eligibleUntilMs`,
//! re-checks the completeness rule and applies the 64 KiB limit.

use anyhow::Result;
use grimodex_core::narrative_scene_scope::{
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
};
use rusqlite::Connection;

use super::nir1_entity_relation::{
    load_history_facts, HistoryStoryFact, HistoryViewpointFact, Nir1HistoryFacts,
};
use crate::nir1_generation::history_context::{
    DurableWorkspaceIdentity, HistoryAuto, HistoryAutoFallback, HistoryAutoUnavailable,
    HistoryAxes, HistoryAxis, HistoryContextContract, HistoryContextSlot, HistoryD1Selection,
    HistoryDigest, HistoryDigestDomain, HistoryEffectiveAxis, HistoryEstimatorVersion, HistoryInt,
    HistoryPhaseSetting, HistoryPrincipal, HistoryPrincipalUnavailable, HistoryReadingOrder,
    HistoryReadingOrderUnavailable, HistoryRestoreEpoch, HistoryScopeRef,
    HistoryScopeRefUnavailable, HistorySendClassification, HistoryStoryTime,
    HistoryStoryTimeUnavailable, HistoryTargetScope, HistoryTurnContextV1,
    HistoryUnavailableReason, HistoryViewpoint, HistoryViewpointUnavailable,
};
use crate::nir1_generation::{
    d1_selection_digest, D1SelectionParameters, GenerationPurpose, InputReference,
};
use crate::nir1_generation_history::{
    CurrentHistoryContext, HistoryComparisonContext, HistoryRange,
};

/// The context minus `eligibleUntilMs` (the writer derives it from the stored
/// row) and the D1 selection fields (known after the render).
///
/// `pub(crate)` since HC1-2: the history reader compares the current turn's
/// body (the value D-final's snapshot built, not a second derivation) with the
/// recorded contexts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HistoryContextBody {
    pub(crate) send_classification: HistorySendClassification,
    pub(crate) restore_epoch: HistoryRestoreEpoch,
    pub(crate) target: HistoryTargetScope,
    pub(crate) axes: HistoryAxes,
}

/// What the snapshot could build.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HistoryContextOutcome {
    Context(Box<HistoryContextBody>),
    Unavailable(HistoryUnavailableReason),
}

/// The first stage: built in the D-final snapshot, kept by the prepared
/// inputs until the render has fixed the D1 usage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryContextStage {
    outcome: HistoryContextOutcome,
    durable_workspace_identity: Option<DurableWorkspaceIdentity>,
}

impl HistoryContextStage {
    /// A stage that is already unavailable (tests and callers that cannot
    /// build a context).
    pub fn unavailable(
        reason: HistoryUnavailableReason,
        durable_workspace_identity: Option<DurableWorkspaceIdentity>,
    ) -> Self {
        Self {
            outcome: HistoryContextOutcome::Unavailable(reason),
            durable_workspace_identity,
        }
    }

    #[cfg(test)]
    pub(super) fn outcome(&self) -> &HistoryContextOutcome {
        &self.outcome
    }

    /// The current turn's context for the history reader (K4/3 section 4),
    /// from the value this stage already holds: the body the builder made
    /// inside D-final's snapshot and the durable workspace identity it
    /// observed. `range` and `purpose` are the prepared request's (the DB's
    /// chat session, the target Scene's id and incarnation, the purpose).
    /// There is no second derivation: an unavailable stage stays unavailable.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the history run entry that receives the current context is DI-1b's"
        )
    )]
    pub(crate) fn current_history_context(
        &self,
        range: HistoryRange,
        purpose: GenerationPurpose,
    ) -> CurrentHistoryContext {
        match &self.outcome {
            HistoryContextOutcome::Unavailable(reason) => {
                CurrentHistoryContext::Unavailable(*reason)
            }
            HistoryContextOutcome::Context(body) => {
                CurrentHistoryContext::Known(Box::new(HistoryComparisonContext {
                    range,
                    purpose,
                    durable_identity: self.durable_workspace_identity.clone(),
                    send_classification: body.send_classification,
                    restore_epoch: body.restore_epoch.clone(),
                    target: body.target.clone(),
                    axes: body.axes.clone(),
                }))
            }
        }
    }
}

/// The history slot of one prepared request and the durable workspace
/// identity the builder observed. It is a value: it carries no authority, no
/// attempt data and no send capability. `eligibleUntilMs` is `0` in a context
/// here; the storage writer sets it from the stored row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1HistoryDraft {
    /// A context, or the closed reason there is none. Never null.
    pub slot: HistoryContextSlot,
    /// The identity of the workspace that was Ready when the request was
    /// prepared. The owner compares it with its own `LiveBinding`'s.
    pub durable_workspace_identity: Option<DurableWorkspaceIdentity>,
}

impl NativeNir1HistoryDraft {
    pub fn unavailable(
        reason: HistoryUnavailableReason,
        durable_workspace_identity: Option<DurableWorkspaceIdentity>,
    ) -> Self {
        Self {
            slot: HistoryContextSlot::Unavailable(reason),
            durable_workspace_identity,
        }
    }
}

/// Build the first stage inside the caller's read transaction.
///
/// `durable_workspace_identity` is the identity captured when the workspace
/// became Ready (`None` when it could not be determined); without it no
/// context is recorded and nothing is read. `send_classification` is decided
/// by the Native route and only passed through.
pub(super) fn build_history_context_stage(
    conn: &Connection,
    project_id: &str,
    query_scene_id: &str,
    durable_workspace_identity: Option<&DurableWorkspaceIdentity>,
    send_classification: HistorySendClassification,
) -> Result<HistoryContextStage> {
    let identity = durable_workspace_identity.cloned();
    if identity.is_none() {
        return Ok(HistoryContextStage::unavailable(
            HistoryUnavailableReason::WorkspaceIdentityUnavailable,
            None,
        ));
    }
    let facts = load_history_facts(conn, project_id, query_scene_id)?;
    Ok(HistoryContextStage {
        outcome: outcome_from_facts(&facts, send_classification)?,
        durable_workspace_identity: identity,
    })
}

fn digest(domain: HistoryDigestDomain, value: &str) -> Result<HistoryDigest> {
    HistoryDigest::of(domain, value)
}

/// The pure mapping from the facts of the snapshot to the first-stage
/// outcome. A fact that is outside every closed case is an error (the turn
/// stops) rather than a value invented for the slot.
fn outcome_from_facts(
    facts: &Nir1HistoryFacts,
    send_classification: HistorySendClassification,
) -> Result<HistoryContextOutcome> {
    use HistoryContextOutcome::Unavailable;

    let Some(epoch) = &facts.epoch else {
        return Ok(Unavailable(
            HistoryUnavailableReason::RestoreEpochUnavailable,
        ));
    };
    let Ok(epoch_number) = HistoryInt::from_i64(epoch.epoch_number) else {
        return Ok(Unavailable(
            HistoryUnavailableReason::RestoreEpochUnavailable,
        ));
    };
    let Some(binding) = &facts.scope else {
        return Ok(Unavailable(HistoryUnavailableReason::SceneScopeUnavailable));
    };
    let Ok(version) = HistoryInt::from_i64(binding.version) else {
        return Ok(Unavailable(HistoryUnavailableReason::SceneScopeUnavailable));
    };
    let explicit = binding.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::Explicit;
    let axes = HistoryAxes {
        reading_order: reading_order_axis(facts)?,
        story_time: story_time_axis(facts)?,
        viewpoint: viewpoint_axis(facts)?,
        knowledge_holder: principal_axis(explicit, &binding.knowledge_holder)?,
        audience: principal_axis(explicit, &binding.audience)?,
        timeline: scope_ref_axis(
            explicit,
            &binding.query_identity.timeline,
            HistoryDigestDomain::TimelineRef,
        )?,
        worldline: scope_ref_axis(
            explicit,
            &binding.query_identity.worldline,
            HistoryDigestDomain::WorldlineRef,
        )?,
        narrative_layer: scope_ref_axis(
            explicit,
            &binding.query_identity.narrative_layer,
            HistoryDigestDomain::NarrativeLayerRef,
        )?,
        auto: auto_axis(facts)?,
    };
    Ok(HistoryContextOutcome::Context(Box::new(
        HistoryContextBody {
            send_classification,
            restore_epoch: HistoryRestoreEpoch {
                id_digest: digest(HistoryDigestDomain::RestoreEpochId, &epoch.id)?,
                number: epoch_number,
            },
            target: HistoryTargetScope {
                binding_token_digest: digest(
                    HistoryDigestDomain::ScopeBindingToken,
                    &binding.source_token,
                )?,
                version,
            },
            axes,
        },
    )))
}

fn reading_order_axis(
    facts: &Nir1HistoryFacts,
) -> Result<HistoryAxis<HistoryReadingOrder, HistoryReadingOrderUnavailable>> {
    let Some(mapping) = &facts.mapping else {
        return Ok(HistoryAxis::Unavailable(
            HistoryReadingOrderUnavailable::SceneNotInAuthorityMapping,
        ));
    };
    Ok(HistoryAxis::Present(HistoryReadingOrder {
        reading_ref_digest: digest(HistoryDigestDomain::ReadingRef, &mapping.reading_order_ref)?,
        rank: HistoryInt::new(mapping.reading_rank)?,
    }))
}

/// The Scene's own key only. An inherited (forward-filled) position is never
/// a witness, and neither the story rank nor the authority revision is
/// recorded.
fn story_time_axis(
    facts: &Nir1HistoryFacts,
) -> Result<HistoryAxis<HistoryStoryTime, HistoryStoryTimeUnavailable>> {
    use HistoryAxis::Unavailable;
    let Some(mapping) = &facts.mapping else {
        return Ok(Unavailable(
            HistoryStoryTimeUnavailable::SceneNotInAuthorityMapping,
        ));
    };
    Ok(match &mapping.story {
        HistoryStoryFact::Resolved { raw_story_key } => HistoryAxis::Present(HistoryStoryTime {
            story_ref_digest: digest(HistoryDigestDomain::StoryRef, &mapping.story_time_ref)?,
            raw_key_digest: digest(HistoryDigestDomain::StoryRawKey, raw_story_key)?,
        }),
        HistoryStoryFact::NotProvided => Unavailable(HistoryStoryTimeUnavailable::KeyNotProvided),
        HistoryStoryFact::Ambiguous => Unavailable(HistoryStoryTimeUnavailable::KeyAmbiguous),
        HistoryStoryFact::InheritedOnly => Unavailable(HistoryStoryTimeUnavailable::InheritedOnly),
    })
}

fn viewpoint_axis(
    facts: &Nir1HistoryFacts,
) -> Result<HistoryAxis<HistoryViewpoint, HistoryViewpointUnavailable>> {
    Ok(match &facts.viewpoint {
        HistoryViewpointFact::Pov(character) => HistoryAxis::Present(HistoryViewpoint {
            pov_digest: digest(HistoryDigestDomain::PovCharacter, character)?,
        }),
        HistoryViewpointFact::NotProvided => {
            HistoryAxis::Unavailable(HistoryViewpointUnavailable::NotProvided)
        }
        HistoryViewpointFact::NotVisibleCharacter => {
            HistoryAxis::Unavailable(HistoryViewpointUnavailable::NotVisibleCharacter)
        }
    })
}

fn principal_axis(
    explicit: bool,
    principal: &NarrativeScopePrincipalV1,
) -> Result<HistoryAxis<HistoryPrincipal, HistoryPrincipalUnavailable>> {
    let unavailable = HistoryAxis::Unavailable(HistoryPrincipalUnavailable::BindingNotExplicit);
    if !explicit {
        return Ok(unavailable);
    }
    Ok(match principal {
        NarrativeScopePrincipalV1::Reader {} => HistoryAxis::Present(HistoryPrincipal::Reader),
        NarrativeScopePrincipalV1::Character { reference } if !reference.trim().is_empty() => {
            HistoryAxis::Present(HistoryPrincipal::Character(digest(
                HistoryDigestDomain::PrincipalCharacter,
                reference,
            )?))
        }
        NarrativeScopePrincipalV1::Character { .. } => unavailable,
    })
}

/// The Scene's query identity (the same value A3 requires to be Exact).
fn scope_ref_axis(
    explicit: bool,
    constraint: &NarrativeScopeConstraintV1,
    domain: HistoryDigestDomain,
) -> Result<HistoryAxis<HistoryScopeRef, HistoryScopeRefUnavailable>> {
    use HistoryAxis::Unavailable;
    if !explicit {
        return Ok(Unavailable(HistoryScopeRefUnavailable::BindingNotExplicit));
    }
    Ok(match constraint {
        NarrativeScopeConstraintV1::Exact { reference } if !reference.trim().is_empty() => {
            HistoryAxis::Present(HistoryScopeRef {
                ref_digest: digest(domain, reference)?,
            })
        }
        NarrativeScopeConstraintV1::Exact { .. }
        | NarrativeScopeConstraintV1::Unresolved { .. } => {
            Unavailable(HistoryScopeRefUnavailable::Unresolved)
        }
        NarrativeScopeConstraintV1::Any => Unavailable(HistoryScopeRefUnavailable::Any),
    })
}

fn auto_axis(facts: &Nir1HistoryFacts) -> Result<HistoryAxis<HistoryAuto, HistoryAutoUnavailable>> {
    let Some(auto) = &facts.auto else {
        return Ok(HistoryAxis::Unavailable(
            HistoryAutoUnavailable::SceneNotInAuthorityMapping,
        ));
    };
    let setting = match auto.setting.as_str() {
        "reading" => HistoryPhaseSetting::Reading,
        "story" => HistoryPhaseSetting::Story,
        "auto" => HistoryPhaseSetting::Auto,
        _ => anyhow::bail!("NIR1_HISTORY_CONTEXT_PHASE_SETTING_UNKNOWN"),
    };
    let axis = match auto.axis_used.as_str() {
        "reading" => HistoryEffectiveAxis::Reading,
        "story" => HistoryEffectiveAxis::Story,
        _ => anyhow::bail!("NIR1_HISTORY_CONTEXT_AXIS_UNKNOWN"),
    };
    let fallback = match auto.fallback_reason.as_deref() {
        None => None,
        Some("auto-incomplete-story-coverage") => {
            Some(HistoryAutoFallback::AutoIncompleteStoryCoverage)
        }
        Some("story-current-unresolved") => Some(HistoryAutoFallback::StoryCurrentUnresolved),
        Some(_) => anyhow::bail!("NIR1_HISTORY_CONTEXT_AXIS_FALLBACK_UNKNOWN"),
    };
    Ok(HistoryAxis::Present(HistoryAuto {
        setting,
        axis,
        fallback,
    }))
}

/// The D1 fields of the context from the parameters the selection digest was
/// computed from. `None` when they cannot be represented (an unknown
/// estimator, an out-of-range integer, a digest that does not recompute from
/// the stored input rows).
fn d1_selection_fields(
    d1: &D1SelectionParameters,
    selection_digest: &str,
    inputs: &[InputReference],
) -> Option<HistoryD1Selection> {
    if d1_selection_digest(d1, inputs).ok()?.as_str() != selection_digest {
        return None;
    }
    Some(HistoryD1Selection {
        selection_digest: HistoryDigest::parse(selection_digest).ok()?,
        estimator_version: HistoryEstimatorVersion::from_wire(&d1.estimator_version)?,
        selector_budget_tokens: HistoryInt::new(d1.selector_budget_tokens).ok()?,
        used_tokens: HistoryInt::new(d1.used_tokens).ok()?,
        remaining_tokens: HistoryInt::new(d1.remaining_tokens).ok()?,
    })
}

/// The second stage. `output_is_complete` is the result of the D-final
/// completeness check (`check_completeness`, which includes the expected
/// `(kind, target)` set of rule 3) on the final qualification rows; a
/// violation, or D1 fields that do not recompute the selection digest from the
/// stored input rows, make the slot `d-final-incomplete`. A stage that is
/// already unavailable keeps its reason unless the output is incomplete.
pub(super) fn finish_history_draft(
    stage: &HistoryContextStage,
    output_is_complete: bool,
    d1: &D1SelectionParameters,
    selection_digest: &str,
    inputs: &[InputReference],
) -> NativeNir1HistoryDraft {
    let identity = stage.durable_workspace_identity.clone();
    let unavailable = |reason| NativeNir1HistoryDraft::unavailable(reason, identity.clone());
    if !output_is_complete {
        return unavailable(HistoryUnavailableReason::DFinalIncomplete);
    }
    let body = match &stage.outcome {
        HistoryContextOutcome::Unavailable(reason) => return unavailable(*reason),
        HistoryContextOutcome::Context(body) => body,
    };
    let Some(d1) = d1_selection_fields(d1, selection_digest, inputs) else {
        return unavailable(HistoryUnavailableReason::DFinalIncomplete);
    };
    NativeNir1HistoryDraft {
        slot: HistoryContextSlot::Context(Box::new(HistoryTurnContextV1 {
            contract: HistoryContextContract,
            send_classification: body.send_classification,
            eligible_until_ms: HistoryInt::new(0).expect("zero is in range"),
            restore_epoch: body.restore_epoch.clone(),
            target: body.target.clone(),
            axes: body.axes.clone(),
            d1,
        })),
        durable_workspace_identity: identity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
    use crate::narrative_extraction::nir1_entity_relation::tests::{
        prepare_a3_scope_fixture, seed_run_and_catalog,
    };
    use crate::narrative_extraction::nir1_entity_relation::{
        HistoryAutoFacts, HistoryMappingFacts,
    };
    use crate::nir1_generation::history_context::testing::sample_identity;
    use crate::nir1_generation::{
        d1_selection_reference, InputRole, InputTarget, InputUse, QualificationKind,
    };
    use crate::test_support::current_schema_memory;
    use crate::Database;
    use grimodex_core::narrative_scene_scope::{
        NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
        NarrativeSceneScopeBindingV1,
    };
    use rusqlite::params;

    const PROJECT: &str = "default-project";
    const TARGET: &str = "a3-future";
    const LOCAL: HistorySendClassification = HistorySendClassification::LocalOnly;

    /// Three Scenes in reading order: `a3-source`, `nir1`, `a3-future` (the
    /// target), each with an explicit Scope binding and nothing else set.
    fn base_db() -> Result<Database> {
        let db = current_schema_memory()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        run_incremental_freshness_cycle(&db)?;
        Ok(db)
    }

    fn sql(db: &Database, statement: &str) -> Result<()> {
        db.with_conn(|conn| {
            conn.execute_batch(statement)?;
            Ok(())
        })
    }

    fn set_story_keys(db: &Database, keys: &[(&str, Option<&str>)]) -> Result<()> {
        db.with_conn(|conn| {
            for (scene, key) in keys {
                conn.execute(
                    "UPDATE tree_nodes SET story_time_order = ?1
                      WHERE id = ?2 AND project_id = ?3",
                    params![key, scene, PROJECT],
                )?;
            }
            Ok(())
        })
    }

    fn set_mode(db: &Database, mode: &str) -> Result<()> {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE projects SET phase_resolution_mode = ?1 WHERE id = ?2",
                params![mode, PROJECT],
            )?;
            Ok(())
        })
    }

    fn build_for(
        db: &Database,
        scene: &str,
        identity: Option<&DurableWorkspaceIdentity>,
    ) -> Result<HistoryContextStage> {
        db.with_read_transaction(|conn| {
            build_history_context_stage(conn, PROJECT, scene, identity, LOCAL)
        })
    }

    fn build(db: &Database) -> Result<HistoryContextStage> {
        build_for(db, TARGET, Some(&sample_identity()))
    }

    fn body(stage: &HistoryContextStage) -> &HistoryContextBody {
        match stage.outcome() {
            HistoryContextOutcome::Context(body) => body,
            other => panic!("expected a context, got {other:?}"),
        }
    }

    fn reason(stage: &HistoryContextStage) -> HistoryUnavailableReason {
        match stage.outcome() {
            HistoryContextOutcome::Unavailable(reason) => *reason,
            other => panic!("expected an unavailable stage, got {other:?}"),
        }
    }

    fn all_keys(db: &Database) -> Result<()> {
        set_story_keys(
            db,
            &[
                ("a3-source", Some("k-1")),
                ("nir1", Some("k-2")),
                (TARGET, Some("k-3")),
            ],
        )
    }

    fn set_pov(db: &Database, character: Option<&str>) -> Result<()> {
        db.with_conn(|conn| {
            // A dangling POV is a state the reader must report, not one the
            // foreign key lets a writer reach.
            conn.execute_batch("PRAGMA foreign_keys = OFF")?;
            conn.execute(
                "UPDATE tree_nodes SET pov_character_id = ?1 WHERE id = ?2 AND project_id = ?3",
                params![character, TARGET, PROJECT],
            )?;
            conn.execute_batch("PRAGMA foreign_keys = ON")?;
            Ok(())
        })
    }

    #[test]
    fn builder_axes_table_covers_every_k4_axis_row() -> Result<()> {
        // A complete context: every explicit axis present, with the target
        // Scene's own story key and POV.
        let db = base_db()?;
        all_keys(&db)?;
        set_pov(&db, Some("nir1-alice"))?;
        let stage = build(&db)?;
        let context = body(&stage);
        assert!(matches!(
            context.axes.reading_order,
            HistoryAxis::Present(ref reading) if reading.rank.get() == 2
        ));
        assert!(matches!(context.axes.story_time, HistoryAxis::Present(_)));
        assert!(matches!(context.axes.viewpoint, HistoryAxis::Present(_)));
        assert!(matches!(
            context.axes.knowledge_holder,
            HistoryAxis::Present(_)
        ));
        assert!(matches!(context.axes.audience, HistoryAxis::Present(_)));
        assert!(matches!(context.axes.timeline, HistoryAxis::Present(_)));
        assert!(matches!(context.axes.worldline, HistoryAxis::Present(_)));
        assert!(matches!(
            context.axes.narrative_layer,
            HistoryAxis::Present(_)
        ));
        assert_eq!(context.send_classification, LOCAL);
        // The default project mode is `auto`; every Scene has a key.
        assert_eq!(
            context.axes.auto,
            HistoryAxis::Present(HistoryAuto {
                setting: HistoryPhaseSetting::Auto,
                axis: HistoryEffectiveAxis::Story,
                fallback: None,
            })
        );

        // storyTime: no key (NULL) and nothing to inherit.
        set_story_keys(&db, &[("a3-source", None), ("nir1", None), (TARGET, None)])?;
        assert_eq!(
            body(&build(&db)?).axes.story_time,
            HistoryAxis::Unavailable(HistoryStoryTimeUnavailable::KeyNotProvided)
        );
        // storyTime: no key of its own, only one inherited from an earlier Scene.
        set_story_keys(&db, &[("a3-source", Some("k-1")), (TARGET, None)])?;
        assert_eq!(
            body(&build(&db)?).axes.story_time,
            HistoryAxis::Unavailable(HistoryStoryTimeUnavailable::InheritedOnly)
        );
        // storyTime: the key repeats in the project (a Chronicle stamp too).
        set_story_keys(&db, &[("a3-source", Some("same")), (TARGET, Some("same"))])?;
        assert_eq!(
            body(&build(&db)?).axes.story_time,
            HistoryAxis::Unavailable(HistoryStoryTimeUnavailable::KeyAmbiguous)
        );

        // viewpoint: NULL.
        set_pov(&db, None)?;
        assert_eq!(
            body(&build(&db)?).axes.viewpoint,
            HistoryAxis::Unavailable(HistoryViewpointUnavailable::NotProvided)
        );
        // viewpoint: hidden, not a character, another project's, or missing.
        sql(
            &db,
            "INSERT INTO codex_entries
                (id, project_id, type, name, summary, context_mode, updated_at)
             VALUES ('pov-hidden', 'default-project', 'character', 'H', 'H', 'hidden',
                     '2026-09-17T00:00:00Z');
             INSERT INTO codex_entries
                (id, project_id, type, name, summary, context_mode, updated_at)
             VALUES ('pov-suppressed', 'default-project', 'character', 'S', 'S', 'suppress',
                     '2026-09-17T00:00:00Z');
             INSERT INTO codex_entries
                (id, project_id, type, name, summary, updated_at)
             VALUES ('pov-place', 'default-project', 'location', 'P', 'P',
                     '2026-09-17T00:00:00Z');",
        )?;
        for character in ["pov-hidden", "pov-suppressed", "pov-place", "pov-missing"] {
            set_pov(&db, Some(character))?;
            assert_eq!(
                body(&build(&db)?).axes.viewpoint,
                HistoryAxis::Unavailable(HistoryViewpointUnavailable::NotVisibleCharacter),
                "{character}"
            );
        }

        // auto: the three project settings and the two fallbacks.
        set_pov(&db, Some("nir1-alice"))?;
        all_keys(&db)?;
        for (mode, setting, axis, fallback) in [
            (
                "reading",
                HistoryPhaseSetting::Reading,
                HistoryEffectiveAxis::Reading,
                None,
            ),
            (
                "story",
                HistoryPhaseSetting::Story,
                HistoryEffectiveAxis::Story,
                None,
            ),
            (
                "auto",
                HistoryPhaseSetting::Auto,
                HistoryEffectiveAxis::Story,
                None,
            ),
        ] {
            set_mode(&db, mode)?;
            assert_eq!(
                body(&build(&db)?).axes.auto,
                HistoryAxis::Present(HistoryAuto {
                    setting,
                    axis,
                    fallback,
                }),
                "{mode}"
            );
        }
        set_mode(&db, "auto")?;
        set_story_keys(&db, &[("nir1", None)])?;
        assert_eq!(
            body(&build(&db)?).axes.auto,
            HistoryAxis::Present(HistoryAuto {
                setting: HistoryPhaseSetting::Auto,
                axis: HistoryEffectiveAxis::Reading,
                fallback: Some(HistoryAutoFallback::AutoIncompleteStoryCoverage),
            })
        );
        set_mode(&db, "story")?;
        set_story_keys(&db, &[("a3-source", None), ("nir1", None), (TARGET, None)])?;
        assert_eq!(
            body(&build(&db)?).axes.auto,
            HistoryAxis::Present(HistoryAuto {
                setting: HistoryPhaseSetting::Story,
                axis: HistoryEffectiveAxis::Reading,
                fallback: Some(HistoryAutoFallback::StoryCurrentUnresolved),
            })
        );
        Ok(())
    }

    fn binding_with(
        marker: NarrativeScopeCompatibilityMarkerV1,
        constraint: NarrativeScopeConstraintV1,
        principal: NarrativeScopePrincipalV1,
    ) -> NarrativeSceneScopeBindingV1 {
        NarrativeSceneScopeBindingV1 {
            schema_version: 1,
            project_id: PROJECT.into(),
            scene_id: TARGET.into(),
            scene_incarnation_id: "incarnation".into(),
            compatibility_marker: marker,
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: constraint.clone(),
                worldline: constraint.clone(),
                narrative_layer: constraint.clone(),
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: constraint.clone(),
                worldline: constraint.clone(),
                narrative_layer: constraint,
            },
            knowledge_holder: principal.clone(),
            audience: principal,
            version: 4,
            source_token: "token-4".into(),
            updated_at: "2026-09-17T00:00:00.000Z".into(),
        }
    }

    fn facts_with(scope: Option<NarrativeSceneScopeBindingV1>) -> Nir1HistoryFacts {
        Nir1HistoryFacts {
            epoch: Some(crate::narrative_extraction::semantic_epoch::CurrentEpoch {
                id: "epoch-id".into(),
                epoch_number: 3,
                reason: "initial".into(),
                created_at: "2026-09-17T00:00:00.000Z".into(),
            }),
            mapping: Some(HistoryMappingFacts {
                reading_order_ref: "reading:a3-future".into(),
                story_time_ref: "story:a3-future".into(),
                reading_rank: 2,
                story: HistoryStoryFact::Resolved {
                    raw_story_key: "k-3".into(),
                },
            }),
            auto: Some(HistoryAutoFacts {
                setting: "auto".into(),
                axis_used: "story".into(),
                fallback_reason: None,
            }),
            scope,
            viewpoint: HistoryViewpointFact::Pov("nir1-alice".into()),
        }
    }

    fn axes_of(facts: &Nir1HistoryFacts) -> HistoryAxes {
        match outcome_from_facts(facts, LOCAL).expect("outcome") {
            HistoryContextOutcome::Context(body) => body.axes,
            other => panic!("expected a context, got {other:?}"),
        }
    }

    #[test]
    fn builder_marks_principal_and_scope_axes_unavailable_without_an_explicit_exact_binding() {
        use NarrativeScopeCompatibilityMarkerV1::{Explicit, LegacyAbsent, Unknown};
        // A binding that is not explicit makes the five binding axes
        // unavailable; the target's token and version are still recorded.
        for marker in [LegacyAbsent, Unknown] {
            let facts = facts_with(Some(binding_with(
                marker,
                NarrativeScopeConstraintV1::Exact {
                    reference: "timeline:main".into(),
                },
                NarrativeScopePrincipalV1::Reader {},
            )));
            let axes = axes_of(&facts);
            assert_eq!(
                axes.knowledge_holder,
                HistoryAxis::Unavailable(HistoryPrincipalUnavailable::BindingNotExplicit)
            );
            assert_eq!(
                axes.audience,
                HistoryAxis::Unavailable(HistoryPrincipalUnavailable::BindingNotExplicit)
            );
            for axis in [&axes.timeline, &axes.worldline, &axes.narrative_layer] {
                assert_eq!(
                    axis,
                    &HistoryAxis::Unavailable(HistoryScopeRefUnavailable::BindingNotExplicit)
                );
            }
            assert!(matches!(
                outcome_from_facts(&facts, LOCAL).expect("outcome"),
                HistoryContextOutcome::Context(body)
                    if body.target.version.get() == 4
            ));
        }
        // An explicit binding with Unresolved, Any or an empty Exact ref.
        for (constraint, expected) in [
            (
                NarrativeScopeConstraintV1::Unresolved {
                    reason: "pending".into(),
                },
                HistoryScopeRefUnavailable::Unresolved,
            ),
            (
                NarrativeScopeConstraintV1::Any,
                HistoryScopeRefUnavailable::Any,
            ),
            (
                NarrativeScopeConstraintV1::Exact {
                    reference: " ".into(),
                },
                HistoryScopeRefUnavailable::Unresolved,
            ),
        ] {
            let axes = axes_of(&facts_with(Some(binding_with(
                Explicit,
                constraint,
                NarrativeScopePrincipalV1::Character {
                    reference: "nir1-alice".into(),
                },
            ))));
            for axis in [&axes.timeline, &axes.worldline, &axes.narrative_layer] {
                assert_eq!(axis, &HistoryAxis::Unavailable(expected));
            }
            assert!(matches!(
                axes.knowledge_holder,
                HistoryAxis::Present(HistoryPrincipal::Character(_))
            ));
        }
        // A character principal with an empty ref is not explicit.
        let axes = axes_of(&facts_with(Some(binding_with(
            Explicit,
            NarrativeScopeConstraintV1::Exact {
                reference: "x".into(),
            },
            NarrativeScopePrincipalV1::Character {
                reference: "".into(),
            },
        ))));
        assert_eq!(
            axes.audience,
            HistoryAxis::Unavailable(HistoryPrincipalUnavailable::BindingNotExplicit)
        );
        // The Scene's binding is unreadable: a slot-level reason.
        assert!(matches!(
            outcome_from_facts(&facts_with(None), LOCAL).expect("outcome"),
            HistoryContextOutcome::Unavailable(HistoryUnavailableReason::SceneScopeUnavailable)
        ));
        // Reader principals are present.
        let axes = axes_of(&facts_with(Some(binding_with(
            Explicit,
            NarrativeScopeConstraintV1::Exact {
                reference: "x".into(),
            },
            NarrativeScopePrincipalV1::Reader {},
        ))));
        assert_eq!(
            axes.knowledge_holder,
            HistoryAxis::Present(HistoryPrincipal::Reader)
        );
    }

    #[test]
    fn builder_rejects_values_outside_the_closed_resolver_cases() {
        let explicit = binding_with(
            NarrativeScopeCompatibilityMarkerV1::Explicit,
            NarrativeScopeConstraintV1::Any,
            NarrativeScopePrincipalV1::Reader {},
        );
        for tamper in [
            |auto: &mut HistoryAutoFacts| auto.setting = "other".into(),
            |auto: &mut HistoryAutoFacts| auto.axis_used = "other".into(),
            |auto: &mut HistoryAutoFacts| auto.fallback_reason = Some("other".into()),
        ] {
            let mut facts = facts_with(Some(explicit.clone()));
            tamper(facts.auto.as_mut().expect("auto"));
            assert!(
                outcome_from_facts(&facts, LOCAL).is_err(),
                "a value outside the closed cases stops the turn instead of being invented"
            );
        }
        // A negative version or epoch number is a slot-level reason.
        let mut facts = facts_with(Some(explicit.clone()));
        facts.scope.as_mut().expect("scope").version = -1;
        assert!(matches!(
            outcome_from_facts(&facts, LOCAL).expect("outcome"),
            HistoryContextOutcome::Unavailable(HistoryUnavailableReason::SceneScopeUnavailable)
        ));
        let mut facts = facts_with(Some(explicit));
        facts.epoch.as_mut().expect("epoch").epoch_number = -1;
        assert!(matches!(
            outcome_from_facts(&facts, LOCAL).expect("outcome"),
            HistoryContextOutcome::Unavailable(HistoryUnavailableReason::RestoreEpochUnavailable)
        ));
    }

    #[test]
    fn builder_marks_axes_unavailable_when_target_scene_is_not_in_the_authority_mapping(
    ) -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        set_pov(&db, Some("nir1-alice"))?;
        // The target's folder is archived: the Scene stays in the project (and
        // keeps its Scope binding) but leaves the live authority's mapping.
        sql(
            &db,
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, sort_order)
             VALUES ('archived-folder', 'default-project', 'folder', 'F', '{}', 'a5');
             UPDATE tree_nodes SET parent_id = 'archived-folder'
              WHERE id = 'a3-future' AND project_id = 'default-project';
             UPDATE tree_nodes SET archived_at = '2026-09-17T00:00:00.000Z'
              WHERE id = 'archived-folder' AND project_id = 'default-project';",
        )?;
        let stage = build(&db)?;
        let context = body(&stage);
        assert_eq!(
            context.axes.reading_order,
            HistoryAxis::Unavailable(HistoryReadingOrderUnavailable::SceneNotInAuthorityMapping)
        );
        assert_eq!(
            context.axes.story_time,
            HistoryAxis::Unavailable(HistoryStoryTimeUnavailable::SceneNotInAuthorityMapping)
        );
        assert_eq!(
            context.axes.auto,
            HistoryAxis::Unavailable(HistoryAutoUnavailable::SceneNotInAuthorityMapping)
        );
        // Nothing outside the closed cases is made up: the axes that do not
        // depend on the mapping keep their own values.
        assert!(matches!(context.axes.viewpoint, HistoryAxis::Present(_)));
        assert!(matches!(context.axes.timeline, HistoryAxis::Present(_)));
        assert!(matches!(
            context.axes.knowledge_holder,
            HistoryAxis::Present(_)
        ));
        // A Scene that is archived itself leaves the mapping the same way.
        let db = base_db()?;
        sql(
            &db,
            "UPDATE tree_nodes SET archived_at = '2026-09-17T00:00:00.000Z'
              WHERE id = 'a3-future' AND project_id = 'default-project';",
        )?;
        let stage = build(&db)?;
        assert_eq!(
            body(&stage).axes.reading_order,
            HistoryAxis::Unavailable(HistoryReadingOrderUnavailable::SceneNotInAuthorityMapping)
        );
        Ok(())
    }

    #[test]
    fn builder_witness_excludes_project_scope_authority_revision_and_story_rank() -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        set_pov(&db, Some("nir1-alice"))?;
        let baseline = canonical_axes(&build(&db)?)?;

        // A Scene after the target and another Scene's story key change the
        // project's scope authority revision and the target's story rank, but
        // not the target's own values.
        sql(
            &db,
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, sort_order, story_time_order)
             VALUES ('after-target', 'default-project', 'scene', 'After', '{}', 'z9', 'k-0');",
        )?;
        db.with_conn(|conn| {
            crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                conn,
                PROJECT,
                "after-target",
                "2026-09-17T00:00:00.000Z",
            )
        })?;
        set_story_keys(&db, &[("a3-source", Some("k-0a"))])?;
        assert_eq!(canonical_axes(&build(&db)?)?, baseline);

        // A Scene before the target moves its reading rank and nothing else.
        let before = {
            let stage = build(&db)?;
            body(&stage).axes.clone()
        };
        sql(
            &db,
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, sort_order, story_time_order)
             VALUES ('before-target', 'default-project', 'scene', 'Before', '{}', '0', 'k-00');",
        )?;
        db.with_conn(|conn| {
            crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                conn,
                PROJECT,
                "before-target",
                "2026-09-17T00:00:00.000Z",
            )
        })?;
        let moved = {
            let stage = build(&db)?;
            body(&stage).axes.clone()
        };
        assert_ne!(moved.reading_order, before.reading_order);
        assert_eq!(
            HistoryAxes {
                reading_order: before.reading_order.clone(),
                ..moved
            },
            before
        );
        Ok(())
    }

    fn canonical_axes(stage: &HistoryContextStage) -> Result<String> {
        let axes = serde_json::to_value(&body(stage).axes)?;
        grimodex_core::canonical_json_string(&axes).map_err(Into::into)
    }

    #[test]
    fn builder_records_restore_epoch_and_target_scope_token() -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        let stage = build(&db)?;
        let context = body(&stage);
        let (epoch, scope) = db.with_read_transaction(|conn| {
            Ok((
                crate::narrative_extraction::semantic_epoch::get_current_epoch(conn, PROJECT)?
                    .expect("epoch"),
                crate::narrative_extraction::read_narrative_scene_scope(conn, PROJECT, TARGET)?,
            ))
        })?;
        assert_eq!(
            context.restore_epoch,
            HistoryRestoreEpoch {
                id_digest: HistoryDigest::of(HistoryDigestDomain::RestoreEpochId, &epoch.id)?,
                number: HistoryInt::from_i64(epoch.epoch_number)?,
            }
        );
        assert_eq!(
            context.target,
            HistoryTargetScope {
                binding_token_digest: HistoryDigest::of(
                    HistoryDigestDomain::ScopeBindingToken,
                    &scope.binding.source_token
                )?,
                version: HistoryInt::from_i64(scope.binding.version)?,
            }
        );
        // The create/claim re-read (DI-1c) compares the two values this
        // context records, read by one reader: the same digests and numbers.
        let expected = db.with_read_transaction(|conn| {
            crate::nir1_generation::read_expected_scope_in_tx(conn, PROJECT, TARGET)
        })?;
        let scope_state = expected.scope_binding.expect("scope binding");
        assert_eq!(
            scope_state.token_digest,
            context.target.binding_token_digest
        );
        assert_eq!(
            HistoryInt::from_i64(scope_state.version)?,
            context.target.version
        );
        let epoch_state = expected.restore_epoch.expect("restore epoch");
        assert_eq!(epoch_state.id_digest, context.restore_epoch.id_digest);
        assert_eq!(
            HistoryInt::from_i64(epoch_state.number)?,
            context.restore_epoch.number
        );
        // No epoch: a closed slot reason, not a stopped turn.
        sql(
            &db,
            "PRAGMA foreign_keys = OFF; DELETE FROM narrative_semantic_epochs;
             PRAGMA foreign_keys = ON;",
        )?;
        assert_eq!(
            reason(&build(&db)?),
            HistoryUnavailableReason::RestoreEpochUnavailable
        );
        assert_eq!(
            db.with_read_transaction(|conn| {
                crate::nir1_generation::read_expected_scope_in_tx(conn, PROJECT, TARGET)
            })?
            .restore_epoch,
            None
        );
        // No Scope binding row: a closed slot reason.
        let db = base_db()?;
        sql(
            &db,
            "DELETE FROM narrative_scene_scope_bindings WHERE scene_id = 'a3-future';",
        )?;
        assert_eq!(
            reason(&build(&db)?),
            HistoryUnavailableReason::SceneScopeUnavailable
        );
        Ok(())
    }

    #[test]
    fn builder_reads_nothing_without_a_durable_identity() -> Result<()> {
        // The identity check comes first: with no identity the builder does
        // not touch the database (an autocommit connection would be refused
        // by every reader, and it is not even asked).
        let db = base_db()?;
        let stage =
            db.with_conn(|conn| build_history_context_stage(conn, PROJECT, TARGET, None, LOCAL))?;
        assert_eq!(
            reason(&stage),
            HistoryUnavailableReason::WorkspaceIdentityUnavailable
        );
        assert_eq!(stage.durable_workspace_identity, None);
        Ok(())
    }

    #[test]
    fn builder_runs_inside_the_d_final_snapshot_and_does_not_add_sql_outside_it() -> Result<()> {
        // It takes the caller's connection and refuses one that is not inside
        // a read transaction: it never opens a connection or a transaction.
        let db = base_db()?;
        let error = db
            .with_conn(|conn| {
                build_history_context_stage(conn, PROJECT, TARGET, Some(&sample_identity()), LOCAL)
            })
            .expect_err("an autocommit connection is refused");
        assert!(
            error
                .to_string()
                .contains("NIR1_ENTITY_RELATION_A3_REQUIRES_READ_TRANSACTION"),
            "{error}"
        );
        Ok(())
    }

    #[test]
    fn builder_propagates_untyped_read_errors_and_types_unavailability() -> Result<()> {
        // A typed absence is a closed slot reason (see the epoch and Scope
        // tests). A SQLite error is not: the turn stops.
        let db = base_db()?;
        sql(
            &db,
            "ALTER TABLE narrative_semantic_epochs RENAME TO narrative_semantic_epochs_gone;",
        )?;
        let error = build(&db).expect_err("a missing table is an error");
        assert!(
            error.downcast_ref::<rusqlite::Error>().is_some(),
            "{error:#}"
        );
        // The same for the codex table the viewpoint reader joins.
        let db = base_db()?;
        set_pov(&db, Some("nir1-alice"))?;
        sql(
            &db,
            "ALTER TABLE codex_entries RENAME TO codex_entries_gone;",
        )?;
        assert!(build(&db).is_err());
        Ok(())
    }

    fn selection(inputs: &[InputReference], estimator: &str) -> (D1SelectionParameters, String) {
        let parameters = D1SelectionParameters {
            estimator_version: estimator.to_owned(),
            selector_budget_tokens: 1_000,
            used_tokens: 400,
            remaining_tokens: 600,
        };
        let digest = d1_selection_digest(&parameters, inputs).expect("digest");
        (parameters, digest)
    }

    fn inputs() -> Vec<InputReference> {
        vec![
            InputReference {
                role: InputRole::User,
                target: InputTarget::Message {
                    version_id: "v-1".into(),
                    parent_attempt_id: None,
                },
                input_use: InputUse::CurrentTurn,
            },
            InputReference {
                role: InputRole::Context,
                target: InputTarget::RawSource {
                    source_key: "project:scene:a3-future".into(),
                    revision_token: "v1@t".into(),
                },
                input_use: InputUse::SelectedMaterial,
            },
        ]
    }

    #[test]
    fn finish_adds_the_d1_fields_and_maps_every_failure_to_the_closed_reasons() -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        let stage = build(&db)?;
        let inputs = inputs();
        let (parameters, digest) = selection(&inputs, "nir1-context-estimator-v1");
        let identity = Some(sample_identity());

        let draft = finish_history_draft(&stage, true, &parameters, &digest, &inputs);
        assert_eq!(draft.durable_workspace_identity, identity);
        let HistoryContextSlot::Context(context) = draft.slot else {
            panic!("a complete output records a context");
        };
        assert_eq!(context.eligible_until_ms, HistoryInt::new(0)?);
        assert_eq!(context.d1.selection_digest.as_str(), digest);
        assert_eq!(context.d1.used_tokens.get(), 400);
        assert_eq!(&context.axes, &body(&stage).axes);

        // The completeness check failed: d-final-incomplete, identity kept.
        let incomplete = finish_history_draft(&stage, false, &parameters, &digest, &inputs);
        assert_eq!(
            incomplete.slot,
            HistoryContextSlot::Unavailable(HistoryUnavailableReason::DFinalIncomplete)
        );
        assert_eq!(incomplete.durable_workspace_identity, identity);
        // D1 fields that do not recompute the digest, or an estimator this
        // build does not know.
        let wrong = finish_history_draft(&stage, true, &parameters, "sha256:00", &inputs);
        assert_eq!(
            wrong.slot,
            HistoryContextSlot::Unavailable(HistoryUnavailableReason::DFinalIncomplete)
        );
        let (unknown, unknown_digest) = selection(&inputs, "estimator-from-the-future");
        let unknown = finish_history_draft(&stage, true, &unknown, &unknown_digest, &inputs);
        assert_eq!(
            unknown.slot,
            HistoryContextSlot::Unavailable(HistoryUnavailableReason::DFinalIncomplete)
        );
        // An already unavailable stage keeps its reason.
        let no_epoch = HistoryContextStage::unavailable(
            HistoryUnavailableReason::RestoreEpochUnavailable,
            identity.clone(),
        );
        assert_eq!(
            finish_history_draft(&no_epoch, true, &parameters, &digest, &inputs).slot,
            HistoryContextSlot::Unavailable(HistoryUnavailableReason::RestoreEpochUnavailable)
        );
        // ...unless the output is incomplete, which wins.
        assert_eq!(
            finish_history_draft(&no_epoch, false, &parameters, &digest, &inputs).slot,
            HistoryContextSlot::Unavailable(HistoryUnavailableReason::DFinalIncomplete)
        );
        // The D1 reference of an adopted input is built from the same digest
        // (the storage side recomputes it from the stored rows).
        let reference = d1_selection_reference(1, &digest);
        assert_eq!(reference.kind, QualificationKind::D1);
        Ok(())
    }

    // ---- HC1-2: the current turn's context is the builder's value ----

    use crate::nir1_generation::history_context::HISTORY_ELIGIBILITY_WINDOW_MS;
    use crate::nir1_generation_history::{
        compare_context, ContextMismatch, CurrentContextUnavailable, HistoryAxisName,
        RecordedHistoryContext,
    };

    fn range() -> HistoryRange {
        HistoryRange {
            project_id: PROJECT.into(),
            chat_session_id: "chat-session".into(),
            scene_id: TARGET.into(),
            scene_incarnation_id: "incarnation".into(),
        }
    }

    fn current_of(stage: &HistoryContextStage) -> CurrentHistoryContext {
        stage.current_history_context(range(), GenerationPurpose::Writing)
    }

    /// The context an attempt created at `created_at_ms` would record from
    /// this stage: the finished draft's context and the stage's durable
    /// identity, read back the way the history reader reads a stored binding.
    fn recorded_of(stage: &HistoryContextStage, created_at_ms: i64) -> RecordedHistoryContext {
        let inputs = inputs();
        let (parameters, digest) = selection(&inputs, "nir1-context-estimator-v1");
        let draft = finish_history_draft(stage, true, &parameters, &digest, &inputs);
        let HistoryContextSlot::Context(recorded_slot) = draft.slot else {
            panic!("a complete output records a context");
        };
        let CurrentHistoryContext::Known(mut comparison) = current_of(stage) else {
            panic!("a context stage is known");
        };
        comparison.durable_identity = draft.durable_workspace_identity;
        RecordedHistoryContext {
            context: *comparison,
            created_at_ms,
            // The storage writer sets `eligibleUntilMs` from the row.
            eligible_until_ms: (created_at_ms + HISTORY_ELIGIBILITY_WINDOW_MS) as u64,
            d1: recorded_slot.d1,
        }
    }

    #[test]
    fn current_context_is_the_value_the_builder_made_in_the_snapshot() -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        set_pov(&db, Some("nir1-alice"))?;
        let stage = build(&db)?;
        let CurrentHistoryContext::Known(current) = current_of(&stage) else {
            panic!("a context stage is known");
        };
        // The same body, the same durable identity: no second derivation.
        let context = body(&stage);
        assert_eq!(current.axes, context.axes);
        assert_eq!(current.target, context.target);
        assert_eq!(current.restore_epoch, context.restore_epoch);
        assert_eq!(current.send_classification, context.send_classification);
        assert_eq!(current.durable_identity, Some(sample_identity()));
        assert_eq!(current.range, range());
        assert_eq!(current.purpose, GenerationPurpose::Writing);
        // Every compared value is present, so history can be used.
        let current = current_of(&stage);
        assert!(current.available().is_ok());

        // A recorded context from the same snapshot matches the same turn.
        let recorded = recorded_of(&stage, 100);
        let known = current.available().expect("available");
        assert_eq!(compare_context(known, &recorded, 200), Ok(()));
        Ok(())
    }

    #[test]
    fn a_change_after_recording_is_reported_on_its_own_item() -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        set_pov(&db, Some("nir1-alice"))?;
        let recorded = recorded_of(&build(&db)?, 100);

        let compare = |db: &Database| -> Result<Result<(), ContextMismatch>> {
            let current = current_of(&build(db)?);
            let known = current.available().expect("available").clone();
            Ok(compare_context(&known, &recorded, 200))
        };
        assert_eq!(compare(&db)?, Ok(()));
        // The Scene's own story key.
        set_story_keys(&db, &[(TARGET, Some("k-3-moved"))])?;
        assert_eq!(
            compare(&db)?,
            Err(ContextMismatch::AxisChanged(HistoryAxisName::StoryTime))
        );
        set_story_keys(&db, &[(TARGET, Some("k-3"))])?;
        assert_eq!(compare(&db)?, Ok(()), "a non-monotone value that returns");
        // The point of view.
        set_pov(&db, Some("nir1-bob"))?;
        assert_eq!(
            compare(&db)?,
            Err(ContextMismatch::AxisChanged(HistoryAxisName::Viewpoint))
        );
        // The project's phase setting changes the effective axis.
        set_pov(&db, Some("nir1-alice"))?;
        set_mode(&db, "reading")?;
        assert_eq!(
            compare(&db)?,
            Err(ContextMismatch::AxisChanged(HistoryAxisName::Auto))
        );
        Ok(())
    }

    #[test]
    fn an_unavailable_current_axis_makes_the_current_context_unavailable() -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        set_pov(&db, Some("nir1-alice"))?;
        // viewpoint: no POV.
        set_pov(&db, None)?;
        assert_eq!(
            current_of(&build(&db)?).available().unwrap_err(),
            CurrentContextUnavailable::Axis(HistoryAxisName::Viewpoint)
        );
        // storyTime: the key repeats in the project.
        set_pov(&db, Some("nir1-alice"))?;
        set_story_keys(&db, &[("a3-source", Some("k-3"))])?;
        assert_eq!(
            current_of(&build(&db)?).available().unwrap_err(),
            CurrentContextUnavailable::Axis(HistoryAxisName::StoryTime)
        );
        // The builder had no context at all: no Scope binding row.
        let db = base_db()?;
        sql(
            &db,
            "DELETE FROM narrative_scene_scope_bindings WHERE scene_id = 'a3-future';",
        )?;
        assert_eq!(
            current_of(&build(&db)?).available().unwrap_err(),
            CurrentContextUnavailable::Turn(HistoryUnavailableReason::SceneScopeUnavailable)
        );
        // No durable identity: the builder read nothing.
        let db = base_db()?;
        let stage = db.with_read_transaction(|conn| {
            build_history_context_stage(conn, PROJECT, TARGET, None, LOCAL)
        })?;
        assert_eq!(
            current_of(&stage).available().unwrap_err(),
            CurrentContextUnavailable::Turn(HistoryUnavailableReason::WorkspaceIdentityUnavailable)
        );
        Ok(())
    }

    #[test]
    fn an_archived_ancestor_folder_makes_reading_story_and_auto_unavailable() -> Result<()> {
        let db = base_db()?;
        all_keys(&db)?;
        set_pov(&db, Some("nir1-alice"))?;
        sql(
            &db,
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
             VALUES ('chapter', 'default-project', 'folder', 'Chapter', 'a9');
             UPDATE tree_nodes SET parent_id = 'chapter'
              WHERE id = 'a3-future' AND project_id = 'default-project';
             UPDATE tree_nodes SET archived_at = '2026-10-01T00:00:00Z'
              WHERE id = 'chapter' AND project_id = 'default-project';",
        )?;
        let stage = build(&db)?;
        let context = body(&stage);
        assert_eq!(
            context.axes.reading_order,
            HistoryAxis::Unavailable(HistoryReadingOrderUnavailable::SceneNotInAuthorityMapping)
        );
        assert_eq!(
            context.axes.story_time,
            HistoryAxis::Unavailable(HistoryStoryTimeUnavailable::SceneNotInAuthorityMapping)
        );
        assert_eq!(
            context.axes.auto,
            HistoryAxis::Unavailable(HistoryAutoUnavailable::SceneNotInAuthorityMapping)
        );
        // The first unavailable axis in the compared order is reported, and
        // history is unusable in this turn.
        let current = current_of(&stage);
        assert_eq!(
            current.available().unwrap_err(),
            CurrentContextUnavailable::Axis(HistoryAxisName::ReadingOrder)
        );
        // Unarchived, the axes are available again.
        sql(
            &db,
            "UPDATE tree_nodes SET archived_at = NULL WHERE id = 'chapter';",
        )?;
        let back = current_of(&build(&db)?);
        assert!(back.available().is_ok());
        Ok(())
    }
}
