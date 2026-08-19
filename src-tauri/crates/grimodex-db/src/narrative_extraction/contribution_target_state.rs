//! Projects out-of-band edits from the Change Feed onto Contribution
//! `target_state` (Gate C2 item 4, Step 7).
//!
//! Three of the six states are derived at read time, because the fact already
//! lives somewhere durable and mutable and a second copy could only fall out
//! of step with it: `undone` from the owning commit's status, `superseded`
//! from this table's own ordering, `not-applicable` from the operation that
//! wrote nothing. See `application_contributions.rs`.
//!
//! `modified` and `missing` are different, and are stored. Their source is the
//! Change Feed, which is an append-only log rather than mutable state. A
//! watermarked projection of a log cannot contradict it -- the worst it can do
//! is lag, and a lag is visible in `target_state_sequence` and recoverable by
//! replaying from `baseline_sequence`. Deriving them instead would mean
//! scanning an unbounded event history for every Contribution read, which is a
//! different complexity class from the bounded correlated subquery
//! `superseded` uses.
//!
//! **Only writes with no Application lineage count as evidence.** An Apply
//! stamps its Feed transaction with `commit_id`, and so does the Undo or Redo
//! of that same Apply, so every lineage-bearing write is already fully
//! described by the Contribution ledger's own two axes. Importing them here as
//! well would double-count -- and worse, a `modified` recorded from another
//! Application's Apply would survive that Application being undone, reporting
//! a field as edited at the moment it reverted to exactly what this
//! Contribution wrote. Filtering on `commit_id IS NULL` rather than on
//! `origin` also keeps in-app agent and MCP writes in scope: those carry
//! `origin = ai-apply` but mint no Application, so an `origin = 'human'` test
//! would silently miss them.

use rusqlite::{params, Connection};
use serde_json::Value;

use super::change_feed::{acknowledge_cursor_in_tx, contribution_target_identity_from_object_key};
use super::cursor_reservation::get_cursor;
use super::legacy_backfill::LEGACY_BACKFILL_FIELD_PATH;

/// The Feed consumer identity this projection acknowledges under.
pub(crate) const CONSUMER_ID: &str = "contribution-target-state";

/// One Feed event, reduced to what this projection needs.
struct OutOfBandEdit {
    canonical_sequence: i64,
    target_object_identity: String,
    changed_paths: Vec<String>,
    /// `true` when the object itself went away, which is `missing` rather
    /// than `modified`: there is no field left to have been edited.
    deleted: bool,
    occurred_at: String,
}

/// Whether a Feed event's changed path bears on a Contribution's field.
///
/// Overlap is tested in both directions, on whole JSON Pointer segments. An
/// event on `/details` covers a Contribution on `/details/def-1`, and an event
/// on `/details/def-1` covers a Contribution recorded at the coarser
/// `/details`. Matching on raw string prefixes instead would make `/detail`
/// swallow `/details`.
///
/// `"/"` is the whole object. Journal-derived events collapse to it even for
/// updates, so this over-marks rather than under-marks -- the safe direction
/// for a state whose claim is "something else may have written here".
fn paths_overlap(event_path: &str, field_path: &str) -> bool {
    if event_path == "/" || field_path == "/" {
        return true;
    }
    // The Legacy Backfill's sentinel is the *other* spelling of "the whole
    // object" -- `LEGACY_BACKFILL_FIELD_PATH` stands for "the whole entity
    // this Application wrote, granularity unknown". Compared as an ordinary
    // path it overlaps nothing: it is neither `/` nor a prefix of any real
    // pointer, so a backfilled Contribution could only ever be reached by an
    // event that already collapsed to `/`. Only the field side is checked --
    // a Feed event never carries the sentinel, and `validate_changed_path`
    // would not accept it as evidence if one did.
    if field_path == LEGACY_BACKFILL_FIELD_PATH {
        return true;
    }
    if event_path == field_path {
        return true;
    }
    let covers = |outer: &str, inner: &str| {
        inner.len() > outer.len()
            && inner.starts_with(outer)
            && inner.as_bytes()[outer.len()] == b'/'
    };
    covers(event_path, field_path) || covers(field_path, event_path)
}

