use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::nir1_entity_relation::{
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};
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

/// Dirty only the Chronicle IR Index. A caller uses this instead of
/// `suspend_project_in_tx` only when a closed judgement proved, in the same
/// transaction, that the change is an input of the Chronicle Index and not of
/// the Graph Index (X1-5): a body-only feed transaction, or the Freshness of a
/// Revision on the closed list of known non-Graph Revisions. Everything else
/// keeps dirtying both.
pub(crate) fn suspend_chronicle_index_in_tx(conn: &Connection, project: &str) -> Result<()> {
    let has_binding: bool = conn.query_row(
        "SELECT EXISTS(
                 SELECT 1 FROM narrative_semantic_index_metadata
                  WHERE project_id=?1 AND index_key=?2
             )",
        params![project, CHRONICLE_INDEX_KEY],
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
         WHERE project_id=?1 AND index_key=?2",
        params![project, CHRONICLE_INDEX_KEY],
    )?;
    Ok(())
}

/// The closed list of known non-Graph Revisions (X1-5): `(set_kind,
/// surface_path_id)` pairs whose Freshness is an input of the Chronicle IR
/// Index and not of the Graph Index. Today it is the Chronicle IR only.
/// Adding a pair stops dirtying the Graph Index for more writes, so it needs a
/// new confirmed contract (`[precheck]`).
pub(crate) const KNOWN_NON_GRAPH_REVISION_KINDS: [(&str, &str); 1] = [(
    super::super::repository::CHRONICLE_PROPOSAL_SET_KIND,
    super::super::repository::CHRONICLE_EXTRACT_SURFACE_PATH,
)];

/// Which Indexes the Freshness of a proposal Revision feeds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CurrentRevisionIndexInput {
    /// No proposal of the project has the Revision current.
    NotCurrent,
    /// Every proposal that has it current is on the closed list of known
    /// non-Graph Revisions, and none is on the Graph side.
    ChronicleOnly,
    /// A Graph-side Revision, a kind off the list, or a row that cannot be
    /// read: both Indexes, as before X1-5.
    ChronicleAndGraph,
}

/// Classify a Revision from every proposal of the project that has it
/// current, read in the caller's transaction. The Graph side is a Graph
/// roster candidate (the shared predicate) or either half of it (the
/// reserved typed ProposalSet kind, or the typed review surface), so it
/// contains every roster candidate. Only an all-known non-Graph set of rows is
/// `ChronicleOnly`; a missing Run, an empty or non-text value, or a kind off
/// the list is `ChronicleAndGraph`.
pub(crate) fn classify_current_revision_in_tx(
    conn: &Connection,
    project: &str,
    revision: &str,
) -> Result<CurrentRevisionIndexInput> {
    classify_current_revision_with_list_in_tx(
        conn,
        project,
        revision,
        &KNOWN_NON_GRAPH_REVISION_KINDS,
    )
}

/// `classify_current_revision_in_tx` over a given known list. The Graph side
/// is judged first, so a list entry that shared a half with the typed
/// Revision could not move a Graph-side Revision to `ChronicleOnly`; a test
/// pins that with such a list.
pub(crate) fn classify_current_revision_with_list_in_tx(
    conn: &Connection,
    project: &str,
    revision: &str,
    known_non_graph: &[(&str, &str)],
) -> Result<CurrentRevisionIndexInput> {
    let sql = format!(
        "SELECT proposal_set.set_kind, extraction_run.surface_path_id, COALESCE({}, 0)
           FROM narrative_proposals proposal
           JOIN narrative_proposal_sets proposal_set
             ON proposal_set.id = proposal.proposal_set_id
           LEFT JOIN narrative_extraction_runs extraction_run
             ON extraction_run.id = proposal_set.run_id
            AND extraction_run.project_id = proposal_set.project_id
          WHERE proposal_set.project_id = ?1 AND proposal.current_revision_id = ?2",
        super::super::nir1_entity_relation_index::roster_candidate_predicate_sql()
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![project, revision])?;
    let mut current = false;
    let mut all_known_non_graph = true;
    while let Some(row) = rows.next()? {
        current = true;
        let set_kind = row.get_ref(0)?.as_str().ok();
        let surface = row.get_ref(1)?.as_str().ok();
        let roster_candidate = row.get_ref(2)?.as_i64().ok() != Some(0);
        if roster_candidate
            || set_kind == Some(NIR1_ENTITY_RELATION_SET_KIND)
            || surface == Some(NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH)
        {
            return Ok(CurrentRevisionIndexInput::ChronicleAndGraph);
        }
        if !known_non_graph
            .iter()
            .any(|(kind, path)| set_kind == Some(*kind) && surface == Some(*path))
        {
            all_known_non_graph = false;
        }
    }
    Ok(match (current, all_known_non_graph) {
        (false, _) => CurrentRevisionIndexInput::NotCurrent,
        (true, true) => CurrentRevisionIndexInput::ChronicleOnly,
        (true, false) => CurrentRevisionIndexInput::ChronicleAndGraph,
    })
}

/// The Freshness hook: a change of a current proposal Revision's Freshness
/// dirties the Indexes it feeds (X1-5). Both, unless the Revision is proved
/// in this transaction to be a known non-Graph Revision only.
pub(crate) fn suspend_current_revision_in_tx(
    conn: &Connection,
    project: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> Result<()> {
    if consumer_kind != "proposal-revision" {
        return Ok(());
    }
    match classify_current_revision_in_tx(conn, project, consumer_key)? {
        CurrentRevisionIndexInput::NotCurrent => Ok(()),
        CurrentRevisionIndexInput::ChronicleOnly => suspend_chronicle_index_in_tx(conn, project),
        CurrentRevisionIndexInput::ChronicleAndGraph => suspend_project_in_tx(conn, project),
    }
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
