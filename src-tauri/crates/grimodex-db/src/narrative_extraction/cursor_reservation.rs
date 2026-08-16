//! Change Feed consumer cursor reservation (Gate C2 Lane I, SCHEMA_VERSION 23
//! `narrative_change_cursors` reservation columns —
//! `semantic_epoch_id`/`reserved_through_sequence`/`active_run_id`; see
//! `migrate_narrative_change_cursors_v23` in `migrate.rs`).
//!
//! A Change Feed consumer's cursor row already tracked
//! `acknowledged_through_sequence` plus a `lease_owner`/`lease_expires_at`
//! pair that serializes concurrent extraction against the same consumer
//! (Gate C0/C1). This module adds the missing middle step: a Run that wants
//! to process an unacknowledged range first *reserves* it
//! (`reserve_cursor_range_in_tx`), so a second Run for the same consumer can
//! see — before doing any work — that the range is already spoken for.
//! `acknowledge_cursor_in_tx` both advances `acknowledged_through_sequence`
//! and releases the reservation in one statement, so a cursor row is never
//! observed "acknowledged past the old cursor but still reserved".
//!
//! Distinct from `change_feed::acknowledge_cursor_in_tx` (Gate C0/C1,
//! ack-only, no reservation awareness — the pre-C2 write path some
//! consumers still use): this module's `acknowledge_cursor_in_tx` also
//! clears `active_run_id`/`reserved_through_sequence`/`semantic_epoch_id`
//! back to NULL, and stamps its own `updated_at` rather than taking one as
//! a parameter. Both live under `narrative_change_cursors` and remain safe
//! to mix — a pre-C2 consumer that only ever calls the `change_feed`
//! version keeps its reservation columns NULL forever, exactly as
//! `migrate_narrative_change_cursors_v23` leaves them.
//!
//! `reclaim_stale_reservation_in_tx` is the other half: the startup-time
//! Lease re-acquisition rule that lets a process which already holds this
//! workspace's `WorkspaceLease` (`workspace_lease.rs`) take back a cursor
//! row's lease without waiting out `lease_expires_at`, when the row's
//! reservation still matches the Run that process is resuming. See that
//! function's doc comment for the exact contract and the five conditions it
//! checks.
//!
//! Nothing in production code calls any of this yet — same Wave 2 status as
//! Wave 1's Lane A/Lane B: no IPC/N-API entrypoint exists, so every item
//! here is reachable only from this module's own tests until a later
//! Transport Assembly pass wires up a caller. That is also why this module
//! silences `dead_code` at module scope (mirroring `execution_state.rs`)
//! rather than sprinkling per-item `#[allow(dead_code)]`.
#![allow(dead_code)]

use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CursorRow {
    pub project_id: String,
    pub consumer_id: String,
    pub acknowledged_through_sequence: i64,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
    pub semantic_epoch_id: Option<String>,
    pub reserved_through_sequence: Option<i64>,
    pub active_run_id: Option<String>,
}

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    Ok(())
}

