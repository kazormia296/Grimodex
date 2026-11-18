//! S1-A2 (chat IR): the two Chronicle-event reads that sit next to a query
//! snapshot.
//!
//! * A1 `read_chronicle_event_ids_of_revisions`: revision -> the `events` row
//!   its payload names, only while that row exists in this project.
//! * A2 `read_chronicle_excluded_event_ids`: of the events a caller already
//!   holds, which ones does the IR admission rule exclude for this query.
//!
//! Both read the caller's transaction and never write. They do not replace a
//! currentness check: the caller runs
//! `validate_chronicle_query_snapshot*` after them, in the same transaction,
//! so these reads and the batch share one snapshot.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{ensure, Result};
use rusqlite::{params_from_iter, Connection};

use super::query::{NirProposalAdmission, NirQualifiedBatch};

/// `IN (...)` chunk size. Callers hold a handful of ids (the chat IR sends at
/// most 30 events and returns at most 8 items); the chunk only keeps the
/// statement far below SQLite's host-parameter limit.
const IN_CHUNK: usize = 500;

/// `$.eventId` of a revision payload. A payload that is not valid JSON has no
/// event id (the guard keeps one malformed row from failing the statement).
const PAYLOAD_EVENT_ID: &str =
    "CASE WHEN json_valid(r.payload_json) THEN json_extract(r.payload_json,'$.eventId') END";

fn placeholders(first: usize, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", first + i))
        .collect::<Vec<_>>()
        .join(",")
}

/// The A1 statement for `count` revision ids (`?1` is the project).
pub(super) fn revision_events_sql(count: usize) -> String {
    format!(
        "SELECT r.id, e.id
           FROM narrative_proposal_revisions r
           JOIN narrative_proposals p ON p.id = r.proposal_id
           JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
           JOIN events e ON e.id = {PAYLOAD_EVENT_ID} AND e.project_id = s.project_id
          WHERE s.project_id = ?1 AND r.id IN ({})",
        placeholders(2, count)
    )
}

/// The A2 statement for `count` candidate event ids (`?1` is the project).
pub(super) fn event_proposals_sql(count: usize) -> String {
    format!(
        "SELECT {PAYLOAD_EVENT_ID} AS event_id, p.id
           FROM narrative_proposals p
           JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
           JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
          WHERE s.project_id = ?1 AND event_id IN ({})",
        placeholders(2, count)
    )
}

/// A1. Revision id -> event id, for the revisions whose payload `eventId`
/// names a row of `events` in `project_id`.
///
/// The `events` row is the proof that the proposal is applied: an unapplied
/// revision, an undone apply and an event the author deleted by hand all have
/// no row, so they are absent from the result (their payload still carries the
/// id, which is why the payload alone proves nothing). Applications are not
/// consulted: undo leaves them in place (`undo.rs`).
pub fn read_chronicle_event_ids_of_revisions(
    conn: &Connection,
    project_id: &str,
    revision_ids: &[String],
) -> Result<BTreeMap<String, String>> {
    let mut found = BTreeMap::new();
    if revision_ids.is_empty() {
        return Ok(found);
    }
    ensure!(
        !conn.is_autocommit(),
        "Chronicle event id read requires a transaction"
    );
    for chunk in revision_ids.chunks(IN_CHUNK) {
        let sql = revision_events_sql(chunk.len());
        let mut statement = conn.prepare(&sql)?;
        let params = std::iter::once(project_id).chain(chunk.iter().map(String::as_str));
        let rows = statement.query_map(params_from_iter(params), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (revision, event) = row?;
            found.insert(revision, event);
        }
    }
    Ok(found)
}

/// A2. Of `candidate_event_ids`, the events the IR admission rule excludes for
/// the query `batch` qualified. The result is a subset of the candidates, in
/// the caller's order, without duplicates.
///
/// An event is excluded when a proposal whose current revision names it was in
/// the index proof and failed admission for this query (`NotAdmitted`). A
/// proposal that is not in the proof (unapproved, stale, secret by disclosure,
/// not indexed) is `NotIndexed` and is **not** excluded here (design d-i).
/// When one event id is named by several proposals, any `NotAdmitted` one
/// excludes it. The proposal is classified by the proof's own verdict, so a
/// current revision that moved after the proof was built does not change it.
///
/// Another project's event ids match nothing. An empty candidate list returns
/// before any SQL.
pub fn read_chronicle_excluded_event_ids(
    conn: &Connection,
    batch: &NirQualifiedBatch,
    candidate_event_ids: &[String],
) -> Result<Vec<String>> {
    if candidate_event_ids.is_empty() {
        return Ok(Vec::new());
    }
    ensure!(
        !conn.is_autocommit(),
        "Chronicle excluded event read requires a transaction"
    );
    let mut excluded = BTreeSet::new();
    for chunk in candidate_event_ids.chunks(IN_CHUNK) {
        let sql = event_proposals_sql(chunk.len());
        let mut statement = conn.prepare(&sql)?;
        let params = std::iter::once(batch.project_id()).chain(chunk.iter().map(String::as_str));
        let rows = statement.query_map(params_from_iter(params), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (event, proposal) = row?;
            if batch.proposal_admission(&proposal) == NirProposalAdmission::NotAdmitted {
                excluded.insert(event);
            }
        }
    }
    let mut seen = BTreeSet::new();
    Ok(candidate_event_ids
        .iter()
        .filter(|id| excluded.contains(*id) && seen.insert(id.as_str()))
        .cloned()
        .collect())
}
