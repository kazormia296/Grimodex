//! DR-GRW-3 (P′): the per-Revision loop of the registration's source read
//! (`read_eligibility_source_counted`) prepares each of its five statements on
//! first use and reuses it for every later Revision, and finalizes them all
//! when the read ends, on return and on unwind.
//!
//! The tests fix that the reuse changes no answer (result, seal, failure kind,
//! error text, stage), that it saves the prepares, that the statements are not
//! re-prepared by SQLite on the way, that no handle outlives the read on any
//! exit, and that an owner stop at any point ends both forms alike. The oracle
//! is `with_fresh_statements`, which restores the form before the change: one
//! statement per use, prepared at the same call site and finalized right after.

use super::registration_pinned::{scope_is_closed, CountingOwner};
use super::*;
use crate::narrative_extraction::is_validation_terminated;
use crate::narrative_extraction::nir1_entity_relation_index::{
    self as index, take_revision_statements_observation, with_fresh_statements,
    RevisionStatementsObservation,
};

/// How many statements the connection holds unfinalized.
pub(super) fn live_statements(conn: &Connection) -> usize {
    // SAFETY: the walk only reads the connection's list of statements, on the
    // thread that owns the connection.
    unsafe {
        let db = conn.handle();
        let mut count = 0;
        let mut statement = rusqlite::ffi::sqlite3_next_stmt(db, std::ptr::null_mut());
        while !statement.is_null() {
            count += 1;
            statement = rusqlite::ffi::sqlite3_next_stmt(db, statement);
        }
        count
    }
}

/// Everything a registration attempt shows from the outside.
#[derive(Debug, PartialEq)]
struct Outcome {
    result: std::result::Result<bool, String>,
    stage: Nir1GraphRegistrationStage,
    terminated: bool,
    seal: Option<Seal>,
    scope_closed: bool,
}

struct Run {
    outcome: Outcome,
    /// What the holder of the last source read showed when it dropped.
    observed: Option<RevisionStatementsObservation>,
    callbacks: u64,
    checks: usize,
    live_before: usize,
    live_after: usize,
}

/// One registration on a new ordinary reader of `fixture`, in the form that
/// reuses its statements (`fresh` false) or the one that prepares each use.
fn register(fixture: &Fixture, mut owner: CountingOwner, fresh: bool) -> Result<Run> {
    let mut reader = fixture.reader()?;
    let mut conn = reader.take_owned_connection()?;
    let mut stage = Nir1GraphRegistrationStage::Maintenance;
    let mut current_heap = |operation: &mut dyn FnMut()| {
        operation();
        true
    };
    let live_before = live_statements(&conn);
    take_revision_statements_observation();
    let mut run = || {
        reader.register_with_control_observed(
            &mut conn,
            PROJECT,
            &mut owner,
            Some(&mut stage),
            &mut current_heap,
        )
    };
    let result = if fresh {
        with_fresh_statements(&mut run)
    } else {
        run()
    };
    let observed = take_revision_statements_observation();
    let live_after = live_statements(&conn);
    assert!(conn.is_autocommit(), "the registration's read was ended");
    let scope_closed = scope_is_closed(&conn)?;
    let seal = reader
        .pending_registration
        .as_ref()
        .map(|pending| pending.seal.clone());
    let terminated = result.as_ref().is_err_and(is_validation_terminated);
    Ok(Run {
        outcome: Outcome {
            result: result.map_err(|error| format!("{error:#}")),
            terminated,
            stage,
            seal,
            scope_closed,
        },
        observed,
        callbacks: owner.callbacks.load(Ordering::Relaxed),
        checks: owner.checks,
        live_before,
        live_after,
    })
}

/// Both forms on one fixture. Asserts what must hold for every shape: the
/// outcomes are the same, the same checks ran, the reuse form never ran the
/// owner's progress callback more often, and neither form left a handle.
fn alike(name: &str, fixture: &Fixture) -> Result<(Run, Run)> {
    let reuse = register(fixture, CountingOwner::new(None), false)?;
    let fresh = register(fixture, CountingOwner::new(None), true)?;
    assert_eq!(reuse.outcome, fresh.outcome, "{name}");
    assert!(reuse.outcome.scope_closed, "{name}");
    assert_eq!(reuse.checks, fresh.checks, "{name}: the same checks ran");
    assert!(
        reuse.callbacks <= fresh.callbacks,
        "{name}: callbacks {} vs {}",
        reuse.callbacks,
        fresh.callbacks
    );
    for (form, run) in [("reuse", &reuse), ("fresh", &fresh)] {
        assert_eq!(
            run.live_after, run.live_before,
            "{name} ({form}): the registration left a statement behind"
        );
    }
    // The seam must not pass through: the oracle holds nothing and prepares at
    // every use, and both forms take the same path through the loop.
    if let (Some(reuse_seen), Some(fresh_seen)) = (reuse.observed, fresh.observed) {
        assert_eq!(
            reuse_seen.attempts, fresh_seen.attempts,
            "{name}: same path"
        );
        assert_eq!(
            fresh_seen.mem_used, [0; 5],
            "{name}: the oracle holds nothing"
        );
        for slot in 0..5 {
            let attempts = reuse_seen.attempts[slot];
            assert!(reuse_seen.prepares[slot] <= 1, "{name}: slot {slot}");
            assert!(
                fresh_seen.prepares[slot] + 1 >= attempts,
                "{name}: slot {slot}: the oracle prepares at every use ({attempts} uses, {} prepares)",
                fresh_seen.prepares[slot]
            );
            if attempts >= 3 {
                assert!(
                    fresh_seen.prepares[slot] > reuse_seen.prepares[slot],
                    "{name}: slot {slot}: the seam made no difference"
                );
            }
        }
    }
    Ok((reuse, fresh))
}

