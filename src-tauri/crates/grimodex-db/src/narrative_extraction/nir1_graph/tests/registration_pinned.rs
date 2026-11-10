//! DR-GRW-2 (B1): the Graph worker's registration answers table presence from
//! the connection's schema cache, inside a pinned snapshot, from the first
//! ordinary table read of its read transaction until after its seal read.
//!
//! The tests fix that the shortcut changes no answer (result, seal, failure
//! kind, error text, stage order), that it saves the schema-table walks and the
//! owner progress callbacks they cost, that the scope does not leak out of the
//! registration on any exit, and that it is exact when the schema cache starts
//! stale or another connection commits DDL after the snapshot was pinned.

use super::cq_opt::schema_reads;
use super::*;
use crate::narrative_extraction::{
    is_validation_terminated, validation_terminated, ValidationTerminationReason,
};
use crate::nir1_pinned_snapshot::{self, with_sql_checks};
use std::sync::atomic::{AtomicU64, AtomicUsize};

/// A full-eligibility registration owner. It counts how often its progress
/// callback runs (SQLite calls it every 1,000 VM steps, and the Rust-side
/// `check_active_work` and JSON reads run it too, so it is not a step count)
/// and how often `check` runs, and it can stop in two ways:
/// - at its n-th `check` (a plain error);
/// - as a state, from its k-th progress callback on: the callback then reports
///   "stop" and every later `check` returns the typed stop, as a real owner
///   whose stop flag was raised does.
struct CountingOwner {
    callbacks: Arc<AtomicU64>,
    checks: usize,
    stop_at_check: Option<usize>,
    stop_at_callback: Option<u64>,
    stopped: Arc<AtomicBool>,
}

impl CountingOwner {
    fn new(stop_at_check: Option<usize>) -> Self {
        Self {
            callbacks: Arc::new(AtomicU64::new(0)),
            checks: 0,
            stop_at_check,
            stop_at_callback: None,
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }

    fn stopping_at_callback(callback: u64) -> Self {
        Self {
            stop_at_callback: Some(callback),
            ..Self::new(None)
        }
    }
}

impl GraphWorkControl for CountingOwner {
    fn check(&mut self, _: GraphWorkStage) -> Result<()> {
        self.checks += 1;
        if self.stop_at_check == Some(self.checks) {
            anyhow::bail!("TEST_OWNER_STOP");
        }
        if self.stopped.load(Ordering::Acquire) {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "TEST_CALLBACK_STOP",
            ));
        }
        Ok(())
    }
    fn progress_callback(&self) -> Option<GraphProgressCallback> {
        let callbacks = Arc::clone(&self.callbacks);
        let stopped = Arc::clone(&self.stopped);
        let stop_at = self.stop_at_callback;
        Some(Arc::new(move || {
            let count = callbacks.fetch_add(1, Ordering::Relaxed) + 1;
            if stop_at == Some(count) {
                stopped.store(true, Ordering::Release);
            }
            stopped.load(Ordering::Acquire)
        }))
    }
    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

/// Everything a registration attempt shows from the outside.
#[derive(Debug, PartialEq)]
struct Outcome {
    /// `Ok(registered)` or the full error chain.
    result: std::result::Result<bool, String>,
    /// The last stage the registration reported.
    stage: Nir1GraphRegistrationStage,
    /// Whether the error, if any, is the typed validation stop.
    terminated: bool,
    /// The seal a successful registration would publish.
    seal: Option<Seal>,
    /// Whether the same connection answers a presence check with `None` (the
    /// caller's SQL) once the registration is over, whatever its exit.
    scope_closed: bool,
}