/// Reads the Feed events this projection has not yet accounted for.
fn pending_edits(
    conn: &Connection,
    project_id: &str,
    from_exclusive: i64,
) -> anyhow::Result<Vec<OutOfBandEdit>> {
    let mut statement = conn.prepare(
        "SELECT event.canonical_sequence, event.object_key_json,
                event.changed_paths_json, event.mutation_kind, event.occurred_at
           FROM narrative_change_events event
           JOIN narrative_change_transactions transaction_row
             ON transaction_row.project_id = event.project_id
            AND transaction_row.id = event.transaction_id
          WHERE event.project_id = ?1
            AND event.canonical_sequence > ?2
            AND transaction_row.commit_id IS NULL
          ORDER BY event.canonical_sequence ASC, event.event_ordinal ASC",
    )?;
    let rows = statement
        .query_map(params![project_id, from_exclusive], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut edits = Vec::with_capacity(rows.len());
    for (canonical_sequence, object_key_json, changed_paths_json, mutation_kind, occurred_at) in
        rows
    {
        let object_key: Value = serde_json::from_str(&object_key_json)?;
        // An object kind outside the ratified Object Addressing vocabulary
        // cannot be projected onto a Contribution, and guessing would
        // attribute an edit to the wrong object. The cursor still advances
        // past it, because the event is genuinely not evidence about any
        // Contribution we hold -- see `scanned_through` above.
        let Ok(target_object_identity) =
            contribution_target_identity_from_object_key(conn, &object_key)
        else {
            continue;
        };
        edits.push(OutOfBandEdit {
            canonical_sequence,
            target_object_identity,
            changed_paths: serde_json::from_str(&changed_paths_json)?,
            deleted: mutation_kind == "delete",
            occurred_at,
        });
    }
    Ok(edits)
}

/// Brings `target_state` up to date with every out-of-band edit the Feed has
/// recorded since this projection last ran, and acknowledges the cursor.
///
/// Callers own the transaction. Run it before reading Contributions and after
/// an Apply, Undo or Redo: the cursor makes it resumable, so an interrupted
/// run costs a repeat rather than a gap.
pub(crate) fn project_out_of_band_edits_in_tx(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<usize> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "projecting Contribution target state requires a caller-owned transaction"
    );

    let acknowledged = get_cursor(conn, project_id, CONSUMER_ID)?
        .map(|cursor| cursor.acknowledged_through_sequence)
        .unwrap_or(0);
    // The highest sequence *scanned*, which is not the highest retained: an
    // event on an object kind this build cannot address, or one belonging to
    // an Application, is still accounted for. Acknowledging only what was
    // retained would leave the cursor parked behind such an event and rescan
    // it on every read, forever.
    let scanned_through: i64 = conn.query_row(
        "SELECT COALESCE(MAX(canonical_sequence), 0)
           FROM narrative_change_events
          WHERE project_id = ?1 AND canonical_sequence > ?2",
        params![project_id, acknowledged],
        |row| row.get(0),
    )?;
    if scanned_through <= acknowledged {
        return Ok(0);
    }
    let edits = pending_edits(conn, project_id, acknowledged)?;

    let mut updated = 0usize;
    for edit in &edits {
        for path in &edit.changed_paths {
            // The guards are what make an at-least-once Feed delivery safe to
            // replay: `target_state_sequence` refuses an event already
            // accounted for, and `baseline_sequence` refuses one that predates
            // what this Application itself wrote.
            let state = if edit.deleted { "missing" } else { "modified" };
            let mut statement = conn.prepare_cached(
                "UPDATE narrative_application_contributions
                    SET target_state = ?4,
                        target_state_sequence = ?3,
                        target_state_updated_at = ?5
                  WHERE project_id = ?1
                    AND target_object_identity = ?2
                    AND COALESCE(target_state_sequence, -1) < ?3
                    AND COALESCE(baseline_sequence, -1) < ?3
                    AND target_state <> 'not-applicable'
                    AND field_path = ?6",
            )?;
            for candidate in
                matching_field_paths(conn, project_id, &edit.target_object_identity, path)?
            {
                updated += statement.execute(params![
                    project_id,
                    edit.target_object_identity,
                    edit.canonical_sequence,
                    state,
                    edit.occurred_at,
                    candidate,
                ])?;
            }
        }
    }

    // `change_feed`'s acknowledge, not `cursor_reservation`'s. The two are
    // different consumer protocols on one table: Lane I's takes a lease for a
    // Run-scoped consumer that processes a reserved range out of band. This
    // projection runs inside the reader's own transaction and holds nothing
    // across calls, so it has no lease to take -- and taking one would put it
    // in contention with the consumers that genuinely need it. It also upserts,
    // which is what lets the first pump on a project create the cursor.
    acknowledge_cursor_in_tx(
        conn,
        project_id,
        CONSUMER_ID,
        scanned_through,
        &chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    )?;
    Ok(updated)
}

