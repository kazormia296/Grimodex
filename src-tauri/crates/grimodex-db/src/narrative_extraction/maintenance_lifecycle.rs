//! Crate-private lifecycle authority for automatic Narrative Maintenance.
//!
//! C2-5B maintenance Runs own exactly one Task and one Attempt.  The owner
//! creates those three rows in the same transaction and terminalizes them as
//! one unit; the generic repository task APIs deliberately remain outside
//! this boundary.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::repository::SystemRunWorkKeyReuse;
    use crate::narrative_extraction::task_leases::with_immediate_transaction;
    use crate::Database;
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::path::Path;

    fn open_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate current schema");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Maintenance')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        db
    }

    fn work(run_kind: &str) -> (&'static str, &'static str) {
        match run_kind {
            "backfill" => ("epoch-1", "legacy-dependency-backfill:v2"),
            "dependency-verify" => ("epoch-1", "dependency-verify:epoch-1"),
            "semantic-index-rebuild" => ("epoch-1", "dependency-rebuild-derived"),
            other => panic!("unsupported maintenance kind: {other}"),
        }
    }

    fn create(
        conn: &Connection,
        run_kind: &str,
    ) -> anyhow::Result<MaintenanceRunHandle> {
        let (epoch_id, work_key) = work(run_kind);
        create_maintenance_run_in_tx(
            conn,
            "project-1",
            run_kind,
            epoch_id,
            work_key,
            &json!({ "sealed": run_kind }),
            "sha256:maintenance-test",
            SystemRunWorkKeyReuse::RunningOnly,
        )
    }

    #[test]
    fn fresh_maintenance_run_has_exactly_one_running_task_and_attempt_one() {
        let db = open_db();
        for (index, run_kind) in [
            "backfill",
            "dependency-verify",
            "semantic-index-rebuild",
        ]
        .into_iter()
        .enumerate()
        {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES (?1, 'project-1', ?2, 'initial', ?3)",
                    params![
                        format!("epoch-{}", index + 1),
                        index as i64,
                        format!("2026-08-23T00:00:0{index}.000Z")
                    ],
                )?;
                let handle = create(conn, run_kind)?;
                let (task_count, attempt_count, task_status, attempt_status, attempt_number): (
                    i64,
                    i64,
                    String,
                    String,
                    i64,
                ) = conn.query_row(
                    "SELECT
                         (SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = ?1),
                         (SELECT COUNT(*)
                            FROM narrative_extraction_attempts a
                            JOIN narrative_extraction_tasks t ON t.id = a.task_id
                           WHERE t.run_id = ?1),
                         (SELECT status FROM narrative_extraction_tasks WHERE id = ?2),
                         (SELECT status FROM narrative_extraction_attempts WHERE id = ?3),
                         (SELECT attempt_number FROM narrative_extraction_attempts WHERE id = ?3)",
                    params![handle.run_id, handle.task_id, handle.attempt_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )?;
                assert_eq!(task_count, 1);
                assert_eq!(attempt_count, 1);
                assert_eq!(task_status, "running");
                assert_eq!(attempt_status, "running");
                assert_eq!(attempt_number, 1);
                Ok(())
            })
            .expect("create maintenance lifecycle");
        }
    }

    #[test]
    fn reuse_validates_exact_ownership_and_never_duplicates() {
        let db = open_db();
        db.with_conn(|conn| {
            let first = create(conn, "backfill")?;
            let second = create(conn, "backfill")?;
            assert!(second.reused);
            assert_eq!(second.run_id, first.run_id);
            assert_eq!(second.task_id, first.task_id);
            assert_eq!(second.attempt_id, first.attempt_id);

            conn.execute(
                "UPDATE narrative_extraction_tasks SET task_kind = 'wrong-owner' WHERE id = ?1",
                params![first.task_id],
            )?;
            let error = create(conn, "backfill").expect_err("wrong task owner must fail closed");
            assert!(error
                .to_string()
                .contains("NEX_MAINTENANCE_LIFECYCLE_OWNERSHIP_INVALID"));
            Ok(())
        })
        .expect("reuse validation");
    }

    #[test]
    fn creation_rolls_back_run_task_and_attempt_together() {
        let db = open_db();
        db.with_conn(|conn| {
            let error = with_immediate_transaction(conn, |conn| {
                let _ = create(conn, "backfill")?;
                anyhow::bail!("force lifecycle transaction rollback")
            })
            .expect_err("forced rollback");
            assert!(error.to_string().contains("force lifecycle transaction rollback"));

            let counts: (i64, i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_extraction_runs),
                    (SELECT COUNT(*) FROM narrative_extraction_tasks),
                    (SELECT COUNT(*) FROM narrative_extraction_attempts)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(counts, (0, 0, 0));
            Ok(())
        })
        .expect("rollback leaves no lifecycle rows");
    }

    #[test]
    fn success_terminalizer_transitions_attempt_task_and_run_at_one_timestamp() {
        let db = open_db();
        db.with_conn(|conn| {
            let handle = create(conn, "backfill")?;
            let completed_at = complete_maintenance_run_in_tx(conn, &handle)?;
            let (run_status, task_status, attempt_status, run_at, task_at, attempt_at): (
                String,
                String,
                String,
                String,
                String,
                String,
            ) = conn.query_row(
                "SELECT r.status, t.status, a.status,
                        r.completed_at, t.completed_at, a.completed_at
                   FROM narrative_extraction_runs r
                   JOIN narrative_extraction_tasks t ON t.run_id = r.id
                   JOIN narrative_extraction_attempts a ON a.task_id = t.id
                  WHERE r.id = ?1",
                params![handle.run_id],
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
            assert_eq!(run_status, "completed");
            assert_eq!(task_status, "completed");
            assert_eq!(attempt_status, "completed");
            assert_eq!(run_at, completed_at);
            assert_eq!(task_at, completed_at);
            assert_eq!(attempt_at, completed_at);
            Ok(())
        })
        .expect("success terminalization");
    }

    #[test]
    fn failure_terminalizer_persists_exact_retryable_and_manual_metadata() {
        let db = open_db();
        db.with_conn(|conn| {
            let retryable = create(conn, "backfill")?;
            fail_maintenance_run_in_tx(
                conn,
                &retryable,
                MaintenanceFailureKind::Transient,
                "transient I/O",
            )?;
            let retry_metadata: (String, String, String, Option<String>) = conn.query_row(
                "SELECT failure_code, retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts WHERE id = ?1",
                params![retryable.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(retry_metadata.0, "NEX_MAINTENANCE_TRANSIENT");
            assert_eq!(retry_metadata.1, "retryable");
            assert_eq!(retry_metadata.2, "v1");
            assert!(retry_metadata.3.is_some());

            let manual = create(conn, "dependency-verify")?;
            fail_maintenance_run_in_tx(
                conn,
                &manual,
                MaintenanceFailureKind::Manual,
                "contract violation",
            )?;
            let manual_metadata: (String, String, String, Option<String>) = conn.query_row(
                "SELECT failure_code, retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts WHERE id = ?1",
                params![manual.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                manual_metadata.0,
                "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"
            );
            assert_eq!(manual_metadata.1, "manual");
            assert_eq!(manual_metadata.2, "v1");
            assert_eq!(manual_metadata.3, None);
            Ok(())
        })
        .expect("failure metadata");
    }

    #[test]
    fn foreground_hold_keeps_all_rows_running_until_exact_release() {
        let db = open_db();
        db.with_conn(|conn| {
            let handle = create(conn, "semantic-index-rebuild")?;
            hold_maintenance_run_in_tx(conn, &handle)?;
            let statuses: (String, String, String) = conn.query_row(
                "SELECT r.status, t.status, a.status
                   FROM narrative_extraction_runs r
                   JOIN narrative_extraction_tasks t ON t.run_id = r.id
                   JOIN narrative_extraction_attempts a ON a.task_id = t.id
                  WHERE r.id = ?1",
                params![handle.run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(statuses, ("running".into(), "running".into(), "running".into()));
            release_foreground_maintenance_run_in_tx(conn, &handle)?;
            Ok(())
        })
        .expect("foreground hold/release");
    }

    #[test]
    fn interruption_fails_old_lifecycle_then_new_run_reuses_sealed_work_distinctly() {
        let db = open_db();
        db.with_conn(|conn| {
            let old = create(conn, "dependency-verify")?;
            fail_maintenance_run_in_tx(
                conn,
                &old,
                MaintenanceFailureKind::Interrupted,
                "process interruption",
            )?;
            let replacement = create(conn, "dependency-verify")?;
            assert!(!replacement.reused);
            assert_ne!(replacement.run_id, old.run_id);
            assert_ne!(replacement.task_id, old.task_id);
            assert_ne!(replacement.attempt_id, old.attempt_id);

            let old_metadata: (String, String, String, Option<String>) = conn.query_row(
                "SELECT failure_code, retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts WHERE id = ?1",
                params![old.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(old_metadata.0, "NEX_MAINTENANCE_INTERRUPTED");
            assert_eq!(old_metadata.1, "retryable");
            assert_eq!(old_metadata.2, "v1");
            assert!(old_metadata.3.is_some());
            Ok(())
        })
        .expect("interruption recovery");
    }
}