pub(super) fn execute(fixture: &Fixture, sql: &str) -> Result<()> {
    fixture.authority.with_conn(|conn| {
        conn.execute_batch(sql)?;
        Ok(())
    })
}

/// The seed Revision and three more approved ones: four Revisions, so a
/// statement is reused three times when nothing ends the read early.
pub(super) fn multi_fixture() -> Result<Fixture> {
    let fixture = Fixture::new()?;
    for serial in 1..=3 {
        fixture.add_candidate_revision(serial, 0)?;
    }
    fixture.republish_graph_index()?;
    Ok(fixture)
}

/// The candidate Revisions in the order the roster reads them (primary key of
/// the proposal, which is a random identifier), so a test can break the n-th.
pub(super) fn scan_order(fixture: &Fixture) -> Result<Vec<String>> {
    fixture.authority.with_conn(|conn| {
        let mut statement = conn.prepare(&index::roster_candidate_page_sql())?;
        let rows =
            statement.query_map(params![PROJECT, "", 1000], |row| row.get::<_, String>(3))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

/// A typed Revision of the seed Entities with its decision (`None` leaves it
/// pending), as the Graph tests of `cq_opt` make them.
pub(super) fn add_decided(
    fixture: &Fixture,
    serial: usize,
    decision: Option<&str>,
) -> Result<String> {
    let db = fixture.authority.db();
    let mut payload = request(db);
    payload.proposal_key = format!("nir1:review:decided-{serial:04}");
    seed_scope_edits(&mut payload.bundle);
    crate::narrative_extraction::nir1_entity_relation::tests::rebind_scope_tokens(
        db,
        &mut payload,
    )?;
    let created = create_nir1_entity_relation_revision(db, payload)?;
    let revision = created["revisionId"].as_str().unwrap().to_owned();
    if let Some(decision) = decision {
        narrative_extraction_append_human_decision(
            db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: PROJECT.into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                revision_id: revision.clone(),
                decision: decision.into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;
    }
    Ok(revision)
}

/// Six million bytes and more of padding, as SQL.
pub(super) const OVER_6_MIB_PAD: &str = "replace(hex(zeroblob(3300000)), '0', ' ')";

// ---------------------------------------------------------------------------
// The counter, the saving and the shapes.
// ---------------------------------------------------------------------------

// The statement counter can fail: it sees an open statement, and one that a
// connection's cache keeps, which is what `prepare_cached` would add.
#[test]
fn the_statement_counter_sees_open_and_cached_statements() -> Result<()> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("CREATE TABLE t(a)")?;
    assert_eq!(live_statements(&conn), 0);
    let open = conn.prepare("SELECT a FROM t")?;
    assert_eq!(live_statements(&conn), 1);
    drop(open);
    assert_eq!(live_statements(&conn), 0);
    drop(conn.prepare_cached("SELECT a FROM t WHERE a = ?1")?);
    assert_eq!(live_statements(&conn), 1, "the cache keeps a statement");
    Ok(())
}

// (e) Four Revisions: the reuse form prepares each of the five statements once
// and runs it four times; the oracle prepares each at every Revision. SQLite
// never re-prepares a held statement on its own, and both end in the same seal.
#[test]
fn reuse_prepares_each_statement_once_and_the_oracle_prepares_per_revision() -> Result<()> {
    let fixture = multi_fixture()?;
    let (reuse, fresh) = alike("healthy", &fixture)?;
    assert_eq!(reuse.outcome.result, Ok(true), "{:?}", reuse.outcome.result);
    assert!(reuse.outcome.seal.is_some());
    assert_eq!(
        reuse.outcome.stage,
        Nir1GraphRegistrationStage::PostflightIdentity
    );
    let reuse_seen = reuse.observed.expect("the reuse form read the source");
    let fresh_seen = fresh.observed.expect("the oracle read the source");
    assert_eq!(reuse_seen.prepares, [1; 5]);
    assert_eq!(reuse_seen.runs, [4; 5]);
    assert_eq!(
        reuse_seen.reprepares, [0; 5],
        "SQLite re-prepared a statement"
    );
    assert_eq!(
        fresh_seen.prepares, [4; 5],
        "the oracle prepares per Revision"
    );
    assert_eq!(fresh_seen.mem_used, [0; 5], "the oracle holds nothing");
    eprintln!(
        "registration of 4 Revisions: prepares {:?} -> {:?}, MemUsed of the held statements {:?} (sum {}), callbacks {} -> {}",
        fresh_seen.prepares,
        reuse_seen.prepares,
        reuse_seen.mem_used,
        reuse_seen.mem_used.iter().sum::<i32>(),
        fresh.callbacks,
        reuse.callbacks
    );
    Ok(())
}

// (a) Every shape of Revision the loop can meet ends alike in both forms. The
// Revision that breaks is the third in the order the roster reads, so the two
// before it have already used (and in the reuse form reused) the statements
// when it fails or is skipped.
#[test]
fn registration_answers_alike_for_each_shape_of_revision() -> Result<()> {
    let healthy = register(&multi_fixture()?, CountingOwner::new(None), false)?;
    assert_eq!(healthy.outcome.result, Ok(true));

    type Break = fn(&Fixture, &str) -> Result<()>;
    let breaks: [(&str, Break); 4] = [
        // The sealed basis no longer carries the Revision's token.
        ("basis mismatch", |fixture, revision| {
            fixture.authority.with_conn(|conn| {
                conn.execute_batch("DROP TRIGGER narrative_source_basis_immutable_update")?;
                conn.execute(
                    "UPDATE narrative_revision_source_basis SET revision_token = 'tampered'
                      WHERE revision_id = ?1 AND source_kind = 'codex-entry'",
                    [revision],
                )?;
                Ok(())
            })
        }),
        // An approved Revision over the registration's A2 limit.
        ("A2 limit", |fixture, revision| {
            fixture.authority.with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_proposal_decisions
                        SET decision_json = '{\"pad\":\"' || replace(hex(zeroblob(1100000)), '0', 'p') || '\"}'
                      WHERE revision_id = ?1",
                    [revision],
                )?;
                Ok(())
            })
        }),
        // An approved Revision with a component over 6 MiB.
        ("component over 6 MiB", |fixture, revision| {
            fixture.authority.with_conn(|conn| {
                conn.execute_batch(
                    "DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard",
                )?;
                conn.execute(
                    &format!(
                        "UPDATE narrative_proposal_revisions
                            SET payload_json = payload_json || {OVER_6_MIB_PAD}
                          WHERE id = ?1"
                    ),
                    [revision],
                )?;
                Ok(())
            })
        }),
        // The live Source of one Entity is hidden from every Revision.
        ("live lengths None", |fixture, _| {
            execute(fixture, "UPDATE codex_entries SET context_mode = 'hidden'")
        }),
    ];
    for (name, apply) in breaks {
        let fixture = multi_fixture()?;
        let order = scan_order(&fixture)?;
        assert_eq!(order.len(), 4);
        apply(&fixture, &order[2])?;
        let (reuse, fresh) = alike(name, &fixture)?;
        assert_ne!(
            reuse.outcome.result,
            Ok(true),
            "{name}: the break must bite ({:?})",
            reuse.outcome.result
        );
        let reuse_seen = reuse.observed.expect("the source was read");
        let fresh_seen = fresh.observed.expect("the source was read");
        eprintln!(
            "{name}: {:?}; prepares fresh {:?} / reuse {:?}",
            reuse.outcome.result, fresh_seen.prepares, reuse_seen.prepares
        );
        for slot in 0..5 {
            assert!(
                reuse_seen.prepares[slot] <= 1
                    && reuse_seen.prepares[slot] <= fresh_seen.prepares[slot],
                "{name}: slot {slot}: {:?} vs {:?}",
                reuse_seen.prepares,
                fresh_seen.prepares
            );
        }
        assert_eq!(reuse_seen.reprepares, [0; 5], "{name}");
    }
    Ok(())
}

