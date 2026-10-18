//! DI1B-1: the production history budget, the run's entry for the D-final
//! snapshot and the spike that decides whether the entry can keep the turn
//! going when the history's own SQL ledger is spent.
//!
//! This is a child of `session_history_tests`: it uses the product-writer
//! fixture (`SessionFixture`) of HC1-4.

use super::*;
use crate::narrative_extraction::nir1_history_budget::{
    adoptable_turn_count, create_parent_read_budget, parent_read_cost_in_tx,
    production_history_read_budget, reauthorize_turn_history_in_tx,
    reauthorize_turn_history_with_budget_in_tx, HistoryBudgetWindow, ParentReadCost,
    CREATE_PARENT_READ_BYTES, CREATE_PARENT_READ_ROWS, ENVELOPE_HEAVY_TURNS,
    ENVELOPE_MESSAGE_BODY_BYTES, ENVELOPE_SESSION_ATTEMPTS, HISTORY_MAX_SQL_VM_STEPS,
    HISTORY_MAX_TURNS, HISTORY_REFERENCE_ROWS_PER_MESSAGE,
};
use crate::narrative_extraction::nir1_history_context::TurnHistoryRange;
use crate::narrative_extraction::{
    validation_terminated, HistoryContextStage, ValidationTerminated, ValidationTerminationReason,
};
use crate::narrative_maintenance_connection::ParticipantSqlOperationBudget;
use crate::nir1_generation::AttemptSceneBinding;
use crate::nir1_generation_history::reauthorize_session_history_for_turn;

fn termination(error: &anyhow::Error) -> Option<ValidationTerminationReason> {
    error
        .downcast_ref::<ValidationTerminated>()
        .map(|terminated| terminated.reason)
}

/// The current turn's context made by the builder, read in `conn` (the
/// caller's own snapshot).
fn current_in(conn: &Connection, session: &SessionFixture) -> Result<CurrentHistoryContext> {
    let stage = build_history_context_stage(
        conn,
        PROJECT,
        SCENE,
        session.snapshot.durable_workspace_identity(),
        HistorySendClassification::LocalOnly,
    )?;
    let scene = read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?;
    Ok(stage.current_history_context(
        HistoryRange {
            project_id: PROJECT.into(),
            chat_session_id: SESSION.into(),
            scene_id: SCENE.into(),
            scene_incarnation_id: scene.scene_incarnation_id,
        },
        GenerationPurpose::Writing,
    ))
}

/// A production budget as the D-final prepare of `prepare` would make it.
fn production_budget(prepare: &ParticipantSqlOperationBudget) -> GenerationHistoryReadBudget {
    production_history_read_budget(HistoryBudgetWindow::new(Instant::now(), prepare))
}

/// A D-final-like snapshot: the participant read transaction with the
/// history context stage and the turn's range, both made from what the
/// snapshot read (the accepted capture and the Scene binding).
fn in_snapshot<T>(
    session: &SessionFixture,
    capture: &AcceptedChatInputCapture,
    body: impl FnOnce(
        &Connection,
        &HistoryContextStage,
        &TurnHistoryRange,
        &AttemptSceneBinding,
    ) -> Result<T>,
) -> Result<T> {
    session
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            session.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                let stage = build_history_context_stage(
                    conn,
                    PROJECT,
                    SCENE,
                    session.snapshot.durable_workspace_identity(),
                    HistorySendClassification::LocalOnly,
                )?;
                let scene = read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?;
                let range = TurnHistoryRange::from_snapshot(capture, &scene)?;
                body(conn, &stage, &range, &scene)
            },
        )
}

fn ledger(max_vm_steps: u64, deadline: Instant) -> Option<GenerationHistorySqlLedger> {
    Some(GenerationHistorySqlLedger::new(
        GenerationHistorySnapshotSqlBudget {
            max_vm_steps,
            deadline,
            busy_wait: Duration::from_millis(100),
        },
    ))
}

/// Spike (DI1B-1): when the history's own SQL ledger is spent, the outer
/// D-final participant transaction is still open and usable. The same snapshot
/// goes on reading (the scene binding, the history context, and a whole new
/// history run with a fresh ledger decide exactly as before), and the
/// transaction still ends with a normal commit.
#[test]
fn spike_outer_snapshot_survives_a_spent_history_sql_ledger() -> Result<()> {
    let (session, turns) = chain_session()?;
    let mut probe = SessionFixture::generous_budget();
    let baseline = session.run_with(&mut probe)?;
    let used = probe.sql.as_ref().expect("a ledger").sql_steps_used();
    assert!(used > 1_000);
    for turn in &turns {
        assert_turn_adopted(&baseline, turn);
    }

    // The ledger ends: half of the steps the run needs (a statement is
    // interrupted part-way), a handful of steps (the first statements), and a
    // deadline that elapses while the run is polling (a typed stop between
    // statements).
    enum Spent {
        Steps(u64),
        Deadline,
    }
    for (spent, expected) in [
        (
            Spent::Steps(used / 2),
            ValidationTerminationReason::CapacityExceeded,
        ),
        (
            Spent::Steps(300),
            ValidationTerminationReason::CapacityExceeded,
        ),
        (Spent::Deadline, ValidationTerminationReason::TimedOut),
    ] {
        let outcome_after = session
            .snapshot
            .db()
            .with_participant_read_transaction_bounded(
                session.snapshot.participant(),
                prepared_sql_budget(),
                |conn| {
                    // What the D-final snapshot has read before the history.
                    let scene_before = read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?;
                    let current = current_in(conn, &session)?;
                    assert!(!conn.is_autocommit());

                    let mut short = SessionFixture::generous_budget();
                    let error = match spent {
                        Spent::Steps(steps) => {
                            short.sql = ledger(steps, Instant::now() + Duration::from_secs(60));
                            run_in(conn, &current, &mut short, wall_clock_ms())
                                .expect_err("the ledger is spent")
                        }
                        Spent::Deadline => {
                            short.sql =
                                ledger(u64::MAX / 2, Instant::now() + Duration::from_millis(40));
                            let cancellation = GenerationHistorySnapshotCancellation::from_control(
                                &ParticipantSqlControl::default(),
                            );
                            reauthorize_session_history_in_tx(
                                conn,
                                &cancellation,
                                &mut short,
                                &SessionHistoryRequest {
                                    current: &current,
                                    now_ms: wall_clock_ms(),
                                },
                                &mut || {
                                    std::thread::sleep(Duration::from_millis(15));
                                    false
                                },
                            )
                            .expect_err("the deadline elapses")
                        }
                    };
                    assert_eq!(termination(&error), Some(expected), "{error:#}");

                    // The outer snapshot is intact: still a transaction, and the
                    // reads that follow see what the reads before it saw.
                    assert!(!conn.is_autocommit());
                    assert_eq!(
                        read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?,
                        scene_before
                    );
                    let current_again = current_in(conn, &session)?;
                    assert_eq!(
                        format!("{current_again:?}"),
                        format!("{current:?}"),
                        "the history context read after the stop is the one read before it"
                    );
                    // A whole new history run in the same snapshot, with its own
                    // fresh ledger, decides exactly as the baseline run did.
                    let changes = conn.total_changes();
                    let again = run_in(
                        conn,
                        &current_again,
                        &mut SessionFixture::generous_budget(),
                        wall_clock_ms(),
                    )?;
                    assert_eq!(conn.total_changes(), changes);
                    Ok(again)
                },
            )?;
        assert_eq!(outcome_after, baseline);
    }
    Ok(())
}

