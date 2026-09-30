use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::nir1_entity_relation_index::INDEX_KEY as GRAPH_INDEX_KEY;
use super::INDEX_KEY as CHRONICLE_INDEX_KEY;

/// Invalidation owns no Freshness verdict. A committed dirty change makes every
/// previously lent Native proof unusable in the same SQL commit. The published
/// producer generation remains equal to its sealed D1 head until a new build
/// publishes the next generation; dirtying must not corrupt that identity.
/// This also dirties a malformed known-key row without granting it authority.
pub(crate) fn suspend_project_in_tx(conn: &Connection, project: &str) -> Result<()> {
    let has_binding: bool = conn.query_row(
        "SELECT EXISTS(
                 SELECT 1 FROM narrative_semantic_index_metadata
                  WHERE project_id=?1 AND index_key IN (?2, ?3)
             )",
        params![project, CHRONICLE_INDEX_KEY, GRAPH_INDEX_KEY],
        |row| row.get(0),
    )?;
    if !has_binding {
        return Ok(());
    }
    ensure!(
        !conn.is_autocommit(),
        "NIR1 live index input mutations require a transaction"
    );
    conn.execute(
        "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1
         WHERE project_id=?1 AND index_key IN (?2, ?3)",
        params![project, CHRONICLE_INDEX_KEY, GRAPH_INDEX_KEY],
    )?;
    Ok(())
}

pub(crate) fn suspend_current_revision_in_tx(
    conn: &Connection,
    project: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> Result<()> {
    if consumer_kind != "proposal-revision" {
        return Ok(());
    }
    let current:bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM narrative_proposals p JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
         WHERE s.project_id=?1 AND p.current_revision_id=?2)",params![project,consumer_key],|row|row.get(0),
    )?;
    if current {
        suspend_project_in_tx(conn, project)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn before_edge_state_write(
    conn: &Connection,
    project: &str,
    edge: &str,
    freshness: &str,
    reason: Option<&str>,
    action: &str,
    epoch: &str,
) -> Result<()> {
    let row = conn.query_row(
        "SELECT e.consumer_kind,e.consumer_key,s.evidence_freshness,s.reason_code,s.build_action,s.evaluated_at_epoch_id
         FROM narrative_dependency_edges e LEFT JOIN narrative_dependency_edge_states s ON s.edge_id=e.id
         WHERE e.project_id=?1 AND e.id=?2",params![project,edge],|r|Ok((
            r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,
            r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,
         )),
    ).optional()?;
    if let Some((kind, key, old_freshness, old_reason, old_action, old_epoch)) = row {
        if old_freshness.as_deref() != Some(freshness)
            || old_reason.as_deref() != reason
            || old_action.as_deref() != Some(action)
            || old_epoch.as_deref() != Some(epoch)
        {
            suspend_current_revision_in_tx(conn, project, &kind, &key)?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn before_consumer_state_write(
    conn: &Connection,
    project: &str,
    kind: &str,
    key: &str,
    freshness: &str,
    action: &str,
    epoch: &str,
    publisher: Option<&str>,
    digest: Option<&str>,
) -> Result<()> {
    if kind != "proposal-revision" {
        return Ok(());
    }
    let old = conn.query_row(
        "SELECT evidence_freshness,build_action,semantic_epoch_id,last_evaluated_run_id,dependency_set_digest
         FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3",
        params![project,kind,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?)),
    ).optional()?;
    let unchanged = old.as_ref().is_some_and(|(f, a, e, p, d)| {
        f == freshness
            && a == action
            && e == epoch
            && p.as_deref() == publisher
            && d.as_deref() == digest
    });
    if !unchanged {
        suspend_current_revision_in_tx(conn, project, kind, key)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn before_edge_input_write(
    conn: &Connection,
    project: &str,
    kind: &str,
    key: &str,
    source: &str,
    read_set: &str,
    owning_run: Option<&str>,
    transaction: Option<&str>,
) -> Result<()> {
    if kind != "proposal-revision" {
        return Ok(());
    }
    let old = conn.query_row(
        "SELECT read_set_json,owning_run_id,generated_by_transaction_id FROM narrative_dependency_edges
         WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3 AND source_object_identity=?4",
        params![project,kind,key,source],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?)),
    ).optional()?;
    if !old.as_ref().is_some_and(|(r, o, t)| {
        r == read_set && o.as_deref() == owning_run && t.as_deref() == transaction
    }) {
        suspend_current_revision_in_tx(conn, project, kind, key)?;
    }
    Ok(())
}