fn now_string() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Reserve `[acknowledged_through_sequence, reserved_through_sequence]` on a
/// Change Feed consumer's cursor row for `active_run_id`, UPSERTing the row
/// if this is the consumer's first reservation. Only the reservation
/// columns (`semantic_epoch_id`, `reserved_through_sequence`,
/// `active_run_id`) and `updated_at` are written —
/// `acknowledged_through_sequence`/`lease_owner`/`lease_expires_at` on an
/// existing row are left exactly as they were.
///
/// Fails closed (`NEX_CURSOR_RESERVATION_INVALID`) before issuing any SQL
/// when `reserved_through_sequence` is negative or behind the row's current
/// `acknowledged_through_sequence` — both would otherwise trip the table's
/// `CHECK(reserved_through_sequence IS NULL OR reserved_through_sequence >=
/// acknowledged_through_sequence)` constraint (SCHEMA_VERSION 23) and
/// surface as an opaque SQLite constraint error instead of a diagnosable
/// one. Serializing concurrent reservations for the same consumer is the
/// caller's responsibility (the existing cursor-row lease, or a
/// caller-owned `BEGIN IMMEDIATE` — see `task_leases::with_immediate_transaction`).
///
/// Callers own the surrounding `BEGIN`/`COMMIT`.
pub(crate) fn reserve_cursor_range_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
    semantic_epoch_id: &str,
    active_run_id: &str,
    reserved_through_sequence: i64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed cursor reservation requires a caller-owned transaction"
    );
    require_non_empty(project_id, "projectId")?;
    require_non_empty(consumer_id, "consumerId")?;
    require_non_empty(semantic_epoch_id, "semanticEpochId")?;
    require_non_empty(active_run_id, "activeRunId")?;
    anyhow::ensure!(
        reserved_through_sequence >= 0,
        "NEX_CURSOR_RESERVATION_INVALID: reservedThroughSequence must not be negative"
    );

    let acknowledged_through_sequence: i64 = conn
        .query_row(
            "SELECT acknowledged_through_sequence
               FROM narrative_change_cursors
              WHERE project_id = ?1 AND consumer_id = ?2",
            params![project_id, consumer_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    anyhow::ensure!(
        reserved_through_sequence >= acknowledged_through_sequence,
        "NEX_CURSOR_RESERVATION_INVALID: reservedThroughSequence {reserved_through_sequence} is \
         behind acknowledgedThroughSequence {acknowledged_through_sequence} for consumer \
         '{consumer_id}' in project '{project_id}'"
    );

    let updated_at = now_string();
    conn.execute(
        "INSERT INTO narrative_change_cursors (
            project_id, consumer_id, acknowledged_through_sequence, updated_at,
            semantic_epoch_id, reserved_through_sequence, active_run_id
         ) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6)
         ON CONFLICT(project_id, consumer_id) DO UPDATE SET
            semantic_epoch_id = excluded.semantic_epoch_id,
            reserved_through_sequence = excluded.reserved_through_sequence,
            active_run_id = excluded.active_run_id,
            updated_at = excluded.updated_at",
        params![
            project_id,
            consumer_id,
            updated_at,
            semantic_epoch_id,
            reserved_through_sequence,
            active_run_id,
        ],
    )?;
    Ok(())
}

/// Confirm a reservation: advance `acknowledged_through_sequence` to
/// `max(current, through_sequence)` (never move it backward) and release
/// the reservation — `active_run_id`/`reserved_through_sequence`/
/// `semantic_epoch_id` all go back to NULL in the same statement, so the
/// row is never observably "acknowledged but still reserved". Safe to call
/// on a row with no active reservation (those columns are already NULL and
/// stay NULL); this is also the correct way to release a reservation
/// without net new progress by passing the row's own current
/// `acknowledged_through_sequence`.
///
/// Fails (`NEX_CURSOR_ACK_NOT_FOUND`) if no cursor row exists for
/// `(project_id, consumer_id)` — acknowledging a consumer that has never
/// been observed is a caller bug, not a no-op.
///
/// Callers own the surrounding `BEGIN`/`COMMIT`.
pub(crate) fn acknowledge_cursor_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
    through_sequence: i64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed cursor acknowledgement requires a caller-owned transaction"
    );
    require_non_empty(project_id, "projectId")?;
    require_non_empty(consumer_id, "consumerId")?;
    anyhow::ensure!(
        through_sequence >= 0,
        "NEX_CURSOR_RESERVATION_INVALID: throughSequence must not be negative"
    );

    let updated_at = now_string();
    let updated = conn.execute(
        "UPDATE narrative_change_cursors
            SET acknowledged_through_sequence = MAX(acknowledged_through_sequence, ?1),
                semantic_epoch_id = NULL,
                reserved_through_sequence = NULL,
                active_run_id = NULL,
                updated_at = ?2
          WHERE project_id = ?3 AND consumer_id = ?4",
        params![through_sequence, updated_at, project_id, consumer_id],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_CURSOR_ACK_NOT_FOUND: no cursor row for consumer '{consumer_id}' in project \
         '{project_id}'"
    );
    Ok(())
}

