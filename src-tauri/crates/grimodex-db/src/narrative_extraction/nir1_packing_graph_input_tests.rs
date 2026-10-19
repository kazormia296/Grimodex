//! DI-1a S2: the Graph-derived inputs of a D-final request (K4/3 section 3,
//! K6/2 DI-1a). Acceptance IDs in the comments refer to the DI-1a TASK:
//! A-15 (a Graph-derived attempt stays Pending in history), A-18 (the
//! completeness rule and the typed N/A table), A-19 (the Index reference).
//!
//! The Graph candidates are made from the bindings a control request read, the
//! way the worker's Graph records them. B's seal rows are written directly, as
//! the S1 tests do.

use super::tests::di1a_graph::{candidates_from, write_seal, GENERATION};
use super::tests::{DfFinalFixture, RAW_SOURCE_PROJECT};
use super::*;
use crate::narrative_extraction::{
    graph_evidence_ref, graph_index_reference, Nir1GraphCandidates, GRAPH_EVIDENCE_REF_FORM,
    GRAPH_INDEX_REF_FORM,
};
use crate::nir1_generation::CompletenessReason;
use rusqlite::params;

struct GraphRequest {
    fixture: DfFinalFixture,
    control: NativeNir1SelectedInputs,
    candidates: Nir1GraphCandidates,
    selected: NativeNir1SelectedInputs,
}

fn graph_request() -> Result<GraphRequest> {
    let fixture = DfFinalFixture::new()?;
    write_seal(fixture.snapshot.db().db(), GENERATION, false)?;
    let control = fixture.select()?;
    let hops = vec![0u8; control.prepared().authority_bindings().len()];
    let candidates = candidates_from(control.prepared().authority_bindings(), &hops)?;
    let selected = fixture.select_graph(Some(&candidates), |_| Ok(100_000))?;
    Ok(GraphRequest {
        fixture,
        control,
        candidates,
        selected,
    })
}

fn graph_ordinals(prepared: &NativeNir1PreparedInputs) -> Vec<usize> {
    prepared
        .input_references()
        .iter()
        .enumerate()
        .filter(|(_, input)| matches!(input.target, InputTarget::GraphEvidence { .. }))
        .map(|(ordinal, _)| ordinal)
        .collect()
}

fn rows_for(
    qualifications: &[QualificationReference],
    ordinal: usize,
    kind: QualificationKind,
) -> Vec<&QualificationReference> {
    qualifications
        .iter()
        .filter(|row| row.input_ordinal == ordinal && row.kind == kind)
        .collect()
}

fn binding_of<'a>(
    prepared: &'a NativeNir1PreparedInputs,
    revision_id: &str,
) -> &'a NativeNir1AuthorityBinding {
    prepared
        .authority_bindings()
        .iter()
        .find(|binding| binding.revision_id() == revision_id)
        .expect("the Revision of a Graph input is bound")
}

fn violation_of(
    prepared: &NativeNir1PreparedInputs,
    rows: &[QualificationReference],
) -> CompletenessViolation {
    prepared
        .check_completeness(rows)
        .expect_err("the rows must break the completeness rule")
}