/// Whether a registration left no scope behind. A presence check answers
/// `None` outside a read snapshot whether or not a scope is still set, so the
/// probe holds a read snapshot of its own (BEGIN and an ordinary table read, as
/// the registration did) and asks inside it: a leaked scope would answer
/// `Some` there.
fn scope_is_closed(conn: &Connection) -> Result<bool> {
    conn.execute_batch("BEGIN DEFERRED")?;
    conn.query_row("SELECT count(*) FROM codex_entries", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let answer = nir1_pinned_snapshot::table_exists(conn, "codex_entries");
    conn.execute_batch("ROLLBACK")?;
    Ok(answer?.is_none())
}

/// What a run cost, kept apart from the outcome because it differs by design.
struct Cost {
    schema_reads: usize,
    callbacks: u64,
    /// How many times the registration asked its owner to check: the Semantic
    /// and SourceIndex stages each check it, so an early end shows as fewer.
    owner_checks: usize,
    /// The table names presence checks were asked about, in order, whichever
    /// way they were answered.
    asked: Vec<String>,
}

/// An ordinary reader plus its schema-table read counter.
fn probed_reader(fixture: &Fixture) -> Result<(Nir1GraphReader, Arc<AtomicUsize>)> {
    let reader = fixture.reader()?;
    let ReaderConnection::Owned(conn) = &reader.connection else {
        panic!("an ordinary reader owns its connection");
    };
    let reads = schema_reads(conn)?;
    Ok((reader, reads))
}

/// Run one registration on `reader`, with presence checks answered by SQL when
/// `sql_checks` and by the shortcut otherwise.
fn register(
    mut reader: Nir1GraphReader,
    reads: &Arc<AtomicUsize>,
    mut owner: CountingOwner,
    sql_checks: bool,
) -> Result<(Outcome, Cost)> {
    let conn = reader.take_owned_connection()?;
    let mut stage = Nir1GraphRegistrationStage::Maintenance;
    let mut current_heap = |operation: &mut dyn FnMut()| {
        operation();
        true
    };
    reads.store(0, Ordering::Relaxed);
    nir1_pinned_snapshot::take_asked_tables();
    let mut run = || {
        reader.register_with_control_observed(
            &conn,
            PROJECT,
            &mut owner,
            Some(&mut stage),
            &mut current_heap,
        )
    };
    let result = if sql_checks {
        with_sql_checks(&mut run)
    } else {
        run()
    };
    let cost = Cost {
        schema_reads: reads.swap(0, Ordering::Relaxed),
        callbacks: owner.callbacks.load(Ordering::Relaxed),
        owner_checks: owner.checks,
        asked: nir1_pinned_snapshot::take_asked_tables(),
    };
    assert!(conn.is_autocommit(), "the registration's read was ended");
    let scope_closed = scope_is_closed(&conn)?;
    let seal = reader
        .pending_registration
        .as_ref()
        .map(|pending| pending.seal.clone());
    let terminated = result.as_ref().is_err_and(is_validation_terminated);
    Ok((
        Outcome {
            result: result.map_err(|error| format!("{error:#}")),
            terminated,
            stage,
            seal,
            scope_closed,
        },
        cost,
    ))
}

/// The same registration answered by SQL and by the shortcut, on two readers
/// of one fixture.
fn both(fixture: &Fixture) -> Result<((Outcome, Cost), (Outcome, Cost))> {
    let (reader, reads) = probed_reader(fixture)?;
    let sql = register(reader, &reads, CountingOwner::new(None), true)?;
    let (reader, reads) = probed_reader(fixture)?;
    let pinned = register(reader, &reads, CountingOwner::new(None), false)?;
    Ok((sql, pinned))
}

fn execute(fixture: &Fixture, ddl: &str) -> Result<()> {
    fixture.authority.with_conn(|conn| {
        conn.execute_batch(ddl)?;
        Ok(())
    })
}

// A healthy project registers to the same seal either way. Under the shortcut
// the registration reads no schema table and the owner's progress callback runs
// fewer times (SQLite runs it every 1,000 VM steps); under SQL it reads the
// schema table for every presence check.
#[test]
fn registration_answers_alike_and_reads_no_schema_table_under_the_shortcut() -> Result<()> {
    let fixture = Fixture::new()?;
    let ((sql, sql_cost), (pinned, pinned_cost)) = both(&fixture)?;
    assert_eq!(sql.result, Ok(true), "{:?}", sql.result);
    assert!(sql.seal.is_some());
    assert_eq!(sql.stage, Nir1GraphRegistrationStage::PostflightIdentity);
    assert!(sql.scope_closed);
    assert_eq!(pinned, sql);
    // The probe can fail: inside a scope of its own it sees the shortcut.
    let (reader, _) = probed_reader(&fixture)?;
    let ReaderConnection::Owned(conn) = &reader.connection else {
        panic!("an ordinary reader owns its connection");
    };
    conn.execute_batch("BEGIN DEFERRED")?;
    conn.query_row("SELECT count(*) FROM codex_entries", [], |row| {
        row.get::<_, i64>(0)
    })?;
    assert_eq!(
        nir1_pinned_snapshot::with_pinned_snapshot(conn, || {
            nir1_pinned_snapshot::table_exists(conn, "codex_entries")
        })?,
        Some(true)
    );
    conn.execute_batch("ROLLBACK")?;
    eprintln!(
        "registration: schema reads {} -> {}, owner callbacks {} -> {}",
        sql_cost.schema_reads, pinned_cost.schema_reads, sql_cost.callbacks, pinned_cost.callbacks
    );
    // Which tables the presence checks asked about (the same either way), and
    // how often: every check goes through the shortcut and none is left to SQL.
    let mut by_table = std::collections::BTreeMap::<&str, usize>::new();
    for table in &sql_cost.asked {
        *by_table.entry(table).or_default() += 1;
    }
    eprintln!("presence checks by table: {by_table:?}");
    assert_eq!(pinned_cost.asked, sql_cost.asked);
    // The authorizer counts a read per column the schema-table query reads
    // (`type` and `name`), so a check is two reads under SQL.
    assert_eq!(
        sql_cost.asked.len() * 2,
        sql_cost.schema_reads,
        "each presence check is two schema-table column reads under SQL"
    );
    assert_eq!(
        pinned_cost.schema_reads, 0,
        "registration must not read sqlite_master under the shortcut"
    );
    assert!(
        sql_cost.asked.len() >= 9,
        "at least nine presence checks: {}",
        sql_cost.asked.len()
    );
    assert!(
        pinned_cost.callbacks + 5 <= sql_cost.callbacks,
        "owner callbacks: SQL {} -> shortcut {}",
        sql_cost.callbacks,
        pinned_cost.callbacks
    );
    Ok(())
}

// The Graph worker's registration runs on the authority connection under the
// maintenance owner: the same saving, and the connection keeps its SQL checks
// afterwards.
#[test]
fn worker_registration_reads_no_schema_table_under_the_shortcut() -> Result<()> {
    let mut counts = Vec::new();
    // One fixture per mode: opening a worker reader makes the authority
    // connection query-only, so it cannot open a second one.
    for sql_checks in [true, false] {
        let fixture = Fixture::new()?;
        let reads = fixture.authority.db().with_conn(schema_reads)?;
        let mut reader = fixture.open_worker_reader()?;
        reads.store(0, Ordering::Relaxed);
        let registered = if sql_checks {
            with_sql_checks(|| reader.register_with_worker_maintenance(PROJECT, || true))?
        } else {
            reader.register_with_worker_maintenance(PROJECT, || true)?
        };
        assert!(registered, "worker registration (SQL checks {sql_checks})");
        counts.push(reads.swap(0, Ordering::Relaxed));
        fixture.authority.db().with_conn(|conn| {
            assert!(
                scope_is_closed(conn)?,
                "the scope ended with the registration"
            );
            Ok(())
        })?;
        reader.close()?;
    }
    assert!(
        counts[0] >= 18,
        "SQL checks read the schema table: {counts:?}"
    );
    assert_eq!(counts[1], 0, "the shortcut reads none: {counts:?}");
    Ok(())
}

// Every way the Semantic stage can refuse or fail gives the same outcome under
// both: the bool, the error chain, the last stage, the seal, and no leaked
// scope. Four of the five breaks end at a presence check the shortcut answers;
// the missing declaration set table is read directly by a statement before any
// presence check, so it reaches no shortcut and only fixes the error text.
#[test]
fn registration_failures_are_identical_under_the_shortcut_and_sql_checks() -> Result<()> {
    let marker = crate::Database::C2_ZC_CUTOVER_MIGRATION_ID;
    let breaks: [(&str, String); 5] = [
        (
            "declaration set table missing",
            "ALTER TABLE narrative_dependency_declaration_sets RENAME TO grw_bak".into(),
        ),
        (
            "scope registries table missing",
            "ALTER TABLE narrative_scope_registries RENAME TO grw_bak".into(),
        ),
        (
            "scene scope bindings table missing",
            "ALTER TABLE narrative_scene_scope_bindings RENAME TO grw_bak".into(),
        ),
        (
            "C2-ZC marker row missing",
            format!("DELETE FROM schema_data_migrations WHERE migration_id = '{marker}'"),
        ),
        (
            "migration table missing",
            "ALTER TABLE schema_data_migrations RENAME TO grw_bak".into(),
        ),
    ];
    for (name, ddl) in breaks {
        let fixture = Fixture::new()?;
        execute(&fixture, &ddl)?;
        let ((sql, sql_cost), (pinned, pinned_cost)) = both(&fixture)?;
        assert_ne!(sql.result, Ok(true), "{name}: the break must bite");
        assert_eq!(pinned, sql, "{name}");
        assert!(pinned.scope_closed, "{name}");
        // The shortcut sites were reached (SQL reads the schema table there and
        // the shortcut does not), except where the failure comes from a statement
        // that reads the missing declaration table directly, before any check.
        assert_eq!(pinned_cost.schema_reads, 0, "{name}");
        assert_eq!(
            sql_cost.schema_reads > 0,
            name != "declaration set table missing",
            "{name}: SQL reads {}",
            sql_cost.schema_reads
        );
        assert!(
            pinned_cost.schema_reads <= sql_cost.schema_reads,
            "{name}: {} vs {}",
            pinned_cost.schema_reads,
            sql_cost.schema_reads
        );
        eprintln!(
            "{name}: {:?}; schema reads SQL {} / shortcut {}, owner checks SQL {} / shortcut {}",
            pinned.result,
            sql_cost.schema_reads,
            pinned_cost.schema_reads,
            sql_cost.owner_checks,
            pinned_cost.owner_checks
        );
    }
    Ok(())
}

// An owner that stops the registration at its n-th `check` (inside the Semantic
// stage, between Revisions, before the Seal, in the postflight) ends it the same
// way under both, at every one of the checks a healthy registration makes, and
// the scope never outlives the early return. (This is the stop that `check`
// finds. A stop that SQLite's progress callback finds is a different test,
// because the callback runs a different number of times.)
#[test]
fn registration_owner_check_stops_end_alike_and_never_leak_the_scope() -> Result<()> {
    let fixture = Fixture::new()?;
    let (reader, reads) = probed_reader(&fixture)?;
    let sql_checks = register(reader, &reads, CountingOwner::new(None), true)?
        .1
        .owner_checks;
    let (reader, reads) = probed_reader(&fixture)?;
    let checks = register(reader, &reads, CountingOwner::new(None), false)?
        .1
        .owner_checks;
    assert_eq!(checks, sql_checks, "the same checks run either way");
    for stop_at in 1..=checks + 1 {
        let (reader, reads) = probed_reader(&fixture)?;
        let sql = register(reader, &reads, CountingOwner::new(Some(stop_at)), true)?.0;
        let (reader, reads) = probed_reader(&fixture)?;
        let pinned = register(reader, &reads, CountingOwner::new(Some(stop_at)), false)?.0;
        assert_eq!(pinned, sql, "stop at check {stop_at}");
        assert!(pinned.scope_closed, "stop at check {stop_at}");
        if stop_at <= checks {
            let error = pinned.result.as_ref().expect_err("the owner stops it");
            assert!(error.contains("TEST_OWNER_STOP"), "{stop_at}: {error}");
        } else {
            assert_eq!(pinned.result, Ok(true), "no check is left to stop it");
        }
    }
    eprintln!("owner check stops: {checks} stop points, all alike");
    Ok(())
}

// A stop that is a state (a raised stop flag, as a closing workspace, a
// deadline or a foreground waiter leaves) is seen by SQLite's progress callback
// and by every later `check`. Under the shortcut the callback runs fewer times,
// so the stop can be seen at another point and another stage: the tests compare
// only the end, which is the same typed stop with no scope left behind, and
// when a stop would only have come after the shortcut's registration was over
// the registration completes instead.
#[test]
fn registration_state_stops_end_in_the_same_typed_stop_and_never_leak_the_scope() -> Result<()> {
    let fixture = Fixture::new()?;
    let (reader, reads) = probed_reader(&fixture)?;
    let sql_callbacks = register(reader, &reads, CountingOwner::new(None), true)?
        .1
        .callbacks;
    let (reader, reads) = probed_reader(&fixture)?;
    let pinned_callbacks = register(reader, &reads, CountingOwner::new(None), false)?
        .1
        .callbacks;
    assert!(pinned_callbacks < sql_callbacks);
    let mut points: Vec<u64> = [1, 2, 3, 5, 8, 13, 21, 34, 55]
        .into_iter()
        .filter(|point| *point <= pinned_callbacks)
        .collect();
    points.push(pinned_callbacks);
    for stop_at in points {
        for sql_checks in [true, false] {
            let (reader, reads) = probed_reader(&fixture)?;
            let (outcome, _) = register(
                reader,
                &reads,
                CountingOwner::stopping_at_callback(stop_at),
                sql_checks,
            )?;
            assert!(
                outcome.terminated,
                "stop at callback {stop_at} (SQL checks {sql_checks}): {:?}",
                outcome.result
            );
            assert!(outcome.seal.is_none());
            assert!(outcome.scope_closed, "stop at callback {stop_at}");
        }
    }
    // Between the two counts a stop still ends the SQL registration, and the
    // shortcut registration, which never reaches that callback, completes.
    let stop_at = pinned_callbacks + 1;
    assert!(stop_at <= sql_callbacks);
    let (reader, reads) = probed_reader(&fixture)?;
    let (sql, _) = register(
        reader,
        &reads,
        CountingOwner::stopping_at_callback(stop_at),
        true,
    )?;
    assert!(sql.terminated, "{:?}", sql.result);
    let (reader, reads) = probed_reader(&fixture)?;
    let (pinned, _) = register(
        reader,
        &reads,
        CountingOwner::stopping_at_callback(stop_at),
        false,
    )?;
    assert_eq!(pinned.result, Ok(true));
    Ok(())
}

// Inside the scope the registration's statements only read and use SAVEPOINTs;
// the transaction ends once, by the ROLLBACK after the scope. The shortcut does
// not rest on a transaction that ends inside the range.
#[test]
fn registration_scope_statements_never_end_the_transaction() -> Result<()> {
    let fixture = Fixture::new()?;
    let (reader, _) = probed_reader(&fixture)?;
    let ReaderConnection::Owned(conn) = &reader.connection else {
        panic!("an ordinary reader owns its connection");
    };
    let transactions = Arc::new(Mutex::new(Vec::<String>::new()));
    let savepoints = Arc::new(Mutex::new(std::collections::BTreeSet::<String>::new()));
    let (transactions_seen, savepoints_seen) = (Arc::clone(&transactions), Arc::clone(&savepoints));
    conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
        use rusqlite::hooks::AuthAction;
        match context.action {
            AuthAction::Transaction { operation } => {
                transactions_seen
                    .lock()
                    .unwrap()
                    .push(format!("{operation:?}"));
            }
            AuthAction::Savepoint {
                operation,
                savepoint_name,
            } => {
                savepoints_seen
                    .lock()
                    .unwrap()
                    .insert(format!("{operation:?} {savepoint_name}"));
            }
            _ => {}
        }
        rusqlite::hooks::Authorization::Allow
    }))?;
    let (reader, reads) = (reader, Arc::new(AtomicUsize::new(0)));
    let (outcome, _) = register(reader, &reads, CountingOwner::new(None), false)?;
    assert_eq!(outcome.result, Ok(true));
    let transactions = transactions.lock().unwrap().clone();
    eprintln!("transaction statements: {transactions:?}");
    eprintln!("savepoint statements: {:?}", savepoints.lock().unwrap());
    // The registration's own BEGIN and ROLLBACK, then the probe of `register`
    // (its own BEGIN and ROLLBACK after the registration).
    assert_eq!(transactions, ["Begin", "Rollback", "Begin", "Rollback"]);
    assert!(
        savepoints
            .lock()
            .unwrap()
            .iter()
            .all(|statement| statement.starts_with("Begin ") || statement.starts_with("Release ")),
        "{:?}",
        savepoints.lock().unwrap()
    );
    Ok(())
}

