//! DR-DBC-4, P2-1: SQLite 3.54 re-prepares a cached statement when a bound value
//! that the planner read (sqlite_stat4) changes, and `sqlite3_clear_bindings`
//! expires such a statement. The re-prepare parses and plans again, and the
//! planner calls `sqlite3ProgressCheck`, so under a cadence-1 capacity budget
//! each re-prepare is charged as VM steps. This measures how many steps, for the
//! statements that `prepare_cached` and bind in a capacity scope, on a database
//! that has been analyzed (production runs `PRAGMA optimize` at open).

use crate::Database;
use rusqlite::{params, Connection, StatementStatus};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const SCENES: usize = 400;
const SCENE_BODY_SQL: &str = "SELECT version, updated_at
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'";

fn analyzed_db() -> Database {
    let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
    for project in ["p1", "p2"] {
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Project')",
            &[Value::String(project.into())],
            "run",
        )
        .expect("insert project");
    }
    db.with_conn_mut(|conn| {
        let tx = conn.unchecked_transaction()?;
        for n in 0..SCENES {
            tx.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                 VALUES (?1, ?2, 'scene', 'Scene', '{}')",
                params![format!("s{n:04}"), if n % 5 == 0 { "p2" } else { "p1" }],
            )?;
        }
        tx.commit()?;
        conn.execute_batch("ANALYZE")?;
        Ok(())
    })
    .expect("seed and analyze");
    db
}

/// Steps (progress callbacks at interval 1) charged while `work` runs.
fn measure(conn: &Connection, counter: &Arc<AtomicU64>, work: impl FnOnce(&Connection)) -> u64 {
    let before = counter.load(Ordering::Relaxed);
    work(conn);
    counter.load(Ordering::Relaxed) - before
}