#[test]
fn graph_groups_become_graph_derived_inputs_with_complete_references() -> Result<()> {
    let request = graph_request()?;
    let prepared = request.selected.prepared();
    let control = request.control.prepared();
    let outcome = prepared.graph_outcome().expect("a Graph outcome");
    assert_eq!(outcome.dropped_reason(), None);
    assert!(
        !outcome.groups().is_empty(),
        "the Graph reached the request"
    );

    // The Graph-less control has no Graph-derived input and no Index row.
    assert!(graph_ordinals(control).is_empty());
    assert!(control.graph_binding().is_none());
    assert!(control.qualifications().iter().all(|row| {
        row.kind != QualificationKind::Index
            || matches!(
                row.body,
                QualificationBody::NotApplicable {
                    reason: NotApplicableReason::NotIndexDerived
                }
            )
    }));

    // One Graph-derived input per admitted group, each a selected material.
    let ordinals = graph_ordinals(prepared);
    assert_eq!(ordinals.len(), outcome.groups().len());
    let graph = prepared.graph_binding().expect("a Graph binding");
    assert_eq!(graph.inputs().len(), ordinals.len());
    // A Graph group takes the place of its accepted IR group: the item count
    // does not grow.
    assert_eq!(
        prepared.context_items().len(),
        control.context_items().len()
    );
    let final_rows = prepared.finalize_qualifications(100_000)?;
    for (adopted, ordinal) in graph.inputs().iter().zip(&ordinals) {
        assert_eq!(adopted.input_ordinal(), *ordinal);
        let input = &prepared.input_references()[*ordinal];
        assert_eq!(input.role, InputRole::Context);
        assert_eq!(input.input_use, InputUse::SelectedMaterial);
        let InputTarget::GraphEvidence {
            evidence_ref,
            source_key,
            revision_token,
        } = &input.target
        else {
            unreachable!("filtered above");
        };
        assert_eq!(
            evidence_ref,
            &graph_evidence_ref(adopted.revision_id(), adopted.edge_id())?
        );
        // The input's own Source is the first of the relation's Evidence
        // Sources in (key, token) order, and it is one of the Source rows.
        let binding = binding_of(prepared, adopted.revision_id());
        let (expected_key, expected_token) = graph_input_source(binding, adopted.edge_id())?;
        assert_eq!(
            (source_key, revision_token),
            (&expected_key, &expected_token)
        );
        let sources = rows_for(
            &final_rows.qualifications,
            *ordinal,
            QualificationKind::Source,
        );
        assert!(sources.iter().any(|row| {
            row.identity() == Some(source_key.as_str())
                && row.version() == Some(revision_token.as_str())
        }));
        // One Revision, one Decision, one Freshness row; the Index is a
        // reference, never a typed N/A.
        for kind in [
            QualificationKind::Revision,
            QualificationKind::Decision,
            QualificationKind::Freshness,
            QualificationKind::Index,
            QualificationKind::D1,
        ] {
            let rows = rows_for(&final_rows.qualifications, *ordinal, kind);
            assert_eq!(rows.len(), 1, "{kind:?} of the Graph input {ordinal}");
            assert!(rows[0].identity().is_some(), "{kind:?} is a reference");
        }
        let index = rows_for(
            &final_rows.qualifications,
            *ordinal,
            QualificationKind::Index,
        )[0];
        let (identity, version) = graph_index_reference(
            prepared.project_id(),
            graph.seal(),
            binding,
            adopted.edge_id(),
        )?;
        assert_eq!(index.identity(), Some(identity.as_str()));
        assert_eq!(index.version(), Some(version.as_str()));
        assert_eq!(adopted.index_identity(), identity);
        assert_eq!(adopted.index_version(), version);
        // Five parts of one group share the ordinal.
        let parts = prepared
            .context_items()
            .iter()
            .filter(|item| item.input_ordinal() == *ordinal)
            .count();
        assert_eq!(parts, NATIVE_ATOMIC_PART_COUNT);
        assert!(
            prepared
                .context_items()
                .iter()
                .filter(|item| item.input_ordinal() == *ordinal)
                .all(|item| !item.text().contains('\n')),
            "a Graph item holds no renderer separator"
        );
    }
    // The finished rows satisfy the rule and the expected `(kind, target)` set.
    prepared
        .check_completeness(&final_rows.qualifications)
        .map_err(|violation| anyhow::anyhow!("{violation}"))?;
    let draft = prepared.history_draft(&final_rows);
    assert!(
        matches!(
            draft.slot,
            crate::nir1_generation::history_context::HistoryContextSlot::Context(_)
        ),
        "a complete Graph request keeps its history slot"
    );
    // The Revisions of the Graph groups are bound: their authority is
    // requalified on return and before dispatch.
    for adopted in graph.inputs() {
        assert!(prepared
            .authority_bindings()
            .iter()
            .any(|binding| binding.revision_id() == adopted.revision_id()));
    }
    Ok(())
}