/// CAS-checked confirm-and-release, for a publish that must prove its
/// reservation is still the one live on the cursor row before it is allowed
/// to advance `acknowledged_through_sequence` at all.
///
/// [`acknowledge_cursor_in_tx`] above trusts its caller: it advances the
/// cursor unconditionally once `(project_id, consumer_id)` resolves to a
/// row, with no check that the caller is the reservation currently holding
/// that row. That is fine for a caller with no reservation to prove (a
/// pre-C2 consumer, or a deliberate manual override) but wrong for a Run
/// racing a Semantic Epoch rotation: if a Restore mints a new Epoch and a
/// second Run reserves a fresh range against it while an *older* Run (still
/// holding stale, already-evaluated results from the previous Epoch) is
/// mid-publish, an unconditional ack would let that stale Run both
/// overwrite `narrative_consumer_freshness` with outdated results and
/// silently delete the second Run's own live reservation out from under it
/// — the exact hazard Semantic Epochs exist to prevent.
///
/// This function instead folds the same identity check into the `UPDATE
/// ... WHERE` itself: the row is only touched when it is still reserved for
/// `run_id`, at `semantic_epoch_id`, through exactly `through_sequence` --
/// a publish acknowledges exactly the range it reserved, never a partial or
/// extended one, so one value serves both as the CAS match and the new
/// acknowledged point. A row that has moved on (reserved by a different
/// Run, at a different Epoch, or a different range) matches zero rows;
/// `updated == 0` fails closed rather than silently no-op-ing, so a caller
/// that reaches this function believing it holds a reservation never
/// mistakes "my ack did nothing" for "my ack succeeded".
///
/// Callers own the surrounding `BEGIN`/`COMMIT`.
pub(crate) fn acknowledge_cursor_reservation_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
    run_id: &str,
    semantic_epoch_id: &str,
    through_sequence: i64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed cursor acknowledgement requires a caller-owned transaction"
    );
    require_non_empty(project_id, "projectId")?;
    require_non_empty(consumer_id, "consumerId")?;
    require_non_empty(run_id, "runId")?;
    require_non_empty(semantic_epoch_id, "semanticEpochId")?;
    anyhow::ensure!(
        through_sequence >= 0,
        "NEX_CURSOR_RESERVATION_INVALID: throughSequence must not be negative"
    );

    let updated_at = now_string();
    let updated = conn.execute(
        "UPDATE narrative_change_cursors
            SET acknowledged_through_sequence = MAX(acknowledged_through_sequence, ?1),
                semantic_epoch_id = NULL,
                reserved_through_sequence = NULL,
                active_run_id = NULL,
                updated_at = ?2
          WHERE project_id = ?3
            AND consumer_id = ?4
            AND active_run_id = ?5
            AND semantic_epoch_id = ?6
            AND reserved_through_sequence = ?1",
        params![
            through_sequence,
            updated_at,
            project_id,
            consumer_id,
            run_id,
            semantic_epoch_id,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_CURSOR_RESERVATION_STALE: cursor for consumer '{consumer_id}' in project \
         '{project_id}' is no longer reserved for run '{run_id}' at epoch \
         '{semantic_epoch_id}' through sequence {through_sequence} -- another Run or \
         Semantic Epoch rotation has moved past this reservation"
    );
    Ok(())
}

/// Startup-time Lease re-acquisition: recover a cursor row's
/// `lease_owner`/`lease_expires_at` without waiting out the normal TTL,
/// when this process can prove — by already holding this workspace's
/// `WorkspaceLease` (`workspace_lease.rs`) — that it, not some other live
/// process, is the one resuming the reservation the row still carries.
///
/// **Contract**: this function does not itself check that the caller holds
/// a `WorkspaceLease` — the caller must already hold one (any `LeaseMode`)
/// before calling this. Holding a `WorkspaceLease` is what makes it safe to
/// bypass the row's `lease_expires_at`: while that lease is held, no other
/// process can be mid-restore/migration/atomic-replace of this workspace,
/// so a `narrative_change_cursors` row observed here cannot be concurrently
/// mutated by another process's fresh open of the *same* workspace either —
/// only this process's own prior run of itself could have written it.
/// Verifying that precondition is the caller's responsibility; this
/// function only encodes the five row-level conditions that license the
/// bypass once it holds:
///
/// 1. The row's `active_run_id` equals `run_id`.
/// 2. That Run is resumable: `narrative_extraction_runs.status` for
///    `run_id` is `pending` or `running` (Lane B's
///    `NarrativeRunStatus::is_terminal` would say `false`).
/// 3. That Run belongs to `project_id`.
/// 4. The row's `semantic_epoch_id` equals `semantic_epoch_id`.
/// 5. The row's `reserved_through_sequence` equals `reserved_through_sequence`.
///
/// All five are expressed as one `UPDATE ... WHERE` — a partial match
/// touches zero rows, never a partial write. On a full match, the row's
/// lease is taken over (`lease_owner = current_owner`,
/// `lease_expires_at = new_lease_expiry`) and this returns `Ok(true)`. On
/// no match this returns `Ok(false)` — the caller has not proven it may
/// bypass the TTL, and must fall back to the normal path: wait for
/// `lease_expires_at` like any other lease claim.
///
/// Callers own the surrounding `BEGIN`/`COMMIT`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn reclaim_stale_reservation_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
    current_owner: &str,
    run_id: &str,
    semantic_epoch_id: &str,
    reserved_through_sequence: i64,
    new_lease_expiry: &str,
) -> anyhow::Result<bool> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed cursor reclaim requires a caller-owned transaction"
    );
    require_non_empty(project_id, "projectId")?;
    require_non_empty(consumer_id, "consumerId")?;
    require_non_empty(current_owner, "currentOwner")?;
    require_non_empty(run_id, "runId")?;
    require_non_empty(semantic_epoch_id, "semanticEpochId")?;
    require_non_empty(new_lease_expiry, "newLeaseExpiry")?;
    anyhow::ensure!(
        reserved_through_sequence >= 0,
        "NEX_CURSOR_RESERVATION_INVALID: reservedThroughSequence must not be negative"
    );

    let updated = conn.execute(
        "UPDATE narrative_change_cursors
            SET lease_owner = ?1,
                lease_expires_at = ?2,
                updated_at = ?3
          WHERE project_id = ?4
            AND consumer_id = ?5
            AND active_run_id = ?6
            AND semantic_epoch_id = ?7
            AND reserved_through_sequence = ?8
            AND EXISTS (
              SELECT 1 FROM narrative_extraction_runs
               WHERE id = ?6
                 AND project_id = ?4
                 AND status IN ('pending', 'running')
            )",
        params![
            current_owner,
            new_lease_expiry,
            now_string(),
            project_id,
            consumer_id,
            run_id,
            semantic_epoch_id,
            reserved_through_sequence,
        ],
    )?;
    Ok(updated == 1)
}