// A Revision that is not approved is skipped, whatever its size and whether or
// not it has a decision; the ones that are, register. Ineligible Revisions mixed
// with approved ones are read by the reused statements and contribute nothing.
#[test]
fn registration_answers_alike_when_ineligible_revisions_are_mixed_in() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.add_candidate_revision(1, 0)?;
    add_decided(&fixture, 2, Some("rejected"))?;
    add_decided(&fixture, 3, None)?;
    let oversized = add_decided(&fixture, 4, Some("rejected"))?;
    fixture.add_candidate_revision(5, 0)?;
    fixture.republish_graph_index()?;
    // A rejected Revision whose payload is over 6 MiB is skipped before any of it
    // is parsed.
    execute(
        &fixture,
        &format!(
            "DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard;
             UPDATE narrative_proposal_revisions
                SET payload_json = payload_json || {OVER_6_MIB_PAD}
              WHERE id = '{oversized}'"
        ),
    )?;
    let (reuse, fresh) = alike("ineligible mix", &fixture)?;
    eprintln!("ineligible mix: {:?}", reuse.outcome.result);
    let reuse_seen = reuse.observed.expect("the source was read");
    let fresh_seen = fresh.observed.expect("the source was read");
    assert!(reuse_seen.prepares.iter().all(|prepares| *prepares <= 1));
    assert!(fresh_seen.prepares[0] >= 5, "{:?}", fresh_seen.prepares);
    Ok(())
}

