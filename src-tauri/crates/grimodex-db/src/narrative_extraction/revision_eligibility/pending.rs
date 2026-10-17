use std::collections::HashSet;

use anyhow::Result;
use rusqlite::{params, Connection};

use super::super::change_feed::{get_changes_since, validate_event};
use super::super::cursor_reservation::get_cursor;
use super::super::dependency_edges::DependencyEdge;
use super::super::incremental_freshness::{
    affected_source_identities, event_changes_every_scene_scope_projection,
    event_changes_project_scope_authority, requires_full_graph_evaluation,
};
use super::super::scene_scope_projection::SOURCE_PREFIX as SCENE_SCOPE_PROJECTION_PREFIX;
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
        if sources
            .iter()
            .any(|source| source.starts_with(SCENE_SCOPE_PROJECTION_PREFIX))
            && events
                .iter()
                .any(event_changes_every_scene_scope_projection)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::change_feed::{
        payload_digest, AppendNarrativeChangeTransactionInput,
    };
    use crate::narrative_extraction::scene_scope_projection::{
        source_key,
        tests::{explicit, fixture, patch, registry_refs, set_scope, update_registry, P},
    };
    use crate::Database;
    use serde_json::json;

    /// Move the incremental-freshness cursor to the Feed head, as a completed
    /// Freshness cycle would. (The cycle itself needs a Semantic Epoch, which
    /// this reader test does not set up.)
    fn acknowledge(db: &Database) {
        db.with_conn(|conn| {
            let head: i64 = conn.query_row(
                "SELECT MAX(value) FROM (
                     SELECT COALESCE(MAX(canonical_sequence), 0) AS value
                       FROM narrative_change_events WHERE project_id = ?1
                     UNION ALL
                     SELECT COALESCE(MAX(source_change_event_sequence), 0) AS value
                       FROM narrative_change_transactions WHERE project_id = ?1)",
                [P],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO narrative_change_cursors
                     (project_id, consumer_id, acknowledged_through_sequence, updated_at)
                 VALUES (?1, ?2, ?3, '2026-10-17T00:00:00.000Z')
                 ON CONFLICT(project_id, consumer_id) DO UPDATE
                     SET acknowledged_through_sequence = excluded.acknowledged_through_sequence",
                params![P, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID, head],
            )?;
            Ok(())
        })
        .expect("acknowledge the Feed head");
    }

    fn edges(scenes: &[&str]) -> Vec<DependencyEdge> {
        scenes
            .iter()
            .map(|scene| DependencyEdge {
                id: format!("edge-{scene}"),
                project_id: P.into(),
                consumer_kind: "proposal-revision".into(),
                consumer_key: "revision-1".into(),
                source_object_identity: source_key(scene).expect("projection key"),
                read_set_json: "[]".into(),
                generated_by_transaction_id: None,
                created_at: "2026-10-17T00:00:00.000Z".into(),
                owning_run_id: None,
            })
            .collect()
    }

    fn pending(db: &Database, scenes: &[&str]) -> Option<Reason> {
        let edges = edges(scenes);
        db.with_read_transaction(|conn| read(conn, P, &edges))
            .expect("pending read")
            .err()
    }

    /// X1-3: a projection Edge is pending only for the events that move its
    /// own Scene's projection, and for a registry change.
    #[test]
    fn pending_is_selected_by_projection_identity() {
        let db = fixture();
        acknowledge(&db);
        assert_eq!(pending(&db, &["s1", "s2", "s3"]), None, "nothing pending");

        // Body-Source fields and another Scene's edits are not pending.
        patch(&db, "s1", "title", json!("Renamed"), true);
        patch(&db, "n1", "title", json!("Note"), true);
        patch(&db, "f3", "title", json!("Empty folder"), true);
        assert_eq!(pending(&db, &["s1", "s2", "s3"]), None, "display edits");

        // Another Scene's Scope moves only that Scene's projection.
        set_scope(&db, "s2", |scope| explicit(scope, "timeline:main"));
        assert_eq!(pending(&db, &["s1", "s3"]), None, "other anchors");
        assert_eq!(
            pending(&db, &["s1", "s2"]),
            Some(Reason::PendingRelevantChange)
        );
        acknowledge(&db);

        // A folder that holds live Scenes moves the Scenes below it.
        patch(&db, "f1", "sortOrder", json!("a5"), true);
        assert_eq!(pending(&db, &["s3"]), None, "a Scene outside the folder");
        assert_eq!(pending(&db, &["s1"]), Some(Reason::PendingRelevantChange));
        assert_eq!(pending(&db, &["s2"]), Some(Reason::PendingRelevantChange));
        acknowledge(&db);

        // A registry change reaches every projection Edge.
        let mut registry = registry_refs();
        registry.timeline_refs.push("timeline:extra".into());
        update_registry(&db, registry);
        for scene in ["s1", "s2", "s3"] {
            assert_eq!(
                pending(&db, &[scene]),
                Some(Reason::PendingRelevantChange),
                "{scene}"
            );
        }
    }
    /// Make the newest Feed transaction carry `object_key` and `change_kind` on
    /// every event, then seal it again as the Native producer would, so the
    /// reader's seal check passes and only the classification can fail.
    fn corrupt_and_reseal(
        db: &Database,
        object_key: Option<serde_json::Value>,
        change_kind: &str,
    ) -> i64 {
        db.with_conn(|conn| {
            let sequence: i64 = conn.query_row(
                "SELECT MAX(canonical_sequence) FROM narrative_change_events
                  WHERE project_id = ?1",
                [P],
                |row| row.get(0),
            )?;
            let events = get_changes_since(conn, P, sequence - 1, 1)?;
            assert!(!events.is_empty());
            for event in &events {
                let key = object_key.clone().unwrap_or_else(|| {
                    // The same key without its Scene id.
                    let mut key = event.object_key.clone();
                    key.as_object_mut().expect("object key").remove("sceneId");
                    key
                });
                conn.execute(
                    "UPDATE narrative_change_events
                        SET object_key_json = ?2, change_kind = ?3
                      WHERE id = ?1",
                    params![event.event_id, key.to_string(), change_kind],
                )?;
            }
            let (id, request_id, source_domain, uid, applications, created): (
                String,
                String,
                String,
                String,
                String,
                String,
            ) = conn.query_row(
                "SELECT id, request_id, source_domain, source_change_event_uid,
                        application_ids_json, created_at
                   FROM narrative_change_transactions
                  WHERE project_id = ?1 AND source_change_event_sequence = ?2",
                params![P, sequence],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )?;
            let events = get_changes_since(conn, P, sequence - 1, 1)?;
            let first = &events[0];
            let seal = payload_digest(&AppendNarrativeChangeTransactionInput {
                project_id: P.into(),
                request_id,
                source_domain,
                source_change_event_uid: uid,
                cause_kind: first.cause_kind,
                origin: first.origin,
                original_transaction_id: first.original_transaction_id.clone(),
                commit_id: first.commit_id.clone(),
                journal_id: first.journal_id.clone(),
                undo_journal_id: first.undo_journal_id.clone(),
                application_ids: serde_json::from_str(&applications)?,
                occurred_at: created,
                events: events.iter().map(super::super::pending_seals::input).collect(),
            })?;
            conn.execute(
                "UPDATE narrative_change_transactions SET payload_digest = ?2 WHERE id = ?1",
                params![id, seal],
            )?;
            Ok(sequence)
        })
        .expect("corrupt and reseal the newest Feed transaction")
    }

    /// X1-3 (test 11). An event the router cannot classify is not skipped: the
    /// pending reader answers `PendingUnknown` for every projection Edge, also
    /// for an Edge of a Scene the event could not have touched. Two ways to be
    /// unclassifiable: a kind the router does not know, and a Scene-scope key
    /// that lost its Scene id.
    #[test]
    fn unclassifiable_events_are_pending_unknown() {
        // Control: a resealed transaction that names another Scene's key is
        // read normally, so the failures below come from the classification
        // and not from the seal.
        {
            let db = fixture();
            acknowledge(&db);
            set_scope(&db, "s2", |scope| explicit(scope, "timeline:main"));
            corrupt_and_reseal(
                &db,
                Some(json!({"kind": "scene-scope", "sceneId": "s3"})),
                "metadata",
            );
            assert_eq!(pending(&db, &["s1", "s2"]), None, "control");
            assert_eq!(
                pending(&db, &["s3"]),
                Some(Reason::PendingRelevantChange),
                "control"
            );
        }
        for (case, key, kind) in [
            (
                "unknown kind",
                Some(json!({"kind": "not-a-known-kind", "sceneId": "s2"})),
                "metadata",
            ),
            ("missing sceneId", None, "metadata"),
        ] {
            let db = fixture();
            acknowledge(&db);
            // A real Scope change of s2 appends the `scene` and `scene-scope`
            // events of one transaction.
            set_scope(&db, "s2", |scope| explicit(scope, "timeline:main"));
            assert_eq!(
                pending(&db, &["s2"]),
                Some(Reason::PendingRelevantChange),
                "{case}: before the corruption"
            );
            corrupt_and_reseal(&db, key, kind);
            assert_eq!(
                pending(&db, &["s1", "s3"]),
                Some(Reason::PendingUnknown),
                "{case}: an unrelated Edge"
            );
            assert_eq!(
                pending(&db, &["s2"]),
                Some(Reason::PendingUnknown),
                "{case}: the touched Edge"
            );
        }
    }
}
