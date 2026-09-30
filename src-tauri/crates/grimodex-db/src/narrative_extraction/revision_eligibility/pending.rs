use std::collections::HashSet;

use anyhow::Result;
use rusqlite::{params, Connection};

use super::super::change_feed::{get_changes_since, validate_event};
use super::super::cursor_reservation::get_cursor;
use super::super::dependency_edges::DependencyEdge;
use super::super::incremental_freshness::{
    affected_source_identities, event_changes_project_scope_authority,
    requires_full_graph_evaluation,
};
use super::super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;
use super::{is_storage_error, pending_seals, RevisionFreshnessReason as Reason};

const SEQUENCES_PER_PAGE: i64 = 64;
const MAX_PAGES: usize = 16;
const MAX_EVENTS: i64 = 4096;

#[derive(Debug, Eq, PartialEq)]
pub(in crate::narrative_extraction) struct FeedSnapshot {
    pub acknowledged: i64,
    pub head: i64,
}

/// Exhaust the fixed snapshot's pending sequence range or return unknown.
/// A page is counted before hydration, so one oversized transaction cannot
/// defeat the memory bound. Missing joined events cannot masquerade as a
/// completed scan. This reader never reserves, acknowledges or repairs Feed.
pub(in crate::narrative_extraction) fn read(
    conn: &Connection,
    project: &str,
    edges: &[DependencyEdge],
) -> Result<std::result::Result<FeedSnapshot, Reason>> {
    let Some(cursor) = get_cursor(conn, project, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID)? else {
        return Ok(Err(Reason::PendingUnknown));
    };
    let head: i64 = conn.query_row("SELECT MAX(value) FROM (SELECT COALESCE(MAX(canonical_sequence),0) AS value FROM narrative_change_events WHERE project_id=?1 UNION ALL SELECT COALESCE(MAX(source_change_event_sequence),0) AS value FROM narrative_change_transactions WHERE project_id=?1)",[project],|r|r.get(0))?;
    let acknowledged = cursor.acknowledged_through_sequence;
    if acknowledged < 0 || acknowledged > head {
        return Ok(Err(Reason::PendingUnknown));
    }
    let sources: HashSet<_> = edges
        .iter()
        .map(|edge| edge.source_object_identity.as_str())
        .collect();
    let mut through = acknowledged;
    let mut visited = 0;
    for _ in 0..MAX_PAGES {
        if through == head {
            return Ok(Ok(FeedSnapshot { acknowledged, head }));
        }
        let page_end: Option<i64> = conn.query_row(
            "SELECT MAX(canonical_sequence) FROM (SELECT canonical_sequence FROM narrative_change_events
             WHERE project_id=?1 AND canonical_sequence>?2 AND canonical_sequence<=?3
             GROUP BY canonical_sequence ORDER BY canonical_sequence LIMIT ?4)",
            params![project,through,head,SEQUENCES_PER_PAGE],|r|r.get(0),
        )?;
        let Some(page_end) = page_end.filter(|end| *end > through && *end <= head) else {
            return Ok(Err(Reason::PendingUnknown));
        };
        let count:i64 = conn.query_row("SELECT COUNT(*) FROM narrative_change_events WHERE project_id=?1 AND canonical_sequence>?2 AND canonical_sequence<=?3",params![project,through,page_end],|r|r.get(0))?;
        if count <= 0 || count > MAX_EVENTS - visited {
            return Ok(Err(Reason::PendingUnknown));
        }
        let events = match get_changes_since(conn, project, through, SEQUENCES_PER_PAGE) {
            Ok(events) => events,
            Err(error) if is_storage_error(&error) => return Err(error),
            Err(_) => return Ok(Err(Reason::PendingUnknown)),
        };
        if events.len() as i64 != count
            || events.last().map(|e| e.canonical_sequence) != Some(page_end)
        {
            return Ok(Err(Reason::PendingUnknown));
        }
        if !pending_seals::verify(conn, project, through, page_end, &events)? {
            return Ok(Err(Reason::PendingUnknown));
        }
        for event in &events {
            let input = pending_seals::input(event);
            if event.project_id != project
                || event.canonical_sequence <= through
                || event.canonical_sequence > page_end
                || event.change_kind == "unknown"
                || validate_event(&input).is_err()
            {
                return Ok(Err(Reason::PendingUnknown));
            }
            if requires_full_graph_evaluation(event) {
                return Ok(Err(Reason::PendingGlobalChange));
            }
        }
        if sources
            .iter()
            .any(|source| source.starts_with("scope-dependency:v1:"))
            && events.iter().any(event_changes_project_scope_authority)
        {
            return Ok(Err(Reason::PendingRelevantChange));
        }
        let affected = match affected_source_identities(project, &events) {
            Ok(affected) => affected,
            Err(_) => return Ok(Err(Reason::PendingUnknown)),
        };
        if affected
            .iter()
            .any(|identity| sources.contains(identity.as_str()))
        {
            return Ok(Err(Reason::PendingRelevantChange));
        }
        through = page_end;
        visited += count;
    }
    if through == head {
        Ok(Ok(FeedSnapshot { acknowledged, head }))
    } else {
        Ok(Err(Reason::PendingUnknown))
    }
}