// A statement that cannot be prepared fails where it always did, at the first
// Revision that reaches it, with the same text, in both forms. The reuse form
// does not prepare ahead: the statements before the broken one were used, and
// the ones after it were never asked for (`attempts`). Each break is chosen so
// that the roster's page statement, which reads some of the same tables, still
// runs and the loop is reached.
#[test]
fn registration_answers_alike_when_the_first_revision_cannot_prepare() -> Result<()> {
    // (name, DDL, the table named in the error, attempts, prepares)
    type PrepareBreak = (
        &'static str,
        &'static str,
        &'static str,
        [usize; 5],
        [usize; 5],
    );
    let breaks: [PrepareBreak; 3] = [
        // Only the input-lengths statement reads the Decisions' sizes.
        (
            "input lengths",
            "ALTER TABLE narrative_proposal_decisions RENAME TO grw_bak",
            "narrative_proposal_decisions",
            [1, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ),
        // The basis statements read the basis table; the stats statements ran.
        (
            "source basis",
            "ALTER TABLE narrative_revision_source_basis RENAME TO grw_bak",
            "narrative_revision_source_basis",
            [1, 1, 1, 0, 0],
            [1, 1, 0, 0, 0],
        ),
        // Only the live lengths statement reads the Codex relations.
        (
            "live lengths",
            "ALTER TABLE codex_relations RENAME TO grw_bak",
            "codex_relations",
            [1, 1, 1, 1, 1],
            [1, 1, 1, 1, 0],
        ),
    ];
    for (name, ddl, table, attempts, prepares) in breaks {
        let fixture = multi_fixture()?;
        execute(&fixture, ddl)?;
        let (reuse, fresh) = alike(name, &fixture)?;
        let error = reuse
            .outcome
            .result
            .as_ref()
            .expect_err("the break must bite");
        assert!(error.contains(table), "{name}: {error}");
        let reuse_seen = reuse.observed.expect("the loop's holder was made");
        let fresh_seen = fresh.observed.expect("the loop's holder was made");
        assert_eq!(
            reuse_seen.attempts, attempts,
            "{name}: where the loop got to"
        );
        assert_eq!(reuse_seen.prepares, prepares, "{name}");
        assert_eq!(fresh_seen.prepares, prepares, "{name}");
        eprintln!("{name}: {error}; attempts {attempts:?}, prepares {prepares:?}");
    }
    Ok(())
}

// The Semantic-stage failures of DR-GRW-2 answer alike in both forms. Where they
// fall relative to the Revision loop differs: a missing declaration table ends
// before the loop (no holder is made), the registry, binding and marker-row breaks
// let the loop read all four Revisions (prepares 1 against 4) and fail after it,
// and a missing migration table fails at the first Revision's marker check (one
// use of each statement in both forms, so no reuse is exercised there).
#[test]
fn registration_semantic_failures_answer_alike() -> Result<()> {
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
        let fixture = multi_fixture()?;
        execute(&fixture, &ddl)?;
        let (reuse, fresh) = alike(name, &fixture)?;
        assert_ne!(reuse.outcome.result, Ok(true), "{name}");
        eprintln!(
            "{name}: {:?}; prepares reuse {:?} fresh {:?}",
            reuse.outcome.result,
            reuse.observed.map(|seen| seen.prepares),
            fresh.observed.map(|seen| seen.prepares)
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// (b) The stop sweeps.
// ---------------------------------------------------------------------------

// An owner that stops at its n-th `check` ends both forms alike at every check a
// healthy registration makes, and no handle outlives the early return.
#[test]
fn owner_check_stops_end_alike_at_every_check_and_leave_no_statement() -> Result<()> {
    let fixture = multi_fixture()?;
    let checks = register(&fixture, CountingOwner::new(None), false)?.checks;
    assert!(checks > 8, "{checks}");
    // Every one of the first 100 checks (the Semantic stage and the first
    // Revisions), then a stride, then the last 30 (the seal and the postflight).
    let points =
        (1..=checks + 1).filter(|point| *point <= 100 || point % 13 == 0 || *point + 30 > checks);
    for stop_at in points {
        let reuse = register(&fixture, CountingOwner::new(Some(stop_at)), false)?;
        let fresh = register(&fixture, CountingOwner::new(Some(stop_at)), true)?;
        assert_eq!(reuse.outcome, fresh.outcome, "stop at check {stop_at}");
        assert_eq!(
            reuse.live_after, reuse.live_before,
            "stop at check {stop_at}"
        );
        assert_eq!(
            fresh.live_after, fresh.live_before,
            "stop at check {stop_at}"
        );
        if stop_at <= checks {
            let error = reuse
                .outcome
                .result
                .as_ref()
                .expect_err("the owner stops it");
            assert!(error.contains("TEST_OWNER_STOP"), "{stop_at}: {error}");
        } else {
            assert_eq!(reuse.outcome.result, Ok(true));
        }
    }
    eprintln!("owner check stops: {checks} checks, the sweep covered the first 100, a stride and the last 30; both forms alike");
    Ok(())
}

// A stop that is a state (SQLite's progress callback sees it, as does every later
// `check`) ends both forms in the typed stop, with no seal and no handle left,
// wherever it lands: between statements, in the middle of one, in the Rust side.
// The reuse form runs fewer callbacks, so a stop at the k-th callback is not at
// the same point in the two; only the end is compared.
#[test]
fn state_stops_end_in_the_typed_stop_in_both_forms_and_leave_no_statement() -> Result<()> {
    let fixture = multi_fixture()?;
    let reuse_callbacks = register(&fixture, CountingOwner::new(None), false)?.callbacks;
    let fresh_callbacks = register(&fixture, CountingOwner::new(None), true)?.callbacks;
    assert!(reuse_callbacks <= fresh_callbacks);
    assert!(reuse_callbacks >= 8, "{reuse_callbacks}");
    let mut points: Vec<u64> = (1..=reuse_callbacks).collect();
    points.retain(|point| *point <= 40 || point % 7 == 0 || *point == reuse_callbacks);
    for stop_at in points {
        for fresh in [false, true] {
            let run = register(
                &fixture,
                CountingOwner::stopping_at_callback(stop_at),
                fresh,
            )?;
            assert!(
                run.outcome.terminated,
                "stop at callback {stop_at} (fresh {fresh}): {:?}",
                run.outcome.result
            );
            assert!(run.outcome.seal.is_none());
            assert!(run.outcome.scope_closed);
            assert_eq!(
                run.live_after, run.live_before,
                "stop at callback {stop_at} (fresh {fresh}) left a statement"
            );
        }
    }
    // Between the two counts the oracle is still stopped and the reuse form is not
    // reached by the stop (it completes), as when the shortcut saved callbacks.
    if reuse_callbacks < fresh_callbacks {
        let stop_at = reuse_callbacks + 1;
        let fresh = register(&fixture, CountingOwner::stopping_at_callback(stop_at), true)?;
        assert!(fresh.outcome.terminated, "{:?}", fresh.outcome.result);
        let reuse = register(
            &fixture,
            CountingOwner::stopping_at_callback(stop_at),
            false,
        )?;
        assert_eq!(reuse.outcome.result, Ok(true));
    }
    eprintln!("state stops: {reuse_callbacks} callbacks (oracle {fresh_callbacks}), all end typed");
    Ok(())
}

// ---------------------------------------------------------------------------
// (c) The handle's lifetime.
// ---------------------------------------------------------------------------

/// Counts the connection's open statements at every owner check and can panic at
/// one of them.
struct LiveProbe<'conn> {
    conn: &'conn Connection,
    live: Vec<usize>,
    /// At every check, how many statements over the Revision tables were busy
    /// (stepped and not reset). The owner checks run between the steps, so none
    /// may be: each statement is reset before the next one is prepared or run
    /// (DR-CQL-13).
    busy: Vec<usize>,
    panic_at: Option<usize>,
}

/// How many statements are busy that read a Revision or its basis. The roster's
/// page statement (which is busy while its rows are read) reads neither.
fn busy_revision_statements(conn: &Connection) -> usize {
    // SAFETY: a read-only walk of the connection's statements on its own thread.
    unsafe {
        let db = conn.handle();
        let mut busy = 0;
        let mut statement = rusqlite::ffi::sqlite3_next_stmt(db, std::ptr::null_mut());
        while !statement.is_null() {
            if rusqlite::ffi::sqlite3_stmt_busy(statement) != 0 {
                let sql = std::ffi::CStr::from_ptr(rusqlite::ffi::sqlite3_sql(statement))
                    .to_string_lossy();
                if sql.contains("narrative_proposal_revisions")
                    || sql.contains("narrative_revision_source_basis")
                {
                    busy += 1;
                }
            }
            statement = rusqlite::ffi::sqlite3_next_stmt(db, statement);
        }
        busy
    }
}

impl GraphWorkControl for LiveProbe<'_> {
    fn check(&mut self, _: GraphWorkStage) -> Result<()> {
        self.live.push(live_statements(self.conn));
        self.busy.push(busy_revision_statements(self.conn));
        if self.panic_at == Some(self.live.len()) {
            panic!("TEST_OWNER_PANIC");
        }
        Ok(())
    }
    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

fn read_with<T>(
    fixture: &Fixture,
    fresh: bool,
    panic_at: Option<usize>,
    inspect: impl FnOnce(
        &Connection,
        std::thread::Result<Result<index::GraphEligibilitySource>>,
        Vec<usize>,
        usize,
    ) -> Result<T>,
) -> Result<T> {
    fixture.authority.with_read_transaction(|conn| {
        let before = live_statements(conn);
        // The probe observes the connection's statements at each owner check
        // while the read holds `&mut Connection`: it watches through its own
        // non-owning wrapper over the same handle (test-only, DR-DBC-4).
        let observer = crate::test_support::same_handle_writer(conn);
        let mut probe = LiveProbe {
            conn: &observer,
            live: Vec::new(),
            busy: Vec::new(),
            panic_at,
        };
        let mut scope = |operation: &mut dyn FnMut()| {
            operation();
            true
        };
        take_revision_statements_observation();
        let mut run = || {
            index::read_eligibility_source_with_control_and_scratch(
                conn,
                PROJECT,
                &mut probe,
                &mut scope,
                Some(REGISTRATION_A2_LIMIT),
            )
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if fresh {
                with_fresh_statements(&mut run)
            } else {
                run()
            }
        }));
        assert!(
            probe.busy.iter().all(|busy| *busy == 0),
            "a statement over a Revision was still busy at an owner check: {:?}",
            probe.busy
        );
        assert!(!probe.busy.is_empty());
        inspect(conn, result, probe.live, before)
    })
}