/// A-18: a Graph-derived input is complete only with an Index reference, and
/// no kind accepts a typed N/A; a dropped or reduced reference is detected
/// against the expected set derived from the bindings.
#[test]
fn a_graph_derived_input_needs_its_index_reference_and_allows_no_not_applicable() -> Result<()> {
    let request = graph_request()?;
    let prepared = request.selected.prepared();
    let ordinal = *graph_ordinals(prepared).first().expect("a Graph input");
    let complete = prepared.finalize_qualifications(100_000)?.qualifications;
    prepared
        .check_completeness(&complete)
        .map_err(|violation| anyhow::anyhow!("{violation}"))?;

    let without = |rows: &[QualificationReference], kind: QualificationKind| {
        rows.iter()
            .filter(|row| !(row.input_ordinal == ordinal && row.kind == kind))
            .cloned()
            .collect::<Vec<_>>()
    };

    // No Index row at all.
    let missing = violation_of(prepared, &without(&complete, QualificationKind::Index));
    assert_eq!(missing.reason, CompletenessReason::MissingKind);
    assert_eq!(missing.kind, Some(QualificationKind::Index));
    assert_eq!(missing.input_ordinal, Some(ordinal));

    // The Index as a typed N/A.
    let mut na = without(&complete, QualificationKind::Index);
    na.push(QualificationReference::not_applicable(
        ordinal,
        QualificationKind::Index,
        NotApplicableReason::NotIndexDerived,
    ));
    let violation = violation_of(prepared, &na);
    assert_eq!(
        violation.reason,
        CompletenessReason::NotApplicableNotInTable
    );
    assert_eq!(violation.kind, Some(QualificationKind::Index));

    // The Index reference and a typed N/A together.
    let mut both = complete.clone();
    both.push(QualificationReference::not_applicable(
        ordinal,
        QualificationKind::Index,
        NotApplicableReason::NotIndexDerived,
    ));
    let violation = violation_of(prepared, &both);
    assert_eq!(
        violation.reason,
        CompletenessReason::ReferenceAndNotApplicable
    );
    assert_eq!(violation.kind, Some(QualificationKind::Index));

    // No kind of a Graph-derived input accepts a typed N/A in place of its
    // references (the table fills every cell with a reference).
    for (kind, reason) in [
        (
            QualificationKind::Source,
            NotApplicableReason::ExactSourceToken,
        ),
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
        let mut rows = without(&complete, kind);
        rows.push(QualificationReference::not_applicable(
            ordinal, kind, reason,
        ));
        let violation = violation_of(prepared, &rows);
        assert_eq!(
            (violation.kind, violation.reason),
            (Some(kind), CompletenessReason::NotApplicableNotInTable),
            "{kind:?}"
        );
    }
    let mut scope_na = without(&complete, QualificationKind::Scope);
    scope_na.push(QualificationReference::not_applicable(
        ordinal,
        QualificationKind::Scope,
        NotApplicableReason::NotARevision,
    ));
    let violation = violation_of(prepared, &scope_na);
    assert_eq!(violation.kind, Some(QualificationKind::Scope));
    assert_eq!(
        violation.reason,
        CompletenessReason::NotApplicableNotInTable
    );

    // A reduced Source set: every Source but the first is dropped. The
    // expected set (derived from the Revision's material basis, not from the
    // rows) names the others.
    let sources = rows_for(&complete, ordinal, QualificationKind::Source)
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        sources.len() >= 2,
        "the fixture Revision has several Sources"
    );
    let mut reduced = without(&complete, QualificationKind::Source);
    reduced.push(sources[0].clone());
    let violation = violation_of(prepared, &reduced);
    assert_eq!(violation.reason, CompletenessReason::ExpectedTargetMissing);
    assert_eq!(violation.kind, Some(QualificationKind::Source));

    // An Index reference to another Index: the expected identity names the
    // sealed Index of this request.
    let mut wrong_index = without(&complete, QualificationKind::Index);
    wrong_index.push(QualificationReference::present(
        ordinal,
        QualificationKind::Index,
        "sha256:not-the-sealed-index",
        "sha256:version",
    ));
    let violation = violation_of(prepared, &wrong_index);
    assert_eq!(violation.kind, Some(QualificationKind::Index));
    assert!(matches!(
        violation.reason,
        CompletenessReason::ExpectedTargetMissing | CompletenessReason::UnexpectedTarget
    ));

    // The expected set follows the Graph binding: for the same inputs, a
    // request that adopted no Graph cannot derive it.
    assert!(expected_targets_for_inputs(
        prepared.project_id(),
        prepared.query_scene_id(),
        prepared.input_references(),
        &prepared.authority_bindings().iter().collect::<Vec<_>>(),
        None,
    )
    .is_err());
    // And the D-final output of the control request, which has no Graph
    // input, is still complete.
    let control = request.control.prepared();
    let rows = control.finalize_qualifications(100_000)?;
    control
        .check_completeness(&rows.qualifications)
        .map_err(|violation| anyhow::anyhow!("{violation}"))?;
    Ok(())
}