fn with_counter<T>(
    conn: &mut Connection,
    body: impl FnOnce(&mut Connection, &Arc<AtomicU64>) -> T,
) -> T {
    let counter = Arc::new(AtomicU64::new(0));
    let seen = Arc::clone(&counter);
    crate::hook_registration::set_progress_handler(
        conn,
        1,
        Some(move || {
            seen.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )
    .expect("count steps");
    let result = body(conn, &counter);
    crate::hook_registration::set_progress_handler(conn, 0, None::<fn() -> bool>)
        .expect("stop counting");
    result
}

/// One statement: its steps (a) preparing only, (b) executing a prepared
/// statement, (c) `prepare_cached` + execute with a different binding each time
/// (the production pattern; the cache clears the bindings when a statement is
/// returned), and how many re-prepares SQLite counted for (c).
struct Cost {
    execute_prepared: u64,
    cached_min: u64,
    cached_max: u64,
}

impl Cost {
    /// `prepare_cached` + a different binding each call charged the same as
    /// executing an already prepared statement: no step is spent re-preparing.
    fn reprepare_is_free(&self) -> bool {
        self.cached_min == self.execute_prepared && self.cached_max == self.execute_prepared
    }
}

fn report(
    label: &str,
    conn: &mut Connection,
    sql: &str,
    bindings: &[Vec<rusqlite::types::Value>],
) -> Cost {
    with_counter(conn, |conn, counter| {
        let prepare_only = measure(conn, counter, |c| {
            drop(c.prepare(sql).expect("prepare"));
        });
        let mut stmt = conn.prepare(sql).expect("prepare");
        let first = &bindings[0];
        let execute_prepared = {
            let before = counter.load(Ordering::Relaxed);
            let mut rows = stmt
                .query(rusqlite::params_from_iter(first.iter()))
                .expect("run");
            while rows.next().expect("row").is_some() {}
            drop(rows);
            counter.load(Ordering::Relaxed) - before
        };
        drop(stmt);
        let mut cached = Vec::new();
        let mut reprepares = 0;
        for binding in bindings {
            let before = counter.load(Ordering::Relaxed);
            let mut stmt = conn.prepare_cached(sql).expect("prepare_cached");
            let mut rows = stmt
                .query(rusqlite::params_from_iter(binding.iter()))
                .expect("run");
            while rows.next().expect("row").is_some() {}
            drop(rows);
            reprepares = stmt.get_status(StatementStatus::RePrepare);
            drop(stmt);
            cached.push(counter.load(Ordering::Relaxed) - before);
        }
        let mean = cached.iter().sum::<u64>() as f64 / cached.len() as f64;
        eprintln!(
            "P2-1 {label}: prepare only {prepare_only} steps, execute prepared {execute_prepared}, \
             prepare_cached+execute mean {mean:.1} (min {} max {}) over {} calls, \
             re-prepares counted {reprepares}",
            cached.iter().min().unwrap(),
            cached.iter().max().unwrap(),
            cached.len()
        );
        Cost {
            execute_prepared,
            cached_min: *cached.iter().min().unwrap(),
            cached_max: *cached.iter().max().unwrap(),
        }
    })
}

fn text(value: &str) -> rusqlite::types::Value {
    rusqlite::types::Value::Text(value.to_owned())
}

#[test]
fn cached_statements_in_a_capacity_scope_cost_no_reprepare_steps() {
    let db = analyzed_db();
    for (label, stat_limit) in [
        ("analysis_limit=400 (production)", 400),
        ("full ANALYZE (stat4)", 0),
    ] {
        db.with_conn_mut(|conn| {
            conn.execute_batch(&format!(
                "PRAGMA analysis_limit={stat_limit}; ANALYZE; PRAGMA analysis_limit=400;"
            ))?;
            let stat4: i64 =
                conn.query_row("SELECT count(*) FROM sqlite_stat4", [], |r| r.get(0))?;
            eprintln!("P2-1 {label}: sqlite_stat4 rows {stat4}");
            let bindings: Vec<_> = (2..42)
                .map(|n| {
                    vec![
                        text(&format!("s{n:04}")),
                        text(if n % 5 == 0 { "p2" } else { "p1" }),
                    ]
                })
                .collect();
            // The two statements that `prepare_cached` and that run in a capacity
            // scope (the Graph's source resolution): a unique-key lookup is planned
            // by SQLite's shortcut, which neither reads the bound value nor calls
            // `sqlite3ProgressCheck`, so a re-prepare costs no step.
            let scene_body = report("resolve_scene_body", conn, SCENE_BODY_SQL, &bindings);
            assert!(scene_body.reprepare_is_free(), "{label}");
            let int = rusqlite::types::Value::Integer;
            let target_bindings: Vec<_> = (2..42)
                .map(|n| {
                    vec![
                        text("p1"),
                        text(&format!("object-{n}")),
                        int(n),
                        text("modified"),
                        text("2026-11-13T00:00:00Z"),
                        text("field"),
                    ]
                })
                .collect();
            // The statements below are not read in a capacity scope (the Application
            // contribution readers and the audit writer run on other paths). They
            // are measured for the record only: `matching_field_paths` filters by
            // two unindexed-together equalities, so SQLite plans it and the cache's
            // `sqlite3_clear_bindings` makes every call re-prepare (about 11 steps).
            report(
                "contribution target-state UPDATE",
                conn,
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
                &target_bindings,
            );
            let paths_bindings: Vec<_> = (2..42)
                .map(|n| vec![text("p1"), text(&format!("object-{n}"))])
                .collect();
            report(
                "contribution matching_field_paths SELECT",
                conn,
                "SELECT DISTINCT field_path
                   FROM narrative_application_contributions
                  WHERE project_id = ?1 AND target_object_identity = ?2",
                &paths_bindings,
            );
            report(
                "local audit read_execution_state SELECT",
                conn,
                "SELECT path_id,event_type FROM ai_audit_events
                  WHERE scope_id=?1 AND execution_id=?2
                    AND event_type IN ('execution.started','execution.succeeded','execution.failed',
                                       'execution.cancelled','execution.skipped','execution.cache_hit')",
                &paths_bindings,
            );
            let snapshot_run = report(
                "snapshot run SELECT",
                conn,
                "SELECT project_id, snapshot_digest FROM narrative_extraction_runs WHERE id = ?1",
                &(2..42)
                    .map(|n| vec![text(&format!("run-{n}"))])
                    .collect::<Vec<_>>(),
            );
            assert!(snapshot_run.reprepare_is_free(), "{label}");
            Ok(())
        })
        .expect("probe");
    }
}