/// The Contribution field paths on one target that a changed path bears on.
///
/// Read back rather than expressed as a SQL predicate because the overlap rule
/// is segment-aware in both directions, which `LIKE` cannot say. The candidate
/// set is one object's fields, and
/// `idx_narrative_application_contributions_target` covers the lookup.
fn matching_field_paths(
    conn: &Connection,
    project_id: &str,
    target_object_identity: &str,
    event_path: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare_cached(
        "SELECT DISTINCT field_path
           FROM narrative_application_contributions
          WHERE project_id = ?1 AND target_object_identity = ?2",
    )?;
    let paths = statement
        .query_map(params![project_id, target_object_identity], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(paths
        .into_iter()
        .filter(|field_path| paths_overlap(event_path, field_path))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::application_contributions::{
        list_contributions_for_target, record_contribution_in_tx, ContributionField,
        ContributionProvenance, ContributionTargetState,
    };
    use crate::narrative_extraction::task_leases::with_immediate_transaction;
    use crate::Database;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db
    }

    /// A commit and one Contribution on `scene:s1` / `/title`, at the given
    /// canonical sequence.
    fn seed_application(conn: &Connection, baseline_sequence: i64) {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p1', 'Test')
             ON CONFLICT(id) DO NOTHING",
            [],
        )
        .expect("seed project");
        conn.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, request_id, plan_digest, status, created_at)
             VALUES ('commit-1', 'p1', 'req-1', 'digest-1', 'applied',
                     '2026-08-15T00:00:00.000Z')
             ON CONFLICT(id) DO NOTHING",
            [],
        )
        .expect("seed commit");
        record_contribution_in_tx(
            conn,
            "p1",
            &ContributionProvenance {
                application_id: "app-1",
                commit_id: "commit-1",
                proposal_id: "proposal-1",
                revision_id: "revision-1",
                operation_id: None,
                baseline_sequence: Some(baseline_sequence),
            },
            &ContributionField {
                target_object_identity: "scene:s1",
                field_path: "/title",
                target_state: ContributionTargetState::Unchanged,
                authority: None,
            },
            "2026-08-15T00:00:00.000Z",
        )
        .expect("record contribution");
    }

    /// One Feed event on `scene:s1`. `commit_id` is what marks the write as
    /// belonging to an Application; `None` is an out-of-band edit.
    #[allow(clippy::too_many_arguments)]
    fn seed_feed_event(
        conn: &Connection,
        sequence: i64,
        commit_id: Option<&str>,
        changed_paths: &[&str],
        mutation_kind: &str,
    ) {
        seed_feed_event_for(
            conn,
            sequence,
            commit_id,
            changed_paths,
            mutation_kind,
            r#"{"kind":"scene","sceneId":"s1"}"#,
        );
    }

    /// The same, with the object key spelled out, for the kinds whose Feed
    /// spelling and ledger spelling are not the same string.
    #[allow(clippy::too_many_arguments)]
    fn seed_feed_event_for(
        conn: &Connection,
        sequence: i64,
        commit_id: Option<&str>,
        changed_paths: &[&str],
        mutation_kind: &str,
        object_key_json: &str,
    ) {
        let uid = format!("uid-{sequence}");
        conn.execute(
            "INSERT INTO change_events
                (event_uid, project_id, domain, op_type, payload, session_id,
                 sequence, timestamp, prev_hash, hash)
             VALUES (?1, 'p1', 'narrative', 'update', '{}', 'session-1', ?2, 0, '', ?1)",
            params![uid, sequence],
        )
        .expect("seed canonical change event");
        conn.execute(
            "INSERT INTO narrative_change_transactions
                (id, project_id, request_id, source_domain, source_change_event_uid,
                 source_change_event_sequence, cause_kind, origin, commit_id,
                 payload_digest, created_at)
             VALUES (?1, 'p1', ?1, 'test', ?2, ?3, 'forward', 'human', ?4, 'digest',
                     '2026-08-16T00:00:00.000Z')",
            params![format!("tx-{sequence}"), uid, sequence, commit_id],
        )
        .expect("seed narrative transaction");
        conn.execute(
            "INSERT INTO narrative_change_events
                (id, project_id, transaction_id, canonical_change_event_uid,
                 canonical_sequence, event_ordinal, object_key_json, change_kind,
                 mutation_kind, changed_paths_json, occurred_at)
             VALUES (?1, 'p1', ?2, ?3, ?4, 0, ?7, 'content', ?5, ?6,
                     '2026-08-16T00:00:00.000Z')",
            params![
                format!("ev-{sequence}"),
                format!("tx-{sequence}"),
                uid,
                sequence,
                mutation_kind,
                serde_json::to_string(changed_paths).expect("paths"),
                object_key_json,
            ],
        )
        .expect("seed narrative change event");
    }

    fn only_state(conn: &Connection) -> ContributionTargetState {
        let rows = list_contributions_for_target(conn, "p1", "scene:s1").expect("list");
        assert_eq!(rows.len(), 1);
        rows[0].target_state
    }

    /// Re-recording a Contribution puts `target_state` back to what the
    /// Application wrote, so the projection's watermark for the state it just
    /// discarded has to go with it.
    ///
    /// Keeping it left the row saying "as of event N the field was modified"
    /// while claiming `unchanged`, and the guard `COALESCE(
    /// target_state_sequence, -1) < N` then refused to re-apply event N --
    /// permanently. Rewinding the cursor does not help, because the refusal
    /// is in the row, which is why this test rewinds it and still expects the
    /// state to come back.
    #[test]
    fn re_recording_a_contribution_lets_the_projection_run_again() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                seed_feed_event(conn, 20, None, &["/title"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Modified);

                seed_application(conn, 10);
                let watermark: Option<i64> = conn.query_row(
                    "SELECT target_state_sequence FROM narrative_application_contributions
                      WHERE project_id = 'p1'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(
                    watermark, None,
                    "the watermark describes a state the re-record just replaced"
                );

                conn.execute(
                    "DELETE FROM narrative_change_cursors WHERE project_id = 'p1'",
                    [],
                )?;
                assert_eq!(
                    only_state(conn),
                    ContributionTargetState::Modified,
                    "the edit is still in the Feed, so a replay has to find it again"
                );
                Ok(())
            })
        })
        .expect("test body");
    }

    /// The Legacy Backfill sentinel is the other spelling of "the whole
    /// object", and a field-level hand edit has to reach it. Before the
    /// sentinel was recognised, only an event that had already collapsed to
    /// `/` could ever touch a backfilled row.
    #[test]
    fn a_field_edit_reaches_a_whole_object_sentinel_contribution() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('p1', 'Test')
                     ON CONFLICT(id) DO NOTHING",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_apply_commits
                        (id, project_id, request_id, plan_digest, status, created_at)
                     VALUES ('commit-1', 'p1', 'req-1', 'digest-1', 'applied',
                             '2026-08-15T00:00:00.000Z')
                     ON CONFLICT(id) DO NOTHING",
                    [],
                )?;
                record_contribution_in_tx(
                    conn,
                    "p1",
                    &ContributionProvenance {
                        application_id: "app-legacy",
                        commit_id: "commit-1",
                        proposal_id: "proposal-1",
                        revision_id: "revision-1",
                        operation_id: None,
                        baseline_sequence: Some(10),
                    },
                    &ContributionField {
                        target_object_identity: "scene:s1",
                        field_path: LEGACY_BACKFILL_FIELD_PATH,
                        target_state: ContributionTargetState::Unchanged,
                        authority: None,
                    },
                    "2026-08-15T00:00:00.000Z",
                )?;
                seed_feed_event(conn, 20, None, &["/title"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Modified);
                Ok(())
            })
        })
        .expect("test body");
    }

    /// A detail write is filed against the owning entry, because that is the
    /// grain `affected_fields` reports it at. The Feed addresses the same
    /// write as `codex-detail-value:<valueId>`, so without the matching
    /// projection on this side the identities never meet and a hand edit
    /// leaves the Contribution claiming the Application's value is intact.
    #[test]
    fn a_hand_edited_detail_value_reaches_its_entry_grain_contribution() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('p1', 'Test')
                     ON CONFLICT(id) DO NOTHING",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_apply_commits
                        (id, project_id, request_id, plan_digest, status, created_at)
                     VALUES ('commit-1', 'p1', 'req-1', 'digest-1', 'applied',
                             '2026-08-15T00:00:00.000Z')
                     ON CONFLICT(id) DO NOTHING",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO codex_entries (id, project_id, type, name)
                     VALUES ('e1', 'p1', 'character', 'Entry')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name)
                     VALUES ('def-1', 'p1', 'character', 'Detail')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO codex_detail_values (id, entry_id, definition_id, value)
                     VALUES ('v9', 'e1', 'def-1', 'x')",
                    [],
                )?;
                record_contribution_in_tx(
                    conn,
                    "p1",
                    &ContributionProvenance {
                        application_id: "app-1",
                        commit_id: "commit-1",
                        proposal_id: "proposal-1",
                        revision_id: "revision-1",
                        operation_id: None,
                        baseline_sequence: Some(10),
                    },
                    &ContributionField {
                        target_object_identity: "codex-entry:e1",
                        field_path: "/details/def-1",
                        target_state: ContributionTargetState::Unchanged,
                        authority: None,
                    },
                    "2026-08-15T00:00:00.000Z",
                )?;
                seed_feed_event_for(
                    conn,
                    20,
                    None,
                    &["/details/def-1"],
                    "update",
                    r#"{"kind":"codex-detail-value","valueId":"v9"}"#,
                );
                let rows =
                    list_contributions_for_target(conn, "p1", "codex-entry:e1").expect("list");
                assert_eq!(rows.len(), 1);
                assert_eq!(
                    rows[0].target_state,
                    ContributionTargetState::Modified,
                    "the Feed and the ledger have to agree on which object this write touched"
                );
                Ok(())
            })
        })
        .expect("test body");
    }

    /// The case the whole step exists for: someone edits the field by hand
    /// after the Application wrote it.
    #[test]
    fn an_out_of_band_edit_after_the_baseline_marks_the_field_modified() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                seed_feed_event(conn, 20, None, &["/title"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Modified);
                Ok(())
            })
        })
        .expect("test body");
    }

    /// The Application's own Apply, and the Undo or Redo of it, all stamp the
    /// same `commit_id`. Counting those here would double-count what the
    /// ledger's own axes already say -- and a `modified` taken from another
    /// Application's Apply would outlive that Application being undone,
    /// reporting an edit at the moment the field reverted.
    #[test]
    fn a_write_with_application_lineage_is_not_evidence() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                seed_feed_event(conn, 20, Some("commit-1"), &["/title"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Unchanged);
                Ok(())
            })
        })
        .expect("test body");
    }

    /// An event at or before the Application's own baseline is its own write
    /// arriving, not somebody else's.
    #[test]
    fn an_edit_at_or_before_the_baseline_is_not_evidence() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 20);
                seed_feed_event(conn, 10, None, &["/title"], "update");
                seed_feed_event(conn, 20, None, &["/title"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Unchanged);
                Ok(())
            })
        })
        .expect("test body");
    }

    #[test]
    fn an_edit_to_a_different_field_leaves_this_one_alone() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                seed_feed_event(conn, 20, None, &["/summary"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Unchanged);
                Ok(())
            })
        })
        .expect("test body");
    }

    /// Deleting the object is not an edit to the field -- there is no field
    /// left. `missing` says that; `modified` would imply it still exists.
    #[test]
    fn deleting_the_object_marks_the_field_missing() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                seed_feed_event(conn, 20, None, &["/"], "delete");
                assert_eq!(only_state(conn), ContributionTargetState::Missing);
                Ok(())
            })
        })
        .expect("test body");
    }

    /// Feed delivery is at-least-once, so the projection has to survive
    /// seeing the same event again. The cursor short-circuits the replay and
    /// `target_state_sequence` would refuse it even without the cursor.
    #[test]
    fn replaying_the_projection_changes_nothing() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                seed_feed_event(conn, 20, None, &["/title"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Modified);

                let again = project_out_of_band_edits_in_tx(conn, "p1").expect("second pass");
                assert_eq!(again, 0, "an acknowledged event must not be reprocessed");
                assert_eq!(only_state(conn), ContributionTargetState::Modified);
                Ok(())
            })
        })
        .expect("test body");
    }

    /// A journal-derived event collapses to `/` even for an update, so the
    /// whole object is treated as touched. Over-marking is the safe direction
    /// for a state that claims "something else may have written here".
    #[test]
    fn a_whole_object_path_covers_every_field() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                seed_feed_event(conn, 20, None, &["/"], "update");
                assert_eq!(only_state(conn), ContributionTargetState::Modified);
                Ok(())
            })
        })
        .expect("test body");
    }

    /// The cursor has to clear events this projection deliberately ignores,
    /// or it parks behind the newest one and rescans the same window on every
    /// read for the life of the workspace.
    #[test]
    fn the_cursor_clears_events_that_are_not_evidence() {
        let db = test_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                seed_application(conn, 10);
                // Belongs to an Application, so it is not evidence -- but it is
                // still the newest thing in the window.
                seed_feed_event(conn, 20, Some("commit-1"), &["/title"], "update");

                let first = project_out_of_band_edits_in_tx(conn, "p1").expect("first pump");
                assert_eq!(first, 0, "nothing to project");

                let second = project_out_of_band_edits_in_tx(conn, "p1").expect("second pump");
                assert_eq!(second, 0);
                let acknowledged = get_cursor(conn, "p1", CONSUMER_ID)
                    .expect("cursor")
                    .expect("cursor row")
                    .acknowledged_through_sequence;
                assert_eq!(
                    acknowledged, 20,
                    "the ignored event must be acknowledged, not rescanned forever"
                );
                Ok(())
            })
        })
        .expect("test body");
    }

    #[test]
    fn overlap_is_segment_aware_in_both_directions() {
        assert!(paths_overlap("/", "/anything"));
        assert!(paths_overlap("/anything", "/"));
        assert!(paths_overlap("/details", "/details"));
        assert!(
            paths_overlap("/details", "/details/def-1"),
            "an edit to the container covers the field inside it"
        );
        assert!(
            paths_overlap("/details/def-1", "/details"),
            "an edit inside the container covers a Contribution recorded on it"
        );
        assert!(
            !paths_overlap("/detail", "/details"),
            "a raw string prefix must not count: /detail is a different field"
        );
        assert!(!paths_overlap("/title", "/summary"));
    }
}