// The schema cache starts stale: the connection cached the schema, another
// connection committed DDL, then the registration began. The dependency-edge
// read that precedes the scope makes the cache the snapshot's schema, so the
// shortcut answers what SQL answers, for DDL that changes nothing registration
// needs and for DDL that removes a table it needs.
#[test]
fn registration_shortcut_is_exact_when_the_schema_cache_starts_stale() -> Result<()> {
    // `probe` and `stale_answer`: what the connection's cache says about a table
    // after the DDL, which is wrong exactly because the cache is stale.
    for (name, ddl, registers, probe, stale_answer) in [
        (
            "unrelated table added",
            "CREATE TABLE grw_unrelated(x INTEGER)",
            true,
            "grw_unrelated",
            false,
        ),
        (
            "needed table removed",
            "ALTER TABLE narrative_scene_scope_bindings RENAME TO grw_bak",
            false,
            "narrative_scene_scope_bindings",
            true,
        ),
    ] {
        let fixture = Fixture::new()?;
        let (sql_reader, sql_reads) = probed_reader(&fixture)?;
        let (pinned_reader, pinned_reads) = probed_reader(&fixture)?;
        for reader in [&sql_reader, &pinned_reader] {
            let ReaderConnection::Owned(conn) = &reader.connection else {
                panic!("an ordinary reader owns its connection");
            };
            // Load this connection's schema cache before the DDL.
            conn.query_row("SELECT count(*) FROM codex_entries", [], |row| {
                row.get::<_, i64>(0)
            })?;
        }
        execute(&fixture, ddl)?;
        for reader in [&sql_reader, &pinned_reader] {
            let ReaderConnection::Owned(conn) = &reader.connection else {
                panic!("an ordinary reader owns its connection");
            };
            assert_eq!(
                conn.table_exists(Some("main"), probe)?,
                stale_answer,
                "{name}: the cache must be stale before the registration"
            );
        }
        let (sql, sql_cost) = register(sql_reader, &sql_reads, CountingOwner::new(None), true)?;
        assert!(sql_cost.schema_reads > 0, "{name}");
        let (pinned, cost) = register(
            pinned_reader,
            &pinned_reads,
            CountingOwner::new(None),
            false,
        )?;
        assert_eq!(pinned, sql, "{name}");
        assert!(pinned.scope_closed, "{name}");
        assert_eq!(
            pinned.result.is_ok_and(|registered| registered),
            registers,
            "{name}"
        );
        assert_eq!(cost.schema_reads, 0, "{name}");
    }
    Ok(())
}

