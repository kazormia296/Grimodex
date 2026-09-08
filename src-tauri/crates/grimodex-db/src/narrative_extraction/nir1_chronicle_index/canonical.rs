use anyhow::{ensure, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::{
    c2zc_canonical_cutover::{
        is_generic_freshness_canonical, validate_current_evaluation_run_reference,
    },
    dependency_edges::{consumer_dependency_set_digest, find_edges_by_consumer},
    evaluator::{BuildAction, EvidenceFreshness},
    restore_rebuild::evaluate_owned_edges_from_db_in_tx,
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
    ensure!(
        !conn.is_autocommit(),
        "NIR1 query validation requires a read transaction"
    );
    if runtime.current_epoch(conn)? != Ok(proof.runtime_epoch) {
        return Ok(false);
    }
    let read_identity = super::read_identity::ReadIdentity::read(conn)?;
    if let Some(identity) = &read_identity {
        let validated = proof
            .validated_read
            .lock()
            .map_err(|_| anyhow::anyhow!("NIR1 proof read lock poisoned"))?;
        if validated.as_ref() == Some(identity) {
            return Ok(runtime.current_epoch(conn)? == Ok(proof.runtime_epoch));
        }
    }
    if !is_generic_freshness_canonical(conn)? {
        return Ok(false);
    }
    let language: String = conn.query_row(
        "SELECT language FROM projects WHERE id=?1",
        [&proof.project],
        |row| row.get(0),
    )?;
    if language != proof.language {
        return Ok(false);
    }
    let BindingRead::Registered(current) = binding::read(conn, &proof.project)? else {
        return Ok(false);
    };
    if current.dirty
        || current != proof.binding
        || source::read_eligibility_source(conn, &proof.project)?.digest != current.source_digest
        || get_current_epoch(conn, &proof.project)?
            .is_none_or(|epoch| epoch.id != proof.semantic_epoch)
    {
        return Ok(false);
    }
    let row = conn.query_row("SELECT evidence_freshness,build_action,semantic_epoch_id,last_evaluated_run_id,dependency_set_digest,updated_at
        FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",
        params![proof.project,INDEX_KEY],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
            r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?))).optional()?;
    let Some((freshness, action, epoch, publisher, digest, updated)) = row else {
        return Ok(false);
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
        return Ok(false);
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
            return Ok(false);
        }
    }
    let edges = find_edges_by_consumer(conn, &proof.project, "semantic-index", INDEX_KEY)?;
    if edges != proof.input_edges || pending::read(conn, &proof.project, &edges)?.is_err() {
        return Ok(false);
    }
    let mut statement = conn.prepare("SELECT project_id,evidence_freshness,reason_code,build_action,evaluated_at_epoch_id,evaluated_at
        FROM narrative_dependency_edge_states WHERE edge_id=?1")?;
    for edge in &edges {
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
            return Ok(false);
        };
        if project != proof.project
            || freshness != "fresh"
            || reason.is_some()
            || action != "none"
            || epoch != proof.semantic_epoch
            || !canonical_instant(&updated)
        {
            return Ok(false);
        }
    }
    for observation in evaluate_owned_edges_from_db_in_tx(conn, &proof.project, &edges)? {
        if observation.freshness != EvidenceFreshness::Fresh
            || observation.build_action != BuildAction::None
            || observation.reason_code.is_some()
        {
            return Ok(false);
        }
    }
    if !super::revision_bindings::still_current(conn, proof)? {
        return Ok(false);
    }
    if runtime.current_epoch(conn)? != Ok(proof.runtime_epoch) {
        return Ok(false);
    }
    if read_identity.is_some() && super::read_identity::ReadIdentity::read(conn)? == read_identity {
        *proof
            .validated_read
            .lock()
            .map_err(|_| anyhow::anyhow!("NIR1 proof read lock poisoned"))? = read_identity;
    }
    Ok(true)
}