/// A-19: the Index reference is versioned, derived from the seal and the
/// binding only, and changes with each of them.
#[test]
fn the_index_reference_is_versioned_and_follows_the_seal_and_the_edge() -> Result<()> {
    let first = graph_request()?;
    assert_eq!(GRAPH_INDEX_REF_FORM, "nir1-graph-index-ref@1");
    assert_eq!(GRAPH_EVIDENCE_REF_FORM, "nir1-graph-evidence-ref@1");
    let prepared = first.selected.prepared();
    let graph = prepared.graph_binding().expect("a Graph binding");
    let adopted = &graph.inputs()[0];
    assert!(adopted.index_identity().starts_with("sha256:"));
    assert!(adopted.index_version().starts_with("sha256:"));
    assert_ne!(adopted.index_identity(), adopted.index_version());

    let binding = binding_of(prepared, adopted.revision_id());
    let project = prepared.project_id();
    let seal = graph.seal();
    let base = graph_index_reference(project, seal, binding, adopted.edge_id())?;
    assert_eq!(
        base,
        graph_index_reference(project, seal, binding, adopted.edge_id())?
    );
    assert_eq!(
        (adopted.index_identity(), adopted.index_version()),
        (base.0.as_str(), base.1.as_str())
    );

    // A generation changes the identity and the version; another seal digest,
    // dependency digest or epoch changes the version only.
    let mut other = seal.clone();
    other.generation += 1;
    let moved = graph_index_reference(project, &other, binding, adopted.edge_id())?;
    assert_ne!(moved.0, base.0);
    assert_ne!(moved.1, base.1);
    for change in [
        |seal: &mut crate::narrative_extraction::Nir1GraphSealRead| {
            seal.source_digest.push_str("-other")
        },
        |seal: &mut crate::narrative_extraction::Nir1GraphSealRead| {
            seal.dependency_set_digest.push_str("-other")
        },
        |seal: &mut crate::narrative_extraction::Nir1GraphSealRead| {
            seal.semantic_epoch_id.push_str("-other")
        },
    ] {
        let mut other = seal.clone();
        change(&mut other);
        let changed = graph_index_reference(project, &other, binding, adopted.edge_id())?;
        assert_eq!(changed.0, base.0, "the identity names the generation only");
        assert_ne!(changed.1, base.1);
    }
    // Another edge, and another project.
    let edge = graph_index_reference(project, seal, binding, "another-edge")?;
    assert_eq!(edge.0, base.0);
    assert_ne!(edge.1, base.1);
    let other_project = graph_index_reference("another-project", seal, binding, adopted.edge_id())?;
    assert_ne!(other_project.0, base.0);
    assert_ne!(other_project.1, base.1);
    // The evidence reference separates the Revision and the edge by field.
    assert_ne!(
        graph_evidence_ref("a:relation:b", "c")?,
        graph_evidence_ref("a", "b:relation:c")?
    );

    // A real rebuild: B sealed again at the next generation gives a new
    // reference for the same relation.
    let fixture = &first.fixture;
    write_seal(fixture.snapshot.db().db(), GENERATION + 1, false)?;
    let next_candidates = Nir1GraphCandidates::new(
        first.candidates.project_id().to_owned(),
        first.candidates.query_scene_id().to_owned(),
        first.candidates.seed_entity_id().to_owned(),
        GENERATION + 1,
        first.candidates.scope_revision().map(str::to_owned),
        first.candidates.edges().to_vec(),
    )?;
    let rebuilt = fixture.select_graph(Some(&next_candidates), |_| Ok(100_000))?;
    let rebuilt_graph = rebuilt.prepared().graph_binding().expect("a Graph binding");
    let same_group = rebuilt_graph
        .inputs()
        .iter()
        .find(|input| input.group_id() == adopted.group_id())
        .expect("the same relation");
    assert_ne!(same_group.index_identity(), adopted.index_identity());
    assert_ne!(same_group.index_version(), adopted.index_version());
    Ok(())
}