/// A budget that no session of the measurement reaches, so that the run's
/// consumption can be read off the difference.
fn roomy_budget() -> GenerationHistoryReadBudget {
    GenerationHistoryReadBudget {
        max_attempts: 100_000,
        sql: ledger(u64::MAX / 4, Instant::now() + Duration::from_secs(3_600)),
        max_candidates: 100_000,
        max_reference_count: 100_000_000,
        max_reference_bytes: 1 << 32,
        max_resolved_body_bytes: 1 << 32,
        remaining_project_authority_rows: 0,
        remaining_nodes: 1_000_000,
        remaining_edges: 10_000_000,
        remaining_qualification_refs: 100_000_000,
    }
}

fn measure_roomy(session: &SessionFixture) -> Result<Measured> {
    let roomy = roomy_budget();
    let mut budget = roomy_budget();
    let started = Instant::now();
    let outcome = session.run_with(&mut budget)?;
    let elapsed_ms = started.elapsed().as_millis();
    if let Some(excluded) = outcome
        .candidates
        .iter()
        .find(|result| result.disposition != CandidateDisposition::Qualified)
    {
        eprintln!("DI1B first excluded: {excluded:?}");
    }
    Ok(Measured {
        nodes: Dimension::Nodes.get(&roomy) - Dimension::Nodes.get(&budget),
        edges: Dimension::Edges.get(&roomy) - Dimension::Edges.get(&budget),
        qualification_refs: Dimension::QualificationRefs.get(&roomy)
            - Dimension::QualificationRefs.get(&budget),
        attempts: Dimension::Attempts.get(&roomy) - Dimension::Attempts.get(&budget),
        reference_count: Dimension::ReferenceCount.get(&roomy)
            - Dimension::ReferenceCount.get(&budget),
        reference_bytes: Dimension::ReferenceBytes.get(&roomy)
            - Dimension::ReferenceBytes.get(&budget),
        body_bytes: Dimension::BodyBytes.get(&roomy) - Dimension::BodyBytes.get(&budget),
        sql_vm_steps: budget.sql.as_ref().expect("a ledger").sql_steps_used(),
        a3_evaluations: outcome.a3_evaluations,
        candidates: outcome.candidates.len(),
        qualified: outcome.qualified().count(),
        elapsed_ms,
    })
}

/// The window the product adopts for the next turn (DI1B-3's packing rule):
/// the newest [`HISTORY_MAX_TURNS`] turns, cut at the first one whose parent
/// does not fit the create's parent read budget (the Native budget), a turn
/// being its Human and, when it succeeded, its output. Bodies are a few bytes,
/// so the token allowance never binds here: this is the widest window the
/// product can make, the one the run has to be able to verify.
fn product_window(session: &SessionFixture, done: &[Turn]) -> Result<Vec<Adopt>> {
    let newest_first: Vec<&Turn> = done.iter().rev().take(HISTORY_MAX_TURNS).collect();
    let mut costs = Vec::with_capacity(newest_first.len());
    for turn in &newest_first {
        costs.push(if turn.output.is_some() {
            session
                .db()
                .with_read_transaction(|conn| parent_read_cost_in_tx(conn, &turn.attempt_id))?
        } else {
            ParentReadCost::default()
        });
    }
    let adopted = adoptable_turn_count(&costs);
    let mut window = Vec::new();
    for turn in newest_first[..adopted].iter().rev() {
        window.push(Adopt::human(turn));
        if turn.output.is_some() {
            window.push(Adopt::output(turn));
        }
    }
    Ok(window)
}

/// Extend a session by one turn the way the product does: the turn adopts the
/// window of [`product_window`] and is created with the Native create budget.
/// Returns the turn and how many turns it adopted.
fn windowed_turn(
    session: &mut SessionFixture,
    done: &[Turn],
    index: usize,
    revisions: Option<&[String]>,
) -> Result<(Turn, usize)> {
    let window = product_window(session, done)?;
    let adopted_turns = window
        .iter()
        .filter(|item| matches!(item, Adopt::Human { .. }))
        .count();
    let mut spec = TurnSpec::new(&format!("request {index}"))
        .reply(&format!("answer {index}"))
        .adopt(&window)
        .create_budget(create_parent_read_budget());
    if let Some(revisions) = revisions {
        spec = spec.revisions(revisions);
    }
    Ok((session.run_turn(spec)?, adopted_turns))
}

