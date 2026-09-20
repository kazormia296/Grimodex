use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::c2zc_canonical_cutover::{
    is_generic_freshness_canonical, validate_current_evaluation_run_reference,
};
use super::super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, ActiveDependencyDeclarationSetRead,
};
use super::super::dependency_edges::{consumer_dependency_set_digest, find_edges_by_consumer};
use super::super::evaluator::{BuildAction, EvidenceFreshness};
use super::super::material_membership::RevisionMaterialMembership;
use super::super::publish_runtime::worst_edge_state_for_consumer;
use super::super::restore_rebuild::{
    evaluate_edge_from_db, evaluate_edge_from_db_with_control,
};
use super::super::source_revision::{
    is_validation_terminated, ValidationContext,
};
use super::super::nir1_entity_relation_index::GraphWorkControl;
use super::super::semantic_epoch::get_current_epoch;
use super::{
    is_storage_error, pending, unavailable, RevisionFreshnessRead,
    RevisionFreshnessReason as Reason, RevisionFreshnessSnapshot,
};

fn canonical_instant(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|instant| {
        instant
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            == value
    })
}

// Internal composition reuses one membership replay in the caller's snapshot.
pub(in crate::narrative_extraction) fn read(
    conn: &Connection,
    project: &str,
    membership: &RevisionMaterialMembership,
) -> Result<RevisionFreshnessRead> {
    read_impl(conn, project, membership, None)
}

/// Context-bound counterpart for foreground Apply and bounded Freshness.
/// Eligibility edges are evaluated through the exact connection and finite
/// stop owner borrowed by the caller; no nested admission or replacement
/// connection is created here.
pub(in crate::narrative_extraction) fn read_with_validation_context(
    context: &mut ValidationContext<'_, '_>,
    project: &str,
    membership: &RevisionMaterialMembership,
) -> Result<RevisionFreshnessRead> {
    let conn = context.connection();
    let control = context.control();
    read_impl(conn, project, membership, Some(control))
}