/// The Graph-derived input is requalified on return: B's seal, the
/// Revision's authority and the Index reference are read again.
#[test]
fn revalidation_requalifies_the_graph_inputs_against_the_seal() -> Result<()> {
    let request = graph_request()?;
    let prepared = request.selected.prepared();
    let revalidate = |prepared: &NativeNir1PreparedInputs| {
        revalidate_native_nir1_prepared_inputs(
            &request.fixture.snapshot,
            prepared.chat_session_id(),
            prepared,
            super::tests::prepared_sql_budget(),
        )
    };
    revalidate(prepared)?;

    let stale = |error: anyhow::Error| error.to_string();
    // B is rebuilt: a new generation.
    write_seal(request.fixture.snapshot.db().db(), GENERATION + 1, false)?;
    assert_eq!(
        stale(revalidate(prepared).unwrap_err()),
        "NIR1_NATIVE_PREPARED_GRAPH_STALE"
    );
    // B is dirty.
    write_seal(request.fixture.snapshot.db().db(), GENERATION, true)?;
    assert_eq!(
        stale(revalidate(prepared).unwrap_err()),
        "NIR1_NATIVE_PREPARED_GRAPH_STALE"
    );
    // The seal digests change under the same generation.
    write_seal(request.fixture.snapshot.db().db(), GENERATION, false)?;
    revalidate(prepared)?;
    request.fixture.sql(
        "UPDATE narrative_semantic_index_metadata SET source_digest='sha256:another'
          WHERE project_id=?1",
        params![RAW_SOURCE_PROJECT],
    )?;
    assert_eq!(
        stale(revalidate(prepared).unwrap_err()),
        "NIR1_NATIVE_PREPARED_GRAPH_STALE"
    );
    Ok(())
}