// The reuse form holds its statements between Revisions (more handles open at
// the owner checks than before the read), the oracle does not, and in both the
// read ends with the count it started with. Nothing is left on success.
#[test]
fn reuse_holds_statements_between_revisions_and_finalizes_them_at_the_end() -> Result<()> {
    let fixture = multi_fixture()?;
    let mut sources = Vec::new();
    for fresh in [false, true] {
        let (source, peak, before, after, observed) =
            read_with(&fixture, fresh, None, |conn, result, live, before| {
                let source = result.expect("no panic")?;
                let observed = take_revision_statements_observation();
                Ok((
                    source,
                    live.iter().copied().max().unwrap(),
                    before,
                    live_statements(conn),
                    observed,
                ))
            })?;
        assert_eq!(
            after, before,
            "fresh {fresh}: a statement outlived the read"
        );
        if fresh {
            assert_eq!(
                peak,
                before + 1,
                "the oracle holds no statement between uses"
            );
        } else {
            assert!(
                peak >= before + 5,
                "reuse holds five: peak {peak} over {before}"
            );
            assert_eq!(observed.unwrap().prepares, [1; 5]);
        }
        sources.push(source);
    }
    assert_eq!(sources[0], sources[1], "the same roster and digest");
    Ok(())
}

// An unwind out of the owner's check, at every check of the read, finalizes the
// statements the holder still has, on the way out and before the caller sees the
// panic. The holder's drop ran (it left its observation).
#[test]
fn an_unwind_finalizes_the_statements_at_every_check() -> Result<()> {
    let fixture = multi_fixture()?;
    let checks = read_with(&fixture, false, None, |_, result, live, _| {
        result.expect("no panic")?;
        Ok(live.len())
    })?;
    assert!(checks > 8, "{checks}");
    // The first 100 checks cover the stage checks and the first Revisions; then a
    // stride, and the last 30 (the roster sort and the Material checks).
    for panic_at in
        (1..=checks).filter(|point| *point <= 100 || point % 13 == 0 || *point + 30 > checks)
    {
        let (panicked, before, after, observed) = read_with(
            &fixture,
            false,
            Some(panic_at),
            |conn, result, live, before| {
                assert_eq!(live.len(), panic_at);
                Ok((
                    result.is_err(),
                    before,
                    live_statements(conn),
                    take_revision_statements_observation(),
                ))
            },
        )?;
        assert!(panicked, "check {panic_at} must panic");
        assert_eq!(after, before, "panic at check {panic_at} left a statement");
        // The first checks come before any statement is used; the holder is
        // created before the loop, so it drops (and observes) whenever the read
        // got that far.
        if panic_at > 2 {
            assert!(observed.is_some(), "panic at check {panic_at}");
        }
    }
    Ok(())
}