fn read_impl(
    conn: &Connection,
    project: &str,
    membership: &RevisionMaterialMembership,
    mut control: Option<&mut dyn GraphWorkControl>,
) -> Result<RevisionFreshnessRead> {
    let revision = &membership.revision_id;
    match is_generic_freshness_canonical(conn) {
        Ok(true) => {}
        Ok(false) => return Ok(unavailable(Reason::CanonicalAuthorityUnavailable)),
        Err(error) if is_storage_error(&error) => return Err(error),
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(_) => return Ok(unavailable(Reason::CanonicalAuthorityUnavailable)),
    }
    let Some(epoch) = get_current_epoch(conn, project)? else {
        return Ok(unavailable(Reason::CurrentEpochUnavailable));
    };
    let row = conn.query_row(
        "SELECT evidence_freshness,build_action,semantic_epoch_id,last_evaluated_run_id,dependency_set_digest,updated_at
         FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind='proposal-revision' AND consumer_key=?2",
        params![project,revision], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?)),
    ).optional()?;
    let Some((freshness, action, evaluated_epoch, publisher, digest, updated_at)) = row else {
        return Ok(unavailable(Reason::CanonicalRowUnavailable));
    };
    if !canonical_instant(&updated_at) || evaluated_epoch != epoch.id {
        return Ok(unavailable(Reason::CanonicalRowInvalid));
    }
    match (
        EvidenceFreshness::try_from(freshness.as_str()),
        BuildAction::try_from(action.as_str()),
    ) {
        (Ok(EvidenceFreshness::Fresh), Ok(BuildAction::None)) => {}
        (Ok(_), Ok(_)) => return Ok(unavailable(Reason::StoredStateNotFresh)),
        _ => return Ok(unavailable(Reason::CanonicalRowInvalid)),
    }
    let edges = find_edges_by_consumer(conn, project, "proposal-revision", revision)?;
    if edges.is_empty() || edges.len() != membership.material_basis.source_basis.len() {
        return Ok(unavailable(Reason::EdgeStateUnavailable));
    }
    let expected_digest =
        consumer_dependency_set_digest(conn, project, "proposal-revision", revision)?;
    if digest.as_deref() != Some(&expected_digest) {
        return Ok(unavailable(Reason::DependencyDigestMismatch));
    }
    let ActiveDependencyDeclarationSetRead::Active(declaration) =
        read_active_dependency_declaration_set_in_tx(conn, project, "proposal-revision", revision)?
    else {
        return Ok(unavailable(Reason::DeclarationUnavailable));
    };
    // The L1 reader checked this exact D1 head and V1 set against the sealed
    // material in this transaction. D1 and V1 digests describe different sets.
    let mut statement = conn.prepare(
        "SELECT s.project_id,s.evidence_freshness,s.reason_code,s.build_action,s.evaluated_at_epoch_id,s.evaluated_at
         FROM narrative_dependency_edges e LEFT JOIN narrative_dependency_edge_states s ON s.edge_id=e.id
         WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' AND e.consumer_key=?2 ORDER BY e.id",
    )?;
    let states = statement
        .query_map(params![project, revision], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if states.len() != edges.len() {
        return Ok(unavailable(Reason::EdgeStateUnavailable));
    }
    for (state_project, freshness, reason, action, state_epoch, evaluated_at) in states {
        let (
            Some(state_project),
            Some(freshness),
            Some(action),
            Some(state_epoch),
            Some(evaluated_at),
        ) = (state_project, freshness, action, state_epoch, evaluated_at)
        else {
            return Ok(unavailable(Reason::EdgeStateUnavailable));
        };
        if state_project != project || state_epoch != epoch.id || !canonical_instant(&evaluated_at)
        {
            return Ok(unavailable(Reason::EdgeStateInvalid));
        }
        // Aggregate severity alone can conceal a later fresh/revalidate-exact
        // edge behind an earlier fresh/none edge. Every edge must satisfy all
        // axes independently. A NULL observed token is valid for runless writes.
        if EvidenceFreshness::try_from(freshness.as_str()).ok() != Some(EvidenceFreshness::Fresh)
            || BuildAction::try_from(action.as_str()).ok() != Some(BuildAction::None)
            || reason.is_some()
        {
            return Ok(unavailable(Reason::StoredStateNotFresh));
        }
    }
    let aggregate = match worst_edge_state_for_consumer(
        conn,
        project,
        "proposal-revision",
        revision,
        &epoch.id,
    ) {
        Ok(Some(aggregate)) => aggregate,
        Ok(None) => return Ok(unavailable(Reason::EdgeStateUnavailable)),
        Err(error) if is_storage_error(&error) => return Err(error),
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(_) => return Ok(unavailable(Reason::EdgeStateInvalid)),
    };
    if aggregate.freshness != EvidenceFreshness::Fresh
        || aggregate.build_action != BuildAction::None
        || aggregate.reason_code.is_some()
    {
        return Ok(unavailable(Reason::StoredStateNotFresh));
    }
    if let Some(publisher) = publisher.as_deref() {
        if let Err(error) =
            validate_current_evaluation_run_reference(conn, project, &epoch.id, revision, publisher)
        {
            if is_storage_error(&error) {
                return Err(error);
            }
            if is_validation_terminated(&error) {
                return Err(error);
            }
            return Ok(unavailable(Reason::PublisherInvalid));
        }
    }
    let feed = match pending::read(conn, project, &edges)? {
        Ok(snapshot) => snapshot,
        Err(reason) => return Ok(unavailable(reason)),
    };
    for edge in &edges {
        let Some(owner) = edge.owning_run_id.as_deref() else {
            return Ok(unavailable(Reason::CurrentSourceUnavailable));
        };
        // Source resolution uses the original verified owner, which may be an
        // older Epoch. Evaluation rows, not Source owner Runs, use current Epoch.
        if owner != membership.run_id {
            return Ok(unavailable(Reason::CurrentSourceUnavailable));
        }
        let observed_result = match control.as_deref_mut() {
            Some(control) => evaluate_edge_from_db_with_control(conn, project, owner, edge, control),
            None => evaluate_edge_from_db(conn, project, owner, edge),
        };
        let observed = match observed_result {
            Ok(observation) => observation,
            Err(error) if is_storage_error(&error) => return Err(error),
            Err(error) if is_validation_terminated(&error) => return Err(error),
            Err(_) => return Ok(unavailable(Reason::CurrentSourceUnavailable)),
        };
        if observed.freshness != EvidenceFreshness::Fresh
            || observed.build_action != BuildAction::None
            || observed.reason_code.is_some()
        {
            return Ok(unavailable(Reason::CurrentSourceNotFresh));
        }
    }
    Ok(RevisionFreshnessRead::Fresh(RevisionFreshnessSnapshot {
        revision_id: revision.clone(),
        semantic_epoch_id: epoch.id,
        dependency_set_digest: expected_digest,
        declaration_set_id: declaration.declaration_set_id,
        declaration_set_digest: declaration.dependency_set_digest,
        last_evaluated_run_id: publisher,
        edge_count: edges.len(),
        feed_acknowledged_through_sequence: feed.acknowledged,
        feed_head_sequence: feed.head,
        _verified: (),
    }))
}