/// Read a Change Feed consumer's cursor row, if one has ever been written
/// for `(project_id, consumer_id)`.
pub(crate) fn get_cursor(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
) -> anyhow::Result<Option<CursorRow>> {
    conn.query_row(
        "SELECT project_id, consumer_id, acknowledged_through_sequence, lease_owner,
                lease_expires_at, last_error, updated_at, semantic_epoch_id,
                reserved_through_sequence, active_run_id
           FROM narrative_change_cursors
          WHERE project_id = ?1 AND consumer_id = ?2",
        params![project_id, consumer_id],
        |row| {
            Ok(CursorRow {
                project_id: row.get(0)?,
                consumer_id: row.get(1)?,
                acknowledged_through_sequence: row.get(2)?,
                lease_owner: row.get(3)?,
                lease_expires_at: row.get(4)?,
                last_error: row.get(5)?,
                updated_at: row.get(6)?,
                semantic_epoch_id: row.get(7)?,
                reserved_through_sequence: row.get(8)?,
                active_run_id: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::create_epoch_in_tx;
    use crate::narrative_extraction::task_leases::with_immediate_transaction;
    use crate::Database;

    fn open_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate to current schema");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Other Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed projects");
        db
    }

    fn insert_run(conn: &Connection, run_id: &str, project_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, version)
             VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', 'digest-1',
                     ?3, '{}', datetime('now'), 0)",
            params![run_id, project_id, status],
        )
        .expect("insert run");
    }

    fn create_epoch(conn: &Connection, project_id: &str) -> String {
        create_epoch_in_tx(conn, project_id, "initial", None).expect("create epoch")
    }

    #[test]
    fn reserve_then_acknowledge_round_trips() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");

            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reserved = get_cursor(conn, "project-1", "consumer-a")?.expect("row exists");
            assert_eq!(reserved.acknowledged_through_sequence, 0);
            assert_eq!(
                reserved.semantic_epoch_id.as_deref(),
                Some(epoch_id.as_str())
            );
            assert_eq!(reserved.reserved_through_sequence, Some(10));
            assert_eq!(reserved.active_run_id.as_deref(), Some("run-1"));

            with_immediate_transaction(conn, |conn| {
                acknowledge_cursor_in_tx(conn, "project-1", "consumer-a", 10)
            })?;

            let acknowledged = get_cursor(conn, "project-1", "consumer-a")?.expect("row exists");
            assert_eq!(acknowledged.acknowledged_through_sequence, 10);
            assert_eq!(acknowledged.semantic_epoch_id, None);
            assert_eq!(acknowledged.reserved_through_sequence, None);
            assert_eq!(acknowledged.active_run_id, None);
            Ok(())
        })
        .expect("reserve/ack round trip succeeds");
    }

    #[test]
    fn acknowledge_never_moves_the_cursor_backward() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;
            with_immediate_transaction(conn, |conn| {
                acknowledge_cursor_in_tx(conn, "project-1", "consumer-a", 10)
            })?;

            // A second, stale acknowledgement for an earlier sequence must
            // not regress the cursor.
            with_immediate_transaction(conn, |conn| {
                acknowledge_cursor_in_tx(conn, "project-1", "consumer-a", 3)
            })?;
            let row = get_cursor(conn, "project-1", "consumer-a")?.expect("row exists");
            assert_eq!(row.acknowledged_through_sequence, 10);
            Ok(())
        })
        .expect("stale ack is a no-op on the sequence");
    }

    #[test]
    fn reserve_rejects_reserved_through_behind_acknowledged_through_before_hitting_sql() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            // Advance acknowledged_through_sequence to 20 first via a
            // reserve/ack round trip.
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 20)
            })?;
            with_immediate_transaction(conn, |conn| {
                acknowledge_cursor_in_tx(conn, "project-1", "consumer-a", 20)
            })?;

            // A reservation ending before the already-acknowledged point
            // would violate CHECK(reserved_through_sequence >=
            // acknowledged_through_sequence) if it ever reached SQLite; it
            // must instead be rejected by the Rust-side guard first.
            let error = with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 5)
            })
            .expect_err("must fail closed before issuing SQL");
            assert!(
                error
                    .to_string()
                    .starts_with("NEX_CURSOR_RESERVATION_INVALID"),
                "unexpected error: {error}"
            );

            // The row must be untouched by the rejected reservation.
            let row = get_cursor(conn, "project-1", "consumer-a")?.expect("row exists");
            assert_eq!(row.acknowledged_through_sequence, 20);
            assert_eq!(row.active_run_id, None);
            Ok(())
        })
        .expect("query after rejected reservation");
    }

    #[test]
    fn reserve_rejects_negative_reserved_through_before_hitting_sql() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            let error = with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", -1)
            })
            .expect_err("negative reservation must be rejected");
            assert!(error
                .to_string()
                .starts_with("NEX_CURSOR_RESERVATION_INVALID"));
            assert!(get_cursor(conn, "project-1", "consumer-a")?.is_none());
            Ok(())
        })
        .expect("query after rejected reservation");
    }

    #[test]
    fn reclaim_succeeds_when_all_five_conditions_match() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "pending");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "process-b",
                    "run-1",
                    &epoch_id,
                    10,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(reclaimed, "all five conditions match, reclaim must succeed");

            let row = get_cursor(conn, "project-1", "consumer-a")?.expect("row exists");
            assert_eq!(row.lease_owner.as_deref(), Some("process-b"));
            assert_eq!(
                row.lease_expires_at.as_deref(),
                Some("2099-01-01T00:00:00.000Z")
            );
            // Reclaim must not disturb the reservation itself.
            assert_eq!(row.active_run_id.as_deref(), Some("run-1"));
            assert_eq!(row.reserved_through_sequence, Some(10));
            Ok(())
        })
        .expect("reclaim succeeds");
    }

    #[test]
    fn reclaim_running_run_also_succeeds() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "process-b",
                    "run-1",
                    &epoch_id,
                    10,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(reclaimed, "running is resumable, reclaim must succeed");
            Ok(())
        })
        .expect("reclaim succeeds");
    }

    #[test]
    fn reclaim_fails_on_run_id_mismatch() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            insert_run(conn, "run-2", "project-1", "running");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "process-b",
                    "run-2",
                    &epoch_id,
                    10,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(!reclaimed, "active_run_id mismatch must fail closed");

            let row = get_cursor(conn, "project-1", "consumer-a")?.expect("row exists");
            assert_eq!(
                row.lease_owner, None,
                "failed reclaim must not touch the lease"
            );
            Ok(())
        })
        .expect("reclaim fails closed");
    }

    #[test]
    fn reclaim_fails_on_epoch_mismatch() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            let other_epoch_id = create_epoch_in_tx(conn, "project-1", "restore", None)?;
            insert_run(conn, "run-1", "project-1", "running");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "process-b",
                    "run-1",
                    &other_epoch_id,
                    10,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(!reclaimed, "semantic_epoch_id mismatch must fail closed");
            Ok(())
        })
        .expect("reclaim fails closed");
    }

    #[test]
    fn reclaim_fails_on_reserved_through_mismatch() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "process-b",
                    "run-1",
                    &epoch_id,
                    11,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(
                !reclaimed,
                "reserved_through_sequence mismatch must fail closed"
            );
            Ok(())
        })
        .expect("reclaim fails closed");
    }

    #[test]
    fn reclaim_fails_when_run_is_not_resumable() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "completed");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "process-b",
                    "run-1",
                    &epoch_id,
                    10,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(
                !reclaimed,
                "a terminal run is not resumable, must fail closed"
            );
            Ok(())
        })
        .expect("reclaim fails closed");
    }

    #[test]
    fn reclaim_fails_when_run_belongs_to_a_different_project() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            // Adversarial/corrupt-data setup: the reserved run's own
            // project_id does not match the project the cursor row (and
            // the reclaim call) live under.
            insert_run(conn, "run-1", "project-2", "running");
            with_immediate_transaction(conn, |conn| {
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 10)
            })?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "process-b",
                    "run-1",
                    &epoch_id,
                    10,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(!reclaimed, "project mismatch must fail closed");
            Ok(())
        })
        .expect("reclaim fails closed");
    }

    #[test]
    fn reclaim_fails_when_no_reservation_exists() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            // Pre-C2-shaped row: acknowledged only, no reservation ever
            // taken (active_run_id/reserved_through_sequence/semantic_epoch_id
            // stay NULL, as migrate_narrative_change_cursors_v23 leaves
            // them for a legacy consumer).
            conn.execute(
                "INSERT INTO narrative_change_cursors
                    (project_id, consumer_id, acknowledged_through_sequence, updated_at)
                 VALUES ('project-1', 'legacy-consumer', 5, datetime('now'))",
                [],
            )?;

            let reclaimed = with_immediate_transaction(conn, |conn| {
                reclaim_stale_reservation_in_tx(
                    conn,
                    "project-1",
                    "legacy-consumer",
                    "process-b",
                    "run-1",
                    &epoch_id,
                    10,
                    "2099-01-01T00:00:00.000Z",
                )
            })?;
            assert!(
                !reclaimed,
                "a NULL active_run_id can never equal a real runId, must fail closed"
            );

            with_immediate_transaction(conn, |conn| {
                acknowledge_cursor_in_tx(conn, "project-1", "legacy-consumer", 7)
            })?;
            let row = get_cursor(conn, "project-1", "legacy-consumer")?.expect("row exists");
            assert_eq!(row.acknowledged_through_sequence, 7);
            assert_eq!(row.semantic_epoch_id, None);
            assert_eq!(row.reserved_through_sequence, None);
            assert_eq!(row.active_run_id, None);
            Ok(())
        })
        .expect("pre-C2 consumer is unaffected by reservation logic");
    }

    #[test]
    fn acknowledge_fails_when_no_cursor_row_exists() {
        let db = open_db();
        db.with_conn(|conn| {
            let error = with_immediate_transaction(conn, |conn| {
                acknowledge_cursor_in_tx(conn, "project-1", "never-seen", 1)
            })
            .expect_err("acknowledging an unknown consumer is a caller bug");
            assert!(error.to_string().starts_with("NEX_CURSOR_ACK_NOT_FOUND"));
            Ok(())
        })
        .expect("query after rejected ack");
    }

    #[test]
    fn get_cursor_is_none_before_any_row_exists() {
        let db = open_db();
        db.with_conn(|conn| {
            assert!(get_cursor(conn, "project-1", "consumer-a")?.is_none());
            Ok(())
        })
        .expect("read absent cursor");
    }

    #[test]
    fn mutating_functions_require_a_caller_owned_transaction() {
        let db = open_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch(conn, "project-1");
            insert_run(conn, "run-1", "project-1", "running");
            assert!(conn.is_autocommit());

            let reserve_error =
                reserve_cursor_range_in_tx(conn, "project-1", "consumer-a", &epoch_id, "run-1", 1)
                    .expect_err("reserve outside a transaction must be rejected");
            assert!(reserve_error
                .to_string()
                .contains("caller-owned transaction"));

            let ack_error = acknowledge_cursor_in_tx(conn, "project-1", "consumer-a", 1)
                .expect_err("acknowledge outside a transaction must be rejected");
            assert!(ack_error.to_string().contains("caller-owned transaction"));

            let reclaim_error = reclaim_stale_reservation_in_tx(
                conn,
                "project-1",
                "consumer-a",
                "process-b",
                "run-1",
                &epoch_id,
                1,
                "2099-01-01T00:00:00.000Z",
            )
            .expect_err("reclaim outside a transaction must be rejected");
            assert!(reclaim_error
                .to_string()
                .contains("caller-owned transaction"));
            Ok(())
        })
        .expect("autocommit guard checks run outside any transaction");
    }
}