/// A session of `length` turns, the first `heavy` of which carry `many`
/// Revisions, each turn adopting the product's window. Returns the turns and
/// the number of turns each adopted.
fn windowed_session(
    session: &mut SessionFixture,
    length: usize,
    heavy: usize,
    many: Option<&[String]>,
) -> Result<(Vec<Turn>, Vec<usize>)> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut adopted = Vec::new();
    for index in 0..length {
        let revisions = if index < heavy { many } else { None };
        let (turn, count) = windowed_turn(session, &turns, index, revisions)?;
        turns.push(turn);
        adopted.push(count);
    }
    Ok((turns, adopted))
}

/// The positive envelope of the production budget (DI1B-1): the long
/// session and the Revision-heavy turns, alone and together, every turn
/// adopting the window the product makes (up to [`HISTORY_MAX_TURNS`] turns,
/// cut by the create's parent read budget). Run alone:
/// `cargo test --features native-current-human-capture --lib
/// history_budget_tests::di1b_measurement -- --ignored --nocapture`.
#[test]
#[ignore = "DI-1b measurement harness: run alone, its output goes to the decisions record"]
fn di1b_measurement() -> Result<()> {
    let note = |label: &str, measured: &Measured, adopted: &[usize]| {
        let smallest = adopted.iter().copied().skip(HISTORY_MAX_TURNS).min();
        eprintln!(
            "DI1B {label}: {measured:?} turns adopted: last {:?}, smallest after the window fills {smallest:?}, widest {:?}",
            adopted.last(),
            adopted.iter().max()
        );
    };
    // The longest session of the envelope: chained turns with the fixture's
    // two Revisions each.
    let mut session = SessionFixture::new()?;
    let (_, adopted) = windowed_session(&mut session, ENVELOPE_SESSION_ATTEMPTS, 0, None)?;
    session.accept("next", "next")?;
    note(
        "light session, whole envelope",
        &measure_roomy(&session)?,
        &adopted,
    );

    // Revision-heavy turns that follow one another: 102 Revisions each.
    let mut session = SessionFixture::new()?;
    let many = approve_small_revisions(session.db(), 102)?;
    let (_, adopted) = windowed_session(
        &mut session,
        ENVELOPE_HEAVY_TURNS,
        ENVELOPE_HEAVY_TURNS,
        Some(&many),
    )?;
    session.accept("next", "next")?;
    note(
        "heavy turns, whole envelope",
        &measure_roomy(&session)?,
        &adopted,
    );

    // Both together in one session: the heavy turns first, then light turns
    // up to the longest session.
    let mut session = SessionFixture::new()?;
    let many = approve_small_revisions(session.db(), 102)?;
    let (_, adopted) = windowed_session(
        &mut session,
        ENVELOPE_SESSION_ATTEMPTS,
        ENVELOPE_HEAVY_TURNS,
        Some(&many),
    )?;
    session.accept("last", "last")?;
    note(
        "heavy turns then light turns, whole envelope",
        &measure_roomy(&session)?,
        &adopted,
    );

    // Outside the envelope, for the record: every turn of a long session
    // carries many Revisions (30 and 12 of them).
    for revisions in [30usize, 12] {
        let mut session = SessionFixture::new()?;
        let many = approve_small_revisions(session.db(), revisions)?;
        let (_, adopted) = windowed_session(
            &mut session,
            ENVELOPE_SESSION_ATTEMPTS,
            ENVELOPE_SESSION_ATTEMPTS,
            Some(&many),
        )?;
        session.accept("last", "last")?;
        note(
            &format!("outside the envelope: every turn {revisions} Revisions"),
            &measure_roomy(&session)?,
            &adopted,
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The entry for the D-final snapshot
// ---------------------------------------------------------------------------

/// A D-final snapshot that spends the history's SQL ledger, its deadline or
/// its steps does not lose the snapshot: the turn goes on without history and
/// the reads that follow, and a whole new history run, are the same as before.
#[test]
fn sql_capacity_and_deadline_continue_without_history() -> Result<()> {
    let (session, turns) = chain_session()?;
    let (capture, _) = session.accept("probe", "probe")?;
    let prepare = prepared_sql_budget();
    let never_stops = &mut || Ok(());
    in_snapshot(&session, &capture, |conn, stage, range, scene| {
        let started = Instant::now();
        let run = |budget: GenerationHistoryReadBudget,
                   owner_check: &mut dyn FnMut() -> Result<()>| {
            reauthorize_turn_history_with_budget_in_tx(
                conn,
                stage,
                range,
                GenerationPurpose::Writing,
                wall_clock_ms(),
                &prepare,
                budget,
                owner_check,
            )
        };
        let baseline = reauthorize_turn_history_in_tx(
            conn,
            stage,
            range,
            GenerationPurpose::Writing,
            wall_clock_ms(),
            started,
            &prepare,
            never_stops,
        )?;
        assert_eq!(baseline.without_history, None);
        for turn in &turns {
            assert_turn_adopted(&baseline, turn);
        }

        // 1. The VM-step ledger ends part-way through the run.
        let mut few_steps = production_budget(&prepare);
        few_steps.sql = ledger(300, Instant::now() + Duration::from_secs(60));
        let outcome = run(few_steps, never_stops)?;
        assert_eq!(
            outcome.without_history,
            Some(NoHistory::SqlCapacityExhausted)
        );
        assert!(
            outcome.candidates.is_empty(),
            "no part of a stopped run is kept"
        );

        // 2. The history's deadline elapses while the run is polling.
        let mut late = production_budget(&prepare);
        late.sql = ledger(u64::MAX / 4, Instant::now() + Duration::from_millis(40));
        let outcome = run(late, &mut || {
            std::thread::sleep(Duration::from_millis(15));
            Ok(())
        })?;
        assert_eq!(outcome.without_history, Some(NoHistory::SqlDeadlineElapsed));
        assert!(outcome.candidates.is_empty());

        // 3. The prepare operation leaves less than the tail the rest of the
        // read keeps: the history deadline is already past and nothing is read.
        let tight = ParticipantSqlOperationBudget::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(2),
            Duration::from_millis(100),
        );
        let outcome = reauthorize_turn_history_in_tx(
            conn,
            stage,
            range,
            GenerationPurpose::Writing,
            wall_clock_ms(),
            Instant::now(),
            &tight,
            never_stops,
        )?;
        assert_eq!(outcome.without_history, Some(NoHistory::SqlDeadlineElapsed));

        // The outer snapshot is intact after each of those: the D-final
        // reads that follow see the same values, and a new run with a new
        // budget decides as the first one did.
        assert!(!conn.is_autocommit());
        assert_eq!(
            &read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?,
            scene
        );
        let again = reauthorize_turn_history_in_tx(
            conn,
            stage,
            range,
            GenerationPurpose::Writing,
            wall_clock_ms(),
            Instant::now(),
            &prepare,
            never_stops,
        )?;
        assert_eq!(again, baseline);
        Ok(())
    })
}

/// A cancel is not "no history": the owner's own typed error stops the turn,
/// whether it comes from D-final's checkpoint, from the participant's stop
/// flag or as an error of another kind. A stopped run keeps no partial result.
#[test]
fn cancel_stops_the_turn() -> Result<()> {
    let (session, _turns) = chain_session()?;
    let (capture, _) = session.accept("probe", "probe")?;
    let prepare = prepared_sql_budget();
    in_snapshot(&session, &capture, |conn, stage, range, _| {
        let run = |prepare: &ParticipantSqlOperationBudget,
                   owner_check: &mut dyn FnMut() -> Result<()>| {
            reauthorize_turn_history_in_tx(
                conn,
                stage,
                range,
                GenerationPurpose::Writing,
                wall_clock_ms(),
                Instant::now(),
                prepare,
                owner_check,
            )
        };
        // D-final's checkpoint stops part-way through.
        let mut polls = 0;
        let error = run(&prepare, &mut || {
            polls += 1;
            if polls > 4 {
                return Err(validation_terminated(
                    ValidationTerminationReason::Cancelled,
                    "the turn was cancelled",
                ));
            }
            Ok(())
        })
        .expect_err("a cancelled turn is an error");
        assert_eq!(
            termination(&error),
            Some(ValidationTerminationReason::Cancelled)
        );
        // The operation's own deadline: the owner's TimedOut is the turn's
        // error, not "no history".
        let mut polls = 0;
        let error = run(&prepare, &mut || {
            polls += 1;
            if polls > 4 {
                return Err(validation_terminated(
                    ValidationTerminationReason::TimedOut,
                    "the prepare deadline elapsed",
                ));
            }
            Ok(())
        })
        .expect_err("the prepare deadline stops the turn");
        assert_eq!(
            termination(&error),
            Some(ValidationTerminationReason::TimedOut)
        );
        // An error of another kind from the owner is returned as it is.
        let error = run(&prepare, &mut || Err(anyhow::anyhow!("NIR1_OWNER_FAILED")))
            .expect_err("an owner error stops the turn");
        assert!(format!("{error:#}").contains("NIR1_OWNER_FAILED"));
        // The participant's stop flag, observed by the run itself.
        let stopped = ParticipantSqlOperationBudget::new(
            Arc::new(AtomicBool::new(true)),
            Instant::now() + Duration::from_secs(20),
            Duration::from_millis(100),
        );
        let error = run(&stopped, &mut || Ok(())).expect_err("a stopped owner");
        assert_eq!(
            termination(&error),
            Some(ValidationTerminationReason::Cancelled)
        );
        // Nothing was written and the snapshot is still open.
        assert!(!conn.is_autocommit());
        Ok(())
    })
}

/// A SQLite error (here: a table the run reads is gone) is not "no history":
/// it stops the turn with that error. The change is rolled back with the
/// snapshot.
#[test]
fn sqlite_error_stops_the_turn() -> Result<()> {
    let (session, turns) = chain_session()?;
    let (capture, _) = session.accept("probe", "probe")?;
    let error = in_snapshot(&session, &capture, |conn, stage, range, _| {
        conn.execute_batch(
            "ALTER TABLE nir1_generation_attempts RENAME TO nir1_generation_attempts_gone",
        )?;
        reauthorize_turn_history_in_tx(
            conn,
            stage,
            range,
            GenerationPurpose::Writing,
            wall_clock_ms(),
            Instant::now(),
            &prepared_sql_budget(),
            &mut || Ok(()),
        )
        .map(|_| ())
    })
    .expect_err("a failed read stops the turn");
    assert!(
        format!("{error:#}").contains("nir1_generation_attempts"),
        "{error:#}"
    );
    assert!(
        error
            .chain()
            .any(|cause| cause.downcast_ref::<rusqlite::Error>().is_some()),
        "the SQLite error is kept: {error:#}"
    );
    // The snapshot was rolled back: the table is back and the run decides.
    let outcome = session.run()?;
    for turn in &turns {
        assert_turn_adopted(&outcome, turn);
    }
    Ok(())
}

/// The busy wait of the history's own transaction is its ledger's: a lock
/// held for less than the allowance is waited out, one held beyond it ends
/// the history (not the turn). The database is in rollback-journal mode for
/// this test, the only mode in which a reader can be made to wait.
#[test]
fn busy_wait_n_and_n_plus_one() -> Result<()> {
    let directory = std::env::temp_dir().join(format!("di1b-busy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("grimodex.db");
    let result = (|| -> Result<()> {
        let mut session = SessionFixture::new_on_file(&path)?;
        let first = session.turn("First.", &[], Some("First answer."))?;
        session.accept("next", "next")?;
        let current = session
            .snapshot
            .db()
            .with_participant_read_transaction_bounded(
                session.snapshot.participant(),
                prepared_sql_budget(),
                |conn| current_in(conn, &session),
            )?;
        session
            .db()
            .with_conn(|conn| Ok(conn.execute_batch("PRAGMA journal_mode=DELETE")?))?;

        let with_busy_wait = |busy_wait: Duration| {
            let mut budget = SessionFixture::generous_budget();
            budget.sql = Some(GenerationHistorySqlLedger::new(
                GenerationHistorySnapshotSqlBudget {
                    max_vm_steps: 500_000_000,
                    deadline: Instant::now() + Duration::from_secs(30),
                    busy_wait,
                },
            ));
            let started = Instant::now();
            let outcome = reauthorize_session_history_for_turn(
                &session.snapshot,
                ParticipantSqlControl::default(),
                &mut budget,
                &SessionHistoryRequest {
                    current: &current,
                    now_ms: wall_clock_ms(),
                },
                &mut || false,
            );
            (outcome, started.elapsed())
        };
        let hold = || -> Result<Connection> {
            let blocker = Connection::open(&path)?;
            blocker.busy_timeout(Duration::ZERO)?;
            blocker.execute_batch(
                "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS di1b_busy(a); INSERT INTO di1b_busy VALUES (1);",
            )?;
            Ok(blocker)
        };

        // N + 1: the lock outlasts the allowance. The wait is the allowance
        // (not the connection's 5 s), and the turn goes on without history.
        let blocker = hold()?;
        let (outcome, elapsed) = with_busy_wait(Duration::from_millis(60));
        let outcome = outcome?;
        assert_eq!(
            outcome.without_history,
            Some(NoHistory::SqlBusy),
            "{outcome:?}"
        );
        assert!(outcome.candidates.is_empty());
        assert!(elapsed >= Duration::from_millis(55), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        blocker.execute_batch("ROLLBACK")?;
        drop(blocker);

        // N: the lock is released inside the allowance and the run waits it out.
        let blocker = hold()?;
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            blocker.execute_batch("ROLLBACK")
        });
        let (outcome, elapsed) = with_busy_wait(Duration::from_secs(5));
        release.join().expect("the lock holder")?;
        let outcome = outcome?;
        assert_eq!(outcome.without_history, None, "{outcome:?}");
        assert_turn_adopted(&outcome, &first);
        assert!(
            elapsed >= Duration::from_millis(100),
            "it waited: {elapsed:?}"
        );

        // A zero allowance refuses to wait at all.
        let blocker = hold()?;
        let (outcome, elapsed) = with_busy_wait(Duration::ZERO);
        assert_eq!(outcome?.without_history, Some(NoHistory::SqlBusy));
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        blocker.execute_batch("ROLLBACK")?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&directory);
    result
}

/// The range of a turn is made from the capture and the Scene binding the
/// snapshot read, nothing else; a pair that names two Scenes is refused.
#[test]
fn history_range_comes_from_the_snapshot_not_the_caller() -> Result<()> {
    let (session, _turns) = chain_session()?;
    let (capture, _) = session.accept("probe", "probe")?;
    in_snapshot(&session, &capture, |conn, stage, range, scene| {
        assert_eq!(
            range.range(),
            &HistoryRange {
                project_id: capture.project_id().to_owned(),
                chat_session_id: capture.chat_session_id().to_owned(),
                scene_id: scene.scene_id.clone(),
                scene_incarnation_id: scene.scene_incarnation_id.clone(),
            }
        );
        assert_eq!(range.range().chat_session_id, SESSION);
        assert_eq!(range.range().scene_id, SCENE);
        // The context the run compares with is the stage's own, in that range.
        assert_eq!(
            stage.current_history_context_for_turn(range, GenerationPurpose::Writing),
            stage.current_history_context(range.range().clone(), GenerationPurpose::Writing)
        );
        // A binding of another Scene does not make a range for this capture.
        let other = read_attempt_scene_binding_in_tx(conn, PROJECT, ANCHOR)?;
        assert_ne!(other.scene_id, capture.scene_id());
        let error = TurnHistoryRange::from_snapshot(&capture, &other)
            .expect_err("two Scenes are not one turn");
        assert!(format!("{error:#}").contains("NIR1_HISTORY_RANGE_SCENE_MISMATCH"));
        Ok(())
    })
}

/// The run reads and nothing else: no row changes, and a write that the run
/// (or a poll made inside it) attempts is refused by the connection itself.
/// The refusal is the run's alone: once it ends the connection writes again.
#[test]
fn history_run_writes_nothing_in_the_d_final_snapshot() -> Result<()> {
    let (session, turns) = chain_session()?;
    let (capture, _) = session.accept("probe", "probe")?;
    in_snapshot(&session, &capture, |conn, stage, range, _| {
        let changes = conn.total_changes();
        let mut refused = 0usize;
        let mut probe = || {
            let write = conn.execute_batch("CREATE TEMP TABLE di1b_probe(a)");
            let rows =
                conn.execute_batch("INSERT INTO chat_sessions(id,project_id) VALUES ('x','y')");
            for result in [write, rows] {
                match result {
                    Err(rusqlite::Error::SqliteFailure(failure, _))
                        if failure.code == rusqlite::ErrorCode::AuthorizationForStatementDenied =>
                    {
                        refused += 1;
                    }
                    other => panic!("a write inside the run must be refused: {other:?}"),
                }
            }
            Ok(())
        };
        let outcome = reauthorize_turn_history_in_tx(
            conn,
            stage,
            range,
            GenerationPurpose::Writing,
            wall_clock_ms(),
            Instant::now(),
            &prepared_sql_budget(),
            &mut probe,
        )?;
        for turn in &turns {
            assert_turn_adopted(&outcome, turn);
        }
        assert!(refused >= 2, "the run polled its owner: {refused}");
        assert_eq!(conn.total_changes(), changes, "the run wrote");
        // After the run the guard is gone: the same connection writes again.
        conn.execute_batch("CREATE TEMP TABLE di1b_after(a); DROP TABLE di1b_after;")?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// The production values: the positive envelope and the edge of each dimension
// ---------------------------------------------------------------------------

/// The run through the D-final entry with the given budget, in a fresh
/// snapshot.
fn entry_outcome(
    session: &SessionFixture,
    capture: &AcceptedChatInputCapture,
    budget: GenerationHistoryReadBudget,
) -> Result<SessionHistoryOutcome> {
    in_snapshot(session, capture, |conn, stage, range, _| {
        reauthorize_turn_history_with_budget_in_tx(
            conn,
            stage,
            range,
            GenerationPurpose::Writing,
            wall_clock_ms(),
            &prepared_sql_budget(),
            budget,
            &mut || Ok(()),
        )
    })
}

/// The edge of each ledger dimension at the production values everywhere
/// else: a run that needs exactly N of it decides as with room to spare; one
/// that has N - 1 verifies less, never more, and never keeps a part of a
/// candidate it did not finish (K1b rules 1 to 4, K4/3 section 8).
#[test]
fn production_history_budget_n_and_n_plus_one_per_dimension() -> Result<()> {
    let (session, turns) = chain_session()?;
    let prepare = prepared_sql_budget();
    let mut probe = production_budget(&prepare);
    let baseline = session.run_with(&mut probe)?;
    assert_eq!(baseline.without_history, None);
    for turn in &turns {
        assert_turn_adopted(&baseline, turn);
    }
    let fresh = production_budget(&prepare);
    for dimension in Dimension::ALL {
        let consumed = dimension.get(&fresh) - dimension.get(&probe);
        assert!(consumed > 0, "{dimension:?} is charged by a run");
        assert!(
            consumed <= dimension.get(&fresh),
            "{dimension:?}: the production value admits the three-turn session"
        );
        // N.
        let mut exact = production_budget(&prepare);
        dimension.set(&mut exact, consumed);
        assert_eq!(
            session.run_with(&mut exact)?,
            baseline,
            "{dimension:?} at N"
        );
        assert_eq!(dimension.get(&exact), 0, "{dimension:?} is used up at N");
        // N - 1.
        let mut short = production_budget(&prepare);
        dimension.set(&mut short, consumed - 1);
        let outcome = session.run_with(&mut short)?;
        let cut_short = outcome.without_history == Some(NoHistory::SessionOverBudget)
            || outcome.candidates.iter().any(|result| {
                result.disposition
                    == CandidateDisposition::Excluded(Failure::Incomplete(
                        IncompleteReason::BudgetExhausted,
                    ))
            });
        assert!(cut_short, "{dimension:?} at N-1: {outcome:#?}");
        for result in outcome.qualified() {
            assert!(
                is_qualified(&baseline, result.kind, &result.attempt_id),
                "{dimension:?} at N-1 adopts only what the full run adopts"
            );
        }
    }
    // The listing of the session (its candidate attempts).
    let listed = turns.len() + 1;
    let mut exact = production_budget(&prepare);
    exact.max_candidates = turns.len();
    assert_eq!(session.run_with(&mut exact)?, baseline, "the listing at N");
    let mut short = production_budget(&prepare);
    short.max_candidates = turns.len() - 1;
    let outcome = session.run_with(&mut short)?;
    assert_eq!(
        outcome.without_history,
        Some(NoHistory::SessionOverBudget),
        "the listing at N-1 (of {listed})"
    );
    assert!(outcome.candidates.is_empty());
    // The project-authority rows: the run takes none of this allowance, and
    // the production value is zero, so a debit is refused until a reader
    // that debits is given a measured number.
    assert_eq!(probe.remaining_project_authority_rows, 0);
    assert!(production_budget(&prepare)
        .consume_project_authority_row()
        .is_err());
    Ok(())
}

/// The edge of the SQL VM-step ledger: a run with room finishes, one that is
/// spent part-way is the history's end (no candidate kept), at the production
/// value of every other dimension. The count of one run varies by a few steps
/// between runs, so the edge is found and then checked at 64 steps either
/// side of it.
#[test]
fn sql_vm_steps_n_and_n_plus_one() -> Result<()> {
    let (session, turns) = chain_session()?;
    let (capture, _) = session.accept("probe", "probe")?;
    let prepare = prepared_sql_budget();
    let mut probe = production_budget(&prepare);
    let baseline = session.run_with(&mut probe)?;
    let used = probe.sql.as_ref().expect("a ledger").sql_steps_used();
    assert!(used > 1_000 && used < HISTORY_MAX_SQL_VM_STEPS);
    let with_steps = |steps: u64| -> Result<SessionHistoryOutcome> {
        let mut budget = production_budget(&prepare);
        budget.sql = ledger(steps, Instant::now() + Duration::from_secs(60));
        entry_outcome(&session, &capture, budget)
    };
    let (mut low, mut high) = (1u64, used * 2);
    while low + 1 < high {
        let middle = (low + high) / 2;
        if with_steps(middle)?.without_history.is_none() {
            high = middle;
        } else {
            low = middle;
        }
    }
    let edge = high;
    assert!(edge > used / 2 && edge <= used + 64, "{edge} for {used}");
    let enough = with_steps(edge + 64)?;
    assert_eq!(enough.without_history, None);
    for turn in &turns {
        assert_turn_adopted(&enough, turn);
    }
    assert_eq!(enough, baseline);
    let spent = with_steps(edge - 64)?;
    assert_eq!(spent.without_history, Some(NoHistory::SqlCapacityExhausted));
    assert!(spent.candidates.is_empty(), "a stopped run keeps nothing");
    Ok(())
}

/// The long session of the envelope and the Revision-heavy turns that follow
/// one another, in one session (128 attempts, the first 8 of them with 102
/// Revisions each), every turn adopting the window the product makes (up to
/// 16 turns, 32 messages, cut by the create's parent read budget): every
/// candidate is verified and adopted inside the production budget, and each
/// value is as tight as the record says (the measured consumption plus the
/// margin of its row). One attempt more than the longest session goes on
/// without history.
#[test]
fn production_budget_keeps_positive_sessions() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let many = approve_small_revisions(session.db(), 102)?;
    let (turns, adopted) = windowed_session(
        &mut session,
        ENVELOPE_SESSION_ATTEMPTS,
        ENVELOPE_HEAVY_TURNS,
        Some(&many),
    )?;
    // The envelope is made of the widest windows the product makes: a heavy
    // turn adopts the heavy turns before it, at most four (their parents fill
    // the create's budget); the light turns after them adopt the full 16 as
    // soon as no heavy turn is in reach.
    for (index, count) in adopted.iter().enumerate() {
        assert!(
            *count <= HISTORY_MAX_TURNS && *count <= index,
            "turn {index}"
        );
        if index < ENVELOPE_HEAVY_TURNS {
            assert_eq!(*count, index.min(4), "turn {index}");
        } else if index >= ENVELOPE_HEAVY_TURNS + HISTORY_MAX_TURNS {
            assert_eq!(*count, HISTORY_MAX_TURNS, "turn {index}");
        } else {
            assert!(*count >= 4, "turn {index}");
        }
    }
    session.accept("last", "last")?;

    let prepare = prepared_sql_budget();
    let fresh = production_budget(&prepare);
    let mut budget = production_budget(&prepare);
    let outcome = session.run_with(&mut budget)?;
    assert_eq!(outcome.without_history, None);
    assert_eq!(outcome.candidates.len(), 2 * ENVELOPE_SESSION_ATTEMPTS);
    assert_eq!(
        outcome.qualified().count(),
        2 * ENVELOPE_SESSION_ATTEMPTS,
        "no candidate of the envelope is excluded"
    );
    assert!(outcome.a3_evaluations >= 102);

    // Each value covers the envelope and is no looser than its margin.
    let message_bodies = 2 * ENVELOPE_SESSION_ATTEMPTS * ENVELOPE_MESSAGE_BODY_BYTES;
    for (dimension, allowance, margin) in [
        (Dimension::Attempts, 0, 1.01),
        (Dimension::ReferenceCount, 0, 1.08),
        (Dimension::ReferenceBytes, 0, 1.12),
        (Dimension::BodyBytes, message_bodies, 1.12),
        (Dimension::Nodes, 0, 1.0),
        (Dimension::Edges, 0, 1.08),
        (Dimension::QualificationRefs, 0, 1.08),
    ] {
        let consumed = dimension.get(&fresh) - dimension.get(&budget) + allowance;
        let value = dimension.get(&fresh);
        assert!(consumed <= value, "{dimension:?}: {consumed} <= {value}");
        assert!(
            value as f64 <= consumed as f64 * margin,
            "{dimension:?}: {value} is more than {margin} times {consumed}"
        );
    }
    let steps = budget.sql.as_ref().expect("a ledger").sql_steps_used();
    assert!(steps <= HISTORY_MAX_SQL_VM_STEPS);
    assert!(
        HISTORY_MAX_SQL_VM_STEPS as f64 <= steps as f64 * 2.2,
        "the VM-step value keeps at most 2.2 times the envelope for a larger tree: {steps}"
    );
    assert_eq!(fresh.max_candidates, ENVELOPE_SESSION_ATTEMPTS);
    assert_eq!(fresh.max_attempts, 3 * ENVELOPE_SESSION_ATTEMPTS);

    // One attempt more than the longest session: the listing does not fit.
    windowed_turn(&mut session, &turns, ENVELOPE_SESSION_ATTEMPTS, None)?;
    session.accept("beyond", "beyond")?;
    let beyond = session.run_with(&mut production_budget(&prepare))?;
    assert_eq!(beyond.without_history, Some(NoHistory::SessionOverBudget));
    assert!(beyond.candidates.is_empty());
    Ok(())
}

// ---------------------------------------------------------------------------
// What the new attempt's create reads back: the window the product adopts
// ---------------------------------------------------------------------------

/// The reference rows an adopted message adds to the new attempt are the rows
/// the budget module counts (`HISTORY_REFERENCE_ROWS_PER_MESSAGE`), measured
/// on the attempts the product writer stores: a turn that adopts a Human and
/// an output stores exactly twice that many rows more than a turn that adopts
/// nothing.
#[test]
fn history_reference_rows_per_message_is_what_the_writer_stores() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let cost = |session: &SessionFixture, turn: &Turn| {
        session
            .db()
            .with_read_transaction(|conn| parent_read_cost_in_tx(conn, &turn.attempt_id))
    };
    let base = session.turn("base", &[], Some("base answer"))?;
    let one = session.turn(
        "one",
        &[Adopt::human(&base), Adopt::output(&base)],
        Some("one answer"),
    )?;
    let two = session.turn(
        "two",
        &[
            Adopt::human(&base),
            Adopt::output(&base),
            Adopt::human(&one),
            Adopt::output(&one),
        ],
        Some("two answer"),
    )?;
    let (base_cost, one_cost, two_cost) = (
        cost(&session, &base)?,
        cost(&session, &one)?,
        cost(&session, &two)?,
    );
    assert_eq!(
        one_cost.rows - base_cost.rows,
        2 * HISTORY_REFERENCE_ROWS_PER_MESSAGE
    );
    assert_eq!(
        two_cost.rows - one_cost.rows,
        2 * HISTORY_REFERENCE_ROWS_PER_MESSAGE
    );
    assert!(two_cost.bytes > one_cost.bytes && one_cost.bytes > base_cost.bytes);
    Ok(())
}

/// The window rule at its edges (rows, bytes, the turn cap, the first turn
/// that does not fit ends the window, a turn without an output costs nothing).
#[test]
fn history_window_follows_the_create_parent_read_budget() {
    let cost = |rows, bytes| ParentReadCost { rows, bytes };
    let quarter_rows = CREATE_PARENT_READ_ROWS / 4;
    let quarter_bytes = CREATE_PARENT_READ_BYTES / 4;
    assert_eq!(adoptable_turn_count(&[]), 0);
    // N: four parents that together are exactly the budget.
    let exact = cost(quarter_rows, quarter_bytes);
    assert_eq!(adoptable_turn_count(&[exact; 4]), 4);
    // N + 1 row, N + 1 byte: the fourth parent does not fit and ends the window.
    let one_row_more = cost(quarter_rows + 1, quarter_bytes);
    assert_eq!(
        adoptable_turn_count(&[exact, exact, exact, one_row_more]),
        3
    );
    let one_byte_more = cost(quarter_rows, quarter_bytes + 1);
    assert_eq!(
        adoptable_turn_count(&[exact, exact, exact, one_byte_more]),
        3
    );
    // The first turn that does not fit ends the window; a smaller older turn
    // is not taken in its place.
    let huge = cost(CREATE_PARENT_READ_ROWS + 1, 1);
    let small = cost(1, 1);
    assert_eq!(adoptable_turn_count(&[small, huge, small, small]), 1);
    assert_eq!(adoptable_turn_count(&[huge, small]), 0);
    // A turn without an output has no parent to read.
    let failed = ParentReadCost::default();
    assert_eq!(adoptable_turn_count(&[failed, exact, failed, exact]), 4);
    // The turn cap, however little each turn costs.
    assert_eq!(
        adoptable_turn_count(&[small; HISTORY_MAX_TURNS]),
        HISTORY_MAX_TURNS
    );
    assert_eq!(
        adoptable_turn_count(&[small; HISTORY_MAX_TURNS + 8]),
        HISTORY_MAX_TURNS
    );
    assert_eq!(
        adoptable_turn_count(&[cost(usize::MAX, 0), small]),
        0,
        "an overflowing cost never fits"
    );
}

/// Revision-heavy turns that follow one another (K4/3 acceptance): the window
/// the product makes is cut where the parents stop fitting the create's
/// budget, every create succeeds, and the run verifies and qualifies every
/// turn. The window that ignores the cut (the newest turns, whatever they
/// cost) is refused by the create with nothing committed: that is why the rule
/// is part of the budget (DI1B-1 review).
#[test]
fn revision_heavy_turns_get_a_window_the_create_accepts() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let many = approve_small_revisions(session.db(), 102)?;
    let (turns, adopted) = windowed_session(&mut session, 8, 8, Some(&many))?;
    // 1,650 stored references per heavy parent: four fit 8,192 rows, five do not.
    for (index, count) in adopted.iter().enumerate() {
        assert_eq!(*count, index.min(4), "turn {index}");
    }
    session.accept("next", "next")?;
    let outcome = session.run_with(&mut production_budget(&prepared_sql_budget()))?;
    assert_eq!(outcome.without_history, None);
    assert_eq!(outcome.qualified().count(), 2 * turns.len());

    // The window that ignores the create's budget: the newest five turns are
    // 5 x 1,650 parent rows, over the 8,192 of the create.
    let all: Vec<Adopt> = turns[turns.len() - 5..]
        .iter()
        .flat_map(|turn| [Adopt::human(turn), Adopt::output(turn)])
        .collect();
    let error = session
        .run_turn(
            TurnSpec::new("too wide")
                .reply("too wide")
                .adopt(&all)
                .revisions(&many)
                .create_budget(create_parent_read_budget()),
        )
        .err()
        .expect("the create refuses a window its parents cannot be read back for");
    assert!(
        format!("{error:#}").contains("NIR1_GENERATION_REF_LIMIT"),
        "{error:#}"
    );
    Ok(())
}

/// Turns with a middling number of Revisions (30 each) that follow one
/// another: the parents are too large for the full 16-turn window, so the
/// window is cut by the create's budget (here around ten turns) and every
/// create still succeeds. Without the cut, the 14th turn of such a session
/// is refused with `NIR1_GENERATION_REF_LIMIT` (DI1B-1 review).
#[test]
fn middling_revision_turns_are_cut_by_the_create_budget_not_refused() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let many = approve_small_revisions(session.db(), 30)?;
    let (turns, adopted) = windowed_session(&mut session, 16, 16, Some(&many))?;
    let last = *adopted.last().expect("turns");
    assert!(
        (8..HISTORY_MAX_TURNS - 1).contains(&last),
        "cut by the budget: {adopted:?}"
    );
    // The same turns, adopted whole: the 15 newest turns are 15 parents of
    // about 500 rows each.
    let all: Vec<Adopt> = turns[turns.len() - 15..]
        .iter()
        .flat_map(|turn| [Adopt::human(turn), Adopt::output(turn)])
        .collect();
    let error = session
        .run_turn(
            TurnSpec::new("too wide")
                .reply("too wide")
                .adopt(&all)
                .revisions(&many)
                .create_budget(create_parent_read_budget()),
        )
        .err()
        .expect("the create refuses the whole window");
    assert!(
        format!("{error:#}").contains("NIR1_GENERATION_REF_LIMIT"),
        "{error:#}"
    );
    Ok(())
}