/// A Revision whose material basis disagrees with itself is left out as a
/// Graph-derived input too, with the same closed reason, while the other
/// Revision's Graph groups and the request stay.
#[test]
fn a_material_basis_conflict_leaves_the_graph_inputs_of_that_revision_out() -> Result<()> {
    let request = graph_request()?;
    let prepared = request.selected.prepared();
    let graph = prepared.graph_binding().expect("a Graph binding");
    let revisions = graph
        .inputs()
        .iter()
        .map(|input| input.revision_id().to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(revisions.len() >= 2, "the Graph reaches both Revisions");
    let target = revisions.iter().next().expect("a Revision").clone();
    let kept = revisions.iter().nth(1).expect("another Revision").clone();

    let mut input_budget = NativePackingInputBudget::default();
    let fixture = &request.fixture;
    let (conflicted, expected_groups) = fixture
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            fixture.snapshot.participant(),
            super::tests::prepared_sql_budget(),
            |conn| {
                let (version, message) = read_current_chat_input_capture_in_tx(
                    conn,
                    &fixture.capture,
                    fixture.capture.owner(),
                    |version_id_bytes, body_bytes| {
                        input_budget.reserve_lengths(version_id_bytes, body_bytes, 0)
                    },
                )?;
                let project_id = version.project_id.clone();
                let listed =
                    list_native_revision_candidates_in_tx(conn, &project_id, &mut || Ok(()))?;
                let mut pooled =
                    read_and_pack_native_a2_context_with_current_source_and_policy_in_tx(
                        conn,
                        NativeNir1SourcePooledPackingRequest {
                            project_id: &project_id,
                            revision_ids: &listed,
                            query_scene_id: super::tests::RAW_SOURCE_SCENE,
                            budget_tokens: 100_000,
                            purpose: PackingPurpose::Writing,
                            graph: Some(&request.candidates),
                        },
                        RevisionUnavailablePolicy::Exclude,
                        &mut input_budget,
                        &mut |_| Ok(()),
                        &mut || Ok(()),
                    )?;
                let expected_groups = pooled
                    .graph
                    .as_ref()
                    .expect("a Graph outcome")
                    .groups()
                    .iter()
                    .filter(|group| group.revision_id() == kept)
                    .count();
                let binding = pooled
                    .bindings
                    .iter_mut()
                    .find(|binding| binding.revision_id() == target)
                    .expect("the Revision binding");
                let first = binding.revision.material_basis.source_basis[0].clone();
                let mut conflicting = first.clone();
                conflicting.revision_token = format!("{}-other", first.revision_token);
                binding
                    .revision
                    .material_basis
                    .source_basis
                    .push(conflicting);
                let history_context = build_history_context_stage(
                    conn,
                    &project_id,
                    super::tests::RAW_SOURCE_SCENE,
                    fixture.snapshot.durable_workspace_identity(),
                    crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
                )?;
                let built = build_native_nir1_prepared_inputs(
                    fixture.capture.clone(),
                    project_id,
                    super::tests::RAW_SOURCE_SCENE.to_owned(),
                    version,
                    message,
                    pooled,
                    history_context,
                    &mut || Ok(()),
                )?;
                Ok((built, expected_groups))
            },
        )?;
    assert_eq!(
        conflicted
            .excluded_revisions()
            .iter()
            .map(|excluded| (excluded.revision_id().to_owned(), excluded.reason()))
            .collect::<Vec<_>>(),
        vec![(
            target.clone(),
            NativeNir1RevisionExclusionReason::MaterialBasisSourceTokenConflict
        )]
    );
    let remaining = conflicted
        .graph_binding()
        .expect("the other Graph groups stay");
    assert!(remaining
        .inputs()
        .iter()
        .all(|input| input.revision_id() == kept));
    assert_eq!(remaining.inputs().len(), expected_groups);
    assert!(conflicted
        .authority_bindings()
        .iter()
        .all(|binding| binding.revision_id() != target));
    // Nothing of the left-out Revision is a context item, and the output is
    // still complete.
    let rows = conflicted.finalize_qualifications(100_000)?;
    conflicted
        .check_completeness(&rows.qualifications)
        .map_err(|violation| anyhow::anyhow!("{violation}"))?;
    assert!(conflicted
        .input_references()
        .iter()
        .all(|input| match &input.target {
            InputTarget::AcceptedRevision { revision_id, .. } => revision_id != &target,
            InputTarget::GraphEvidence { evidence_ref, .. } =>
                !graph_inputs_of(&request.selected, &target).contains(evidence_ref),
            _ => true,
        }));
    Ok(())
}