// The build path (admission and the native build's read) goes through the same
// function and the same holder; both forms prepare, publish and leave no handle.
#[test]
fn the_build_path_reads_alike_and_leaves_no_statement() -> Result<()> {
    let mut outcomes = Vec::new();
    for fresh in [false, true] {
        let fixture = multi_fixture()?;
        let runtime = fixture.authority.nir_chronicle_index_runtime();
        let (outcome, observed, before, after) =
            fixture.authority.with_read_transaction(|conn| {
                let before = live_statements(conn);
                take_revision_statements_observation();
                let mut run = || prepare_graph_index_build(conn, runtime, PROJECT).map(|_| ());
                let result = if fresh {
                    with_fresh_statements(run)
                } else {
                    run()
                };
                Ok((
                    result.map_err(|error| format!("{error:#}")),
                    take_revision_statements_observation(),
                    before,
                    live_statements(conn),
                ))
            })?;
        assert_eq!(outcome, Ok(()), "fresh {fresh}");
        assert_eq!(after, before, "fresh {fresh}");
        let observed = observed.expect("the build read the source");
        assert_eq!(observed.prepares, if fresh { [4; 5] } else { [1; 5] });
        outcomes.push(outcome);
    }
    assert_eq!(outcomes[0], outcomes[1]);
    Ok(())
}

// ---------------------------------------------------------------------------
// Memory.
// ---------------------------------------------------------------------------