// DDL committed by another connection after the registration pinned its
// snapshot is not in that snapshot: the shortcut answers from the snapshot's
// schema (the Semantic and SourceIndex stages run to the end exactly as under
// SQL and as in a run with no DDL: the same number of owner checks), and the
// postflight identity then refuses the registration because the database moved.
#[test]
fn registration_shortcut_ignores_ddl_committed_after_the_snapshot_was_pinned() -> Result<()> {
    // The control: a healthy registration's owner checks.
    let control = {
        let fixture = Fixture::new()?;
        let (reader, reads) = probed_reader(&fixture)?;
        register(reader, &reads, CountingOwner::new(None), false)?
            .1
            .owner_checks
    };
    let mut outcomes = Vec::new();
    for sql_checks in [true, false] {
        let fixture = Fixture::new()?;
        let (reader, reads) = probed_reader(&fixture)?;
        let ReaderConnection::Owned(conn) = &reader.connection else {
            panic!("an ordinary reader owns its connection");
        };
        // The authorizer sees the dependency-edge read being prepared, after
        // BEGIN and the identity read (whose first PRAGMA pinned the snapshot;
        // BEGIN DEFERRED alone pins nothing): commit the DDL from another
        // connection then, once. A commit between BEGIN and the identity read
        // would be a DRIFT instead.
        let authority = Arc::clone(&fixture.authority);
        let reads_for_authorizer = Arc::clone(&reads);
        let fired = Arc::new(AtomicBool::new(false));
        conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
            match context.action {
                rusqlite::hooks::AuthAction::Read { table_name, .. }
                    if table_name == "narrative_dependency_edges"
                        && !fired.swap(true, Ordering::SeqCst) =>
                {
                    authority
                        .with_conn(|other| {
                            other.execute_batch(
                                "ALTER TABLE narrative_scene_scope_bindings RENAME TO grw_bak",
                            )?;
                            Ok(())
                        })
                        .expect("DDL from another connection");
                }
                rusqlite::hooks::AuthAction::Read { table_name, .. }
                    if ["sqlite_master", "sqlite_schema"]
                        .iter()
                        .any(|schema| table_name.eq_ignore_ascii_case(schema)) =>
                {
                    reads_for_authorizer.fetch_add(1, Ordering::Relaxed);
                }
                _ => {}
            }
            rusqlite::hooks::Authorization::Allow
        }))?;
        let (outcome, cost) = register(reader, &reads, CountingOwner::new(None), sql_checks)?;
        // The snapshot predates the DDL: every stage ran to the end (as many
        // owner checks as a registration without DDL; a Semantic stage that
        // had seen the rename would have ended early), and the postflight
        // identity refused it because the database moved.
        assert_eq!(
            outcome.stage,
            Nir1GraphRegistrationStage::PostflightIdentity,
            "SQL checks {sql_checks}: {:?}",
            outcome.result
        );
        assert_eq!(outcome.result, Ok(false), "SQL checks {sql_checks}");
        assert!(outcome.seal.is_none());
        assert_eq!(cost.owner_checks, control, "SQL checks {sql_checks}");
        // No `scope_closed` assertion here: the other connection's commit moved
        // the data version, so a probe would answer `None` whether or not a
        // scope were left behind. Tests 1 to 5 detect a leak.
        if !sql_checks {
            assert_eq!(cost.schema_reads, 0);
        }
        outcomes.push((outcome.result, outcome.stage));
    }
    assert_eq!(outcomes[0], outcomes[1]);
    Ok(())
}