fn graph_inputs_of(selected: &NativeNir1SelectedInputs, revision_id: &str) -> Vec<String> {
    let prepared = selected.prepared();
    let Some(graph) = prepared.graph_binding() else {
        return Vec::new();
    };
    graph
        .inputs()
        .iter()
        .filter(|input| input.revision_id() == revision_id)
        .filter_map(
            |input| match &prepared.input_references()[input.input_ordinal()].target {
                InputTarget::GraphEvidence { evidence_ref, .. } => Some(evidence_ref.clone()),
                _ => None,
            },
        )
        .collect()
}

/// A-20 (DR-DI1A-23): the Graph groups record one input each with the whole
/// qualification set of their Revision, so the optional Graph may not turn a
/// request that fits the attempt's reference cap into one the create refuses.
/// The groups that do not fit are not added (counted as `limit`) and the
/// accepted IR groups stay.
#[test]
fn the_graph_groups_that_would_exceed_the_reference_cap_are_not_added() -> Result<()> {
    use super::graph_candidates::REFERENCE_CAPS_FOR_TEST;

    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            REFERENCE_CAPS_FOR_TEST.with(|caps| caps.set(None));
        }
    }
    let _reset = Reset;

    let request = graph_request()?;
    let references_of = |selected: &NativeNir1SelectedInputs| -> Result<usize> {
        let prepared = selected.prepared();
        Ok(prepared.input_references().len()
            + prepared
                .finalize_qualifications(100_000)?
                .qualifications
                .len())
    };
    let control_references = references_of(&request.control)?;
    let full_references = references_of(&request.selected)?;
    let full_groups = request
        .selected
        .prepared()
        .graph_outcome()
        .expect("a Graph outcome")
        .groups()
        .len();
    assert!(full_groups >= 2, "the fixture admits several groups");
    assert!(full_references > control_references);

    let mut seen_groups = std::collections::BTreeSet::new();
    let mut previous = 0usize;
    // From the cap of the Graph-less request up to the one that holds every
    // group (the count carries a fixed allowance above the exact total).
    for cap in (control_references..=full_references + REFERENCE_ALLOWANCE).step_by(3) {
        REFERENCE_CAPS_FOR_TEST.with(|caps| caps.set(Some((cap, usize::MAX))));
        let selected = request
            .fixture
            .select_graph(Some(&request.candidates), |_| Ok(100_000))?;
        let prepared = selected.prepared();
        let outcome = prepared.graph_outcome().expect("a Graph outcome");
        let groups = outcome.groups().len();
        assert!(groups >= previous, "a larger cap never admits fewer groups");
        previous = groups;
        seen_groups.insert(groups);
        // The request is accepted whatever the cap: the references it records
        // fit the cap and the accepted IR groups are still in it.
        assert!(
            references_of(&selected)? <= cap || groups == 0,
            "cap {cap}: {} references",
            references_of(&selected)?
        );
        assert_eq!(
            outcome.limited_count() + groups,
            full_groups,
            "cap {cap}: every group that is not added is counted as a limit"
        );
        assert_eq!(
            prepared.context_items().len(),
            request.control.prepared().context_items().len(),
            "cap {cap}: a Graph group replaces its IR group"
        );
    }
    assert!(seen_groups.contains(&0), "the lowest cap admits no group");
    assert!(
        seen_groups.contains(&full_groups),
        "the highest cap admits every group"
    );
    assert!(
        seen_groups
            .iter()
            .any(|groups| *groups > 0 && *groups < full_groups),
        "a cap in between admits a prefix: {seen_groups:?}"
    );
    Ok(())
}

/// The fixed allowance `ReferenceMeter` keeps above the exact total (the Human
/// and the Raw input are not counted one by one).
const REFERENCE_ALLOWANCE: usize = 32;