// What the five held statements cost: MemUsed of the compiled programs (the
// program, the SQL text and the bindings; reset releases the rest). They stay in
// Q until the read ends, so the registration's Q gains at most this.
#[test]
fn held_statements_are_small_even_after_a_payload_shaped_revision() -> Result<()> {
    for (name, fixture) in [
        ("seed", Fixture::new()?),
        (
            "payload-shaped 600000",
            Fixture::with_payload_shape(PAYLOAD_SHAPED_COUNTED_BYTES)?,
        ),
    ] {
        let seen = read_with(&fixture, false, None, |_, result, _, _| {
            result.expect("no panic")?;
            Ok(take_revision_statements_observation().expect("the holder dropped"))
        })?;
        let sum: i32 = seen.mem_used.iter().sum();
        eprintln!(
            "STATEMENT-MEMUSED {name}: MemUsed {:?}, sum {sum} B; prepares {:?}",
            seen.mem_used, seen.prepares
        );
        assert!(sum > 0 && sum < 1 << 20, "{name}: {sum}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The capacity fixtures: ineligible candidates of every kind among qualified ones.
// ---------------------------------------------------------------------------

// A project whose candidates are mostly ineligible (decisionless, rejected, a
// drifted Source, a stale Freshness, a drifted Scope, or a report case) reads to
// the same roster and digest in both forms; the reuse form prepares each statement
// once for all of them. (The fixture builder is a diagnostics feature.)
#[cfg(feature = "nir1-material-diagnostics")]
#[test]
fn the_source_read_is_alike_over_ineligible_candidates_of_every_kind() -> Result<()> {
    use crate::narrative_extraction::nir1_capacity_fixtures::{
        build_fixture_from_manifest, NIR1_CAPACITY_FIXTURE_PROJECT_ID,
    };
    use crate::narrative_extraction::source_revision::ForegroundValidationControl;

    let directory = std::env::temp_dir().join(format!("nir1-grw3-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let manifest = directory.join("manifest.json");
    std::fs::write(
        &manifest,
        r#"{
            "schemaVersion": "nir1-capacity/1",
            "diagnosticOnly": true,
            "fixtures": [
                {"id": "Q513/R3/D10", "qualifiedMaterials": 513, "qualifiedRevisions": 3, "ineligibleCandidates": 10},
                {"id": "D2064/report-heavy", "ineligibleCandidates": 10}
            ]
        }"#,
    )?;
    let result = (|| -> Result<()> {
        for (case, candidates) in [("Q513/R3/D10", 13usize), ("D2064/report-heavy", 10)] {
            let path = directory.join(format!("{}.db", case.replace('/', "-")));
            build_fixture_from_manifest(&manifest, case, &path)?;
            let db = crate::Database::new(&path)?;
            let mut reads = Vec::new();
            for fresh in [false, true] {
                let (read, observed) = db.with_read_transaction(|conn| {
                    let before = live_statements(conn);
                    take_revision_statements_observation();
                    let mut run = || {
                        index::read_eligibility_source_with_control(
                            conn,
                            NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                            &mut ForegroundValidationControl,
                        )
                    };
                    let read = if fresh {
                        with_fresh_statements(run)
                    } else {
                        run()
                    };
                    assert_eq!(live_statements(conn), before, "{case} (fresh {fresh})");
                    Ok((read, take_revision_statements_observation()))
                })?;
                reads.push((
                    read.map_err(|error| format!("{error:#}")),
                    observed.expect("read"),
                ));
            }
            let (reuse, reuse_seen) = &reads[0];
            let (fresh, fresh_seen) = &reads[1];
            assert_eq!(reuse, fresh, "{case}");
            assert_eq!(reuse_seen.prepares[0], 1, "{case}");
            assert_eq!(fresh_seen.prepares[0], candidates, "{case}");
            assert_eq!(reuse_seen.runs[0], candidates as i32, "{case}");
            assert_eq!(reuse_seen.reprepares, [0; 5], "{case}");
            for slot in 0..5 {
                assert!(
                    reuse_seen.prepares[slot] <= 1,
                    "{case}: {:?}",
                    reuse_seen.prepares
                );
                assert!(fresh_seen.prepares[slot] >= reuse_seen.prepares[slot]);
            }
            eprintln!(
                "{case}: {} candidates; prepares fresh {:?} / reuse {:?}; roster {}",
                candidates,
                fresh_seen.prepares,
                reuse_seen.prepares,
                reuse.as_ref().map_or(0, |source| source.roster.len())
            );
        }
        Ok(())
    })();
    std::fs::remove_dir_all(&directory)?;
    result
}

// The SQLite heap while the first three steps run, with the statements reused and
// as they were prepared per use (an in-process stand-in for the worker's Q high
// water by interval: the worker's Q holds SQLite's allocations, whatever the
// scope, and the statements' Rust side is no larger than a pointer). The reused
// statements keep their compiled programs, so the heap in use after a step is
// higher by about their MemUsed and not by anything the step built: the peak of
// a step must not rise by more than the programs held before it.
#[test]
#[ignore = "the SQLite heap counter is process-wide: run alone with --test-threads=1"]
fn the_sqlite_heap_peak_of_each_step_rises_by_no_more_than_the_held_programs() -> Result<()> {
    let fixture = Fixture::with_payload_shape(PAYLOAD_SHAPED_COUNTED_BYTES)?;
    let revision = fixture.revision.clone();
    let measure = |fresh: bool| -> Result<Vec<[(i64, i64); 3]>> {
        fixture.authority.with_read_transaction(|conn| {
            let run = || index::measure_statement_peaks(conn, PROJECT, &revision, 3);
            if fresh {
                with_fresh_statements(run)
            } else {
                run()
            }
        })
    };
    let fresh = measure(true)?;
    let reuse = measure(false)?;
    let mut worst_rise = 0i64;
    for (round, (before, after)) in fresh.iter().zip(&reuse).enumerate() {
        for step in 0..3 {
            let (peak_before, in_use_before) = before[step];
            let (peak_after, in_use_after) = after[step];
            eprintln!(
                "HEAP-PEAK round {round} step {step}: peak {peak_before} -> {peak_after} B ({:+}), in use at the end {in_use_before} -> {in_use_after} B",
                peak_after - peak_before
            );
            worst_rise = worst_rise.max(peak_after - peak_before);
        }
    }
    // The five programs together are about 0.15 MB (MemUsed).
    assert!(
        worst_rise < 400_000,
        "a step's SQLite heap peak rose by {worst_rise} B"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// A statement that is reused never answers with an earlier Revision's value.
// ---------------------------------------------------------------------------

/// The answers of the first three steps over `order` in both forms, on one
/// connection: the reuse form first.
type Trace = Vec<(String, i32)>;

fn traces(fixture: &Fixture, order: &[String]) -> Result<(Trace, Trace)> {
    fixture.authority.with_read_transaction(|conn| {
        let reuse = index::stage_trace(conn, PROJECT, order);
        let fresh = with_fresh_statements(|| index::stage_trace(conn, PROJECT, order));
        Ok((reuse, fresh))
    })
}

// Only the third Revision differs, and only in what one statement answers. A
// statement that kept the value of the Revision before it would answer the
// third like the second; the answers of both forms must be the same, and the
// third's must be the broken one.
#[test]
fn a_reused_statement_answers_for_the_revision_in_front_of_it() -> Result<()> {
    type Break = fn(&Fixture, &str) -> Result<()>;
    let cases: [(&str, Break, &str); 3] = [
        // More records than a Revision may carry: the JSON counts say so.
        (
            "input counts",
            |fixture, revision| {
                fixture.authority.with_conn(|conn| {
                conn.execute_batch(
                    "DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard",
                )?;
                conn.execute(
                    "UPDATE narrative_proposal_revisions
                        SET payload_json = '{\"bundle\":{\"entities\":['
                            || (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 700)
                                SELECT group_concat('{}') FROM c)
                            || '],\"relations\":[]}}'
                      WHERE id = ?1",
                    [revision],
                )?;
                Ok(())
            })
            },
            "stats=None",
        ),
        // Only the Relation's basis row differs: the Relation statement says so.
        (
            "basis relation",
            |fixture, revision| {
                fixture.authority.with_conn(|conn| {
                    conn.execute_batch("DROP TRIGGER narrative_source_basis_immutable_update")?;
                    conn.execute(
                        "UPDATE narrative_revision_source_basis SET revision_token = 'tampered'
                      WHERE revision_id = ?1 AND source_kind = 'codex-relation'",
                        [revision],
                    )?;
                    Ok(())
                })
            },
            "stats=Some(5) basis=false",
        ),
        // The payload and the basis agree on a Source token that the live Source
        // no longer has: the live-lengths statement says so.
        (
            "live lengths",
            |fixture, revision| {
                fixture.authority.with_conn(|conn| {
                    conn.execute_batch(
                        "DROP TRIGGER narrative_source_basis_immutable_update;
                     DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard",
                    )?;
                    let tokens: Vec<String> = conn
                        .prepare(
                            "SELECT revision_token FROM narrative_revision_source_basis
                          WHERE revision_id = ?1 AND source_kind = 'codex-entry'",
                        )?
                        .query_map([revision], |row| row.get(0))?
                        .collect::<std::result::Result<_, _>>()?;
                    assert!(!tokens.is_empty());
                    for token in tokens {
                        let stale = format!("{token}#stale");
                        conn.execute(
                            "UPDATE narrative_proposal_revisions
                            SET payload_json = replace(payload_json, ?2, ?3) WHERE id = ?1",
                            params![revision, token, stale],
                        )?;
                        conn.execute(
                            "UPDATE narrative_revision_source_basis SET revision_token = ?3
                          WHERE revision_id = ?1 AND revision_token = ?2",
                            params![revision, token, stale],
                        )?;
                    }
                    Ok(())
                })
            },
            "stats=Some(5) basis=true live=None",
        ),
    ];
    for (name, apply, broken) in cases {
        let fixture = multi_fixture()?;
        let order = scan_order(&fixture)?;
        apply(&fixture, &order[2])?;
        let (reuse, fresh) = traces(&fixture, &order)?;
        let answers = |trace: &[(String, i32)]| -> Vec<String> {
            trace.iter().map(|(answer, _)| answer.clone()).collect()
        };
        assert_eq!(answers(&reuse), answers(&fresh), "{name}");
        eprintln!("{name}: {:?}", answers(&reuse));
        assert!(
            reuse[2].0.starts_with(broken) || reuse[2].0 == broken,
            "{name}: the third Revision must answer {broken}: {:?}",
            answers(&reuse)
        );
        for healthy in [0, 1, 3] {
            assert!(
                reuse[healthy].0.contains("live=Some("),
                "{name}: Revision {healthy}: {:?}",
                answers(&reuse)
            );
        }
    }
    Ok(())
}

// A candidate with no Revision row answers "none" from the first statement
// (`.optional()`) and leaves the statement ready for the Revision after it.
#[test]
fn a_candidate_without_a_revision_row_leaves_the_statements_ready() -> Result<()> {
    let fixture = multi_fixture()?;
    let mut order = scan_order(&fixture)?;
    order.insert(1, "no-such-revision".into());
    order.insert(3, "another-missing-revision".into());
    let (reuse, fresh) = traces(&fixture, &order)?;
    let answers = |trace: &[(String, i32)]| -> Vec<String> {
        trace.iter().map(|(answer, _)| answer.clone()).collect()
    };
    assert_eq!(answers(&reuse), answers(&fresh));
    for (index, answer) in answers(&reuse).iter().enumerate() {
        if index == 1 || index == 3 {
            assert_eq!(answer, "stats=None");
        } else {
            assert!(answer.contains("live=Some("), "{index}: {answer}");
        }
    }
    // The same through the registration: a proposal whose current Revision has no
    // row sits among the candidates.
    execute(
        &fixture,
        "PRAGMA foreign_keys = OFF;
         INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json,
             current_revision_id, created_at, updated_at)
         SELECT 'dangling-proposal', proposal_set_id, 'dangling', kind, 'draft', '{}',
                'dangling-revision', created_at, updated_at
           FROM narrative_proposals LIMIT 1",
    )?;
    let (reuse, fresh) = alike("dangling candidate", &fixture)?;
    eprintln!("dangling candidate: {:?}", reuse.outcome.result);
    assert_eq!(reuse.observed.unwrap().attempts[0], 5);
    assert_eq!(fresh.observed.unwrap().attempts[0], 5);
    Ok(())
}

// ---------------------------------------------------------------------------
// What a held statement keeps.
// ---------------------------------------------------------------------------

/// A copy of `source` (its row and its basis rows) under the id `new_id`.
fn clone_revision(fixture: &Fixture, source: &str, new_id: &str) -> Result<()> {
    fixture.authority.with_conn(|conn| {
        conn.execute_batch("PRAGMA foreign_keys = OFF")?;
        conn.execute(
            "CREATE TEMP TABLE grw_rev AS SELECT * FROM narrative_proposal_revisions WHERE id = ?1",
            [source],
        )?;
        conn.execute(
            "UPDATE grw_rev SET id = ?1, revision_number = revision_number + 100",
            [new_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_revisions SELECT * FROM grw_rev",
            [],
        )?;
        conn.execute_batch("DROP TABLE grw_rev")?;
        conn.execute(
            "CREATE TEMP TABLE grw_basis AS
               SELECT * FROM narrative_revision_source_basis WHERE revision_id = ?1",
            [source],
        )?;
        conn.execute("UPDATE grw_basis SET revision_id = ?1", [new_id])?;
        conn.execute(
            "INSERT INTO narrative_revision_source_basis SELECT * FROM grw_basis",
            [],
        )?;
        conn.execute_batch("DROP TABLE grw_basis")?;
        Ok(())
    })
}

// rusqlite binds a `&str` as a copy that SQLite keeps until the next bind. A
// Revision id can be long (up to the input limit), so the reused statements clear
// their bindings: after a Revision with a 512 KiB id, the five held statements
// are no larger than after one with a short id.
#[test]
fn held_statements_do_not_keep_the_values_of_the_last_revision() -> Result<()> {
    let fixture = multi_fixture()?;
    let order = scan_order(&fixture)?;
    let long_id = "r".repeat(512 * 1024);
    clone_revision(&fixture, &order[0], &long_id)?;
    let ids = vec![order[1].clone(), long_id.clone(), order[2].clone()];
    let (reuse, fresh) = traces(&fixture, &ids)?;
    for (index, (answer, _)) in reuse.iter().enumerate() {
        assert!(answer.contains("live=Some("), "{index}: {answer}");
        assert_eq!(answer, &fresh[index].0);
    }
    let (short, long, after) = (reuse[0].1, reuse[1].1, reuse[2].1);
    eprintln!("MemUsed of the five held statements: short id {short} B, 512 KiB id {long} B, then short {after} B");
    assert!(
        long <= short + 64 * 1024,
        "the statements kept the long id: {short} B -> {long} B"
    );
    assert!(after <= short + 64 * 1024);
    Ok(())
}

// ---------------------------------------------------------------------------
// Statistics (STAT4) and a held statement.
// ---------------------------------------------------------------------------

// With `sqlite_stat4` SQLite may choose a plan by the bound value, so rebinding can
// make it re-prepare the held statement (`RePrepare`). That costs the saving, not
// the answer: the result is the same as ever.
#[test]
fn analyzed_statistics_change_no_answer() -> Result<()> {
    let fixture = multi_fixture()?;
    execute(&fixture, "ANALYZE")?;
    let stat4 = fixture.authority.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat4'",
            [],
            |row| row.get::<_, i64>(0),
        )?)
    })?;
    let (reuse, fresh) = alike("analyzed", &fixture)?;
    assert_eq!(reuse.outcome.result, Ok(true));
    let seen = reuse.observed.expect("read");
    eprintln!(
        "STAT4: sqlite_stat4 tables {stat4}; RePrepare per statement {:?}; prepares {:?}; fresh prepares {:?}",
        seen.reprepares,
        seen.prepares,
        fresh.observed.map(|seen| seen.prepares)
    );
    Ok(())
}
