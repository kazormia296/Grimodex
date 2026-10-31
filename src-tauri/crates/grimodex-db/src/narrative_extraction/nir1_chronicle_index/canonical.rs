use anyhow::{ensure, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::nir1_entity_relation_index::GraphWorkControl;
use super::super::{
    c2zc_canonical_cutover::{
        is_generic_freshness_canonical, validate_current_evaluation_run_reference,
    },
    dependency_edges::{consumer_dependency_set_digest, find_edges_by_consumer},
    evaluator::{BuildAction, EvidenceFreshness},
    restore_rebuild::evaluate_owned_edges_from_db_in_tx_with_control,
    revision_eligibility::pending,
    semantic_epoch::get_current_epoch,
};
use super::{
    binding::{self, BindingRead},
    runtime::IndexProof,
    source, NirChronicleIndexRuntime, INDEX_KEY,
};

pub(super) fn canonical_instant(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|time| {
        time.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            == value
    })
}

/// No model request replay, vector scoring, or mutable event lookup. Persisted
/// authorities are verified together. A private proof may reuse that verdict
/// only for the exact same committed DB state; runtime/owner/S2 checks remain
/// outside that reuse and changed DB state always takes the complete path.
pub(super) fn proof_current(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    proof: &IndexProof,
) -> Result<bool> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    proof_current_with_control(conn, runtime, proof, &mut control)
}

pub(super) fn proof_current_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    proof: &IndexProof,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    Ok(proof_current_observed(conn, runtime, proof, control)?.is_some())
}

/// [`proof_current_with_control`] that also returns the read identity this
/// check observed at its start (DR-CP4-V-1 (c)): `Some(identity)` when the
/// proof is current, where `identity` is `None` outside a Read transaction.
/// A caller may reuse a read of this snapshot only under that same identity.
pub(super) fn proof_current_observed(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    proof: &IndexProof,
    control: &mut dyn GraphWorkControl,
) -> Result<Option<Option<super::read_identity::ReadIdentity>>> {
    control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Source)?;
    ensure!(
        !conn.is_autocommit(),
        "NIR1 query validation requires a read transaction"
    );
    if runtime.current_epoch(conn)? != Ok(proof.runtime_epoch) {
        return Ok(None);
    }
    let read_identity = super::read_identity::ReadIdentity::read(conn)?;
    if let Some(identity) = &read_identity {
        let validated = proof
            .validated_read
            .lock()
            .map_err(|_| anyhow::anyhow!("NIR1 proof read lock poisoned"))?;
        if validated.as_ref() == Some(identity) {
            return Ok((runtime.current_epoch(conn)? == Ok(proof.runtime_epoch))
                .then(|| read_identity.clone()));
        }
    }
    if !is_generic_freshness_canonical(conn)? {
        return Ok(None);
    }
    let language: String = conn.query_row(
        "SELECT language FROM projects WHERE id=?1",
        [&proof.project],
        |row| row.get(0),
    )?;
    if language != proof.language {
        return Ok(None);
    }
    let BindingRead::Registered(current) = binding::read(conn, &proof.project)? else {
        return Ok(None);
    };
    if current.dirty
        || current != proof.binding
        || {
            control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Source)?;
            source::read_eligibility_source_with_control(conn, &proof.project, control)?.digest
                != current.source_digest
        }
        || get_current_epoch(conn, &proof.project)?
            .is_none_or(|epoch| epoch.id != proof.semantic_epoch)
    {
        return Ok(None);
    }
    let row = conn.query_row("SELECT evidence_freshness,build_action,semantic_epoch_id,last_evaluated_run_id,dependency_set_digest,updated_at
        FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",
        params![proof.project,INDEX_KEY],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
            r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?))).optional()?;
    let Some((freshness, action, epoch, publisher, digest, updated)) = row else {
        return Ok(None);
    };
    if freshness != "fresh"
        || action != "none"
        || epoch != proof.semantic_epoch
        || !canonical_instant(&updated)
        || digest.as_deref()
            != Some(&consumer_dependency_set_digest(
                conn,
                &proof.project,
                "semantic-index",
                INDEX_KEY,
            )?)
    {
        return Ok(None);
    }
    if let Some(publisher) = publisher {
        if let Err(error) = validate_current_evaluation_run_reference(
            conn,
            &proof.project,
            &proof.semantic_epoch,
            INDEX_KEY,
            &publisher,
        ) {
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some()
            {
                return Err(error);
            }
            return Ok(None);
        }
    }
    let edges = find_edges_by_consumer(conn, &proof.project, "semantic-index", INDEX_KEY)?;
    if edges != proof.input_edges || pending::read(conn, &proof.project, &edges)?.is_err() {
        return Ok(None);
    }
    let mut statement = conn.prepare("SELECT project_id,evidence_freshness,reason_code,build_action,evaluated_at_epoch_id,evaluated_at
        FROM narrative_dependency_edge_states WHERE edge_id=?1")?;
    for edge in &edges {
        control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Edge)?;
        let state = statement
            .query_row([&edge.id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .optional()?;
        let Some((project, freshness, reason, action, epoch, updated)) = state else {
            return Ok(None);
        };
        if project != proof.project
            || freshness != "fresh"
            || reason.is_some()
            || action != "none"
            || epoch != proof.semantic_epoch
            || !canonical_instant(&updated)
        {
            return Ok(None);
        }
    }
    for observation in
        evaluate_owned_edges_from_db_in_tx_with_control(conn, &proof.project, &edges, control)?
    {
        if observation.freshness != EvidenceFreshness::Fresh
            || observation.build_action != BuildAction::None
            || observation.reason_code.is_some()
        {
            return Ok(None);
        }
    }
    if !super::revision_bindings::still_current(conn, proof, control)? {
        return Ok(None);
    }
    if runtime.current_epoch(conn)? != Ok(proof.runtime_epoch) {
        return Ok(None);
    }
    // The identity is returned (and kept for the verdict) only when it is the
    // same after the complete check as before it; otherwise no later read of
    // this check may be reused under it (DR-CP4-V-1 (b), (c)).
    let read_identity = match read_identity {
        Some(identity)
            if super::read_identity::ReadIdentity::read(conn)?.as_ref() == Some(&identity) =>
        {
            *proof
                .validated_read
                .lock()
                .map_err(|_| anyhow::anyhow!("NIR1 proof read lock poisoned"))? =
                Some(identity.clone());
            Some(identity)
        }
        _ => None,
    };
    Ok(Some(read_identity))
}
