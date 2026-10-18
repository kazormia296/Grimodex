//! The production budget of one turn's history (DI1B-1; K1b rule 5, K4/3
//! sections 8 and 11) and the entry the D-final snapshot calls.
//!
//! The history run (`reauthorize_session_history_*`, HC-1) takes the turn's
//! budget from its caller; storage has no default. This module is that
//! caller's side. Every number is a named constant with its unit, and the
//! values, the place each one is checked, what happens when it is exceeded
//! and the measurement they come from are recorded in
//! `docs/plans/nir1-lane-decisions/di1b-decisions.md` (DR-DI1B-2) and in the
//! pull request.
//!
//! How the values were chosen. K1b asks for the tightest value that keeps the
//! positive sessions accepted (rules 6 and 7: tightening is free, loosening
//! after the merge needs a new confirmation). The positive envelope is the
//! one K4/3 section 11 names: a long normal conversation
//! ([`ENVELOPE_SESSION_ATTEMPTS`] chained turns), Revision-heavy turns that
//! follow one another ([`ENVELOPE_HEAVY_TURNS`] turns of 102 Revisions, the
//! largest request the packing admits, 1,650 stored references each) and both
//! together. Every turn of the envelope adopts the window the product makes:
//! the newest [`HISTORY_MAX_TURNS`] turns that all fit the create's parent
//! read budget (the packing rule below). A run that adopts only the previous
//! turn is a quarter of the work and is not the envelope. The consumption of
//! each dimension in that envelope was measured with the `di1b_measurement`
//! harness on the tree after X1-3 and DI-1c, and the value is that
//! measurement plus a margin that is stated per dimension. C-query's 512 and
//! 100 ms are not reused (K4/3 section 11).
//!
//! A session beyond the envelope is not wrong, only over budget: the run
//! excludes the candidates it could not verify, or, when it cannot even list
//! the session, the turn goes on without history (K4/3 section 8). Nothing
//! here widens what may be sent.

use std::time::{Duration, Instant};

use anyhow::Result;
use rusqlite::Connection;

use super::nir1_history_context::{HistoryContextStage, TurnHistoryRange};
use crate::narrative_maintenance_connection::ParticipantSqlOperationBudget;
use crate::nir1_generation::{
    attempt_reference_read_cost_in_tx, GenerationHistoryReadBudget,
    GenerationHistorySnapshotCancellation, GenerationHistorySnapshotSqlBudget,
    GenerationHistorySqlLedger, GenerationPurpose, ReadBudget,
};
use crate::nir1_generation_history::{
    reauthorize_session_history_for_turn_in_tx, SessionHistoryOutcome, SessionHistoryRequest,
};

// ---- the positive envelope (what the values must keep accepting) ----

/// The longest session the budget accepts: the attempts the run lists for one
/// chat session. A session over it goes on without history.
pub(crate) const ENVELOPE_SESSION_ATTEMPTS: usize = 128;
/// Revision-heavy turns that follow one another in a session (102 Revisions
/// each, 1,650 stored references each).
#[cfg(test)]
pub(crate) const ENVELOPE_HEAVY_TURNS: usize = 8;
/// The body a past message of the envelope may have on average. The harness
/// fixtures carry a few bytes per message, so the body-bytes value adds
/// `2 * ENVELOPE_SESSION_ATTEMPTS * ENVELOPE_MESSAGE_BODY_BYTES` (every attempt
/// has a Human and an output) to what was measured.
#[cfg(test)]
pub(crate) const ENVELOPE_MESSAGE_BODY_BYTES: usize = 8 * 1024;

// ---- the ledger of the run (the D-final snapshot's reads of history) ----

/// Attempt reads: one for the listing and one for the read of each listed
/// attempt (DR-HC1-2a), plus the receipt of the parent of each adopted
/// output (DR-HC1-20). Unit: attempt rows. Checked at: each read of an
/// attempt row, before the row is materialized. Exceeded: the attempts not
/// yet read, and the candidates that depend on them, are excluded (the
/// session that cannot be listed goes on without history).
pub(crate) const HISTORY_MAX_ATTEMPTS: usize = 3 * ENVELOPE_SESSION_ATTEMPTS;
/// Attempts of the session the listing may contain. Unit: attempt rows.
/// Checked at: the listing, as N and N + 1 before any attempt is read.
/// Exceeded: the turn goes on without history.
pub(crate) const HISTORY_MAX_CANDIDATE_ATTEMPTS: usize = ENVELOPE_SESSION_ATTEMPTS;
/// Reference rows (inputs and qualifications) read. Unit: rows. Checked at:
/// each attempt's reference read, before the rows are decoded.
pub(crate) const HISTORY_MAX_REFERENCE_ROWS: usize = 57_500;
/// Reference bytes read. Unit: bytes of the stored JSON of the rows. Checked
/// at: each reference read, from the stored length, before the row is read.
pub(crate) const HISTORY_MAX_REFERENCE_BYTES: usize = 10 << 20;
/// Message and reference bodies read. Unit: bytes. Checked at: each body,
/// from its stored length, before it is read.
pub(crate) const HISTORY_MAX_BODY_BYTES: usize = 27 << 19;
/// Nodes (attempts) of the traversal. Unit: attempts verified. Checked at:
/// each attempt the traversal enters.
pub(crate) const HISTORY_MAX_NODES: usize = ENVELOPE_SESSION_ATTEMPTS;
/// Edges (inputs and adoptions) of the traversal. Unit: edges. Checked at:
/// each edge the traversal follows.
pub(crate) const HISTORY_MAX_EDGES: usize = 5_800;
/// Qualification references the traversal looks at, typed N/A included.
/// Unit: references. Checked at: each reference, before it is requalified.
pub(crate) const HISTORY_MAX_QUALIFICATION_REFS: usize = 52_000;
/// Project-authority rows the run may read through the budget (HP-1). The run
/// reads the tree, the Scene bindings and the registry inside A3's own SQL
/// ledger and takes nothing from this allowance; it is zero so that a reader
/// added later has to be given a measured number (the debit refuses at zero).
/// Unit: rows. Checked at: each row, by `consume_project_authority_row`.
pub(crate) const HISTORY_MAX_PROJECT_AUTHORITY_ROWS: usize = 0;
/// SQLite VM steps of the whole run (the progress handler counts one per
/// opcode). Unit: VM steps. Checked at: every opcode, by the progress handler
/// of the nested capacity scope. Exceeded: the statement is interrupted and
/// the turn goes on without history.
pub(crate) const HISTORY_MAX_SQL_VM_STEPS: u64 = 8_000_000;
/// The longest the run may take. Unit: milliseconds. Checked at: every 1,000
/// opcodes and at each phase of the run. Clipped to the prepare deadline
/// minus [`HISTORY_TAIL_RESERVE_MS`]. Exceeded: the turn goes on without
/// history.
pub(crate) const HISTORY_DEADLINE_MS: u64 = 10_000;
/// What the rest of the D-final read keeps for itself after the history: the
/// history deadline ends this long before the prepare deadline. Unit:
/// milliseconds.
pub(crate) const HISTORY_TAIL_RESERVE_MS: u64 = 3_000;
/// SQLite busy-wait allowance of the run, at most the prepare operation's own
/// (100 ms for D-final). Unit: milliseconds. Checked at: SQLite's busy
/// handler, when the history opens its own transaction. Exceeded: the turn
/// goes on without history.
pub(crate) const HISTORY_BUSY_WAIT_MS: u64 = 100;

// ---- the request side (what DI1B-3 packs into the final request) ----

/// Past turns the final request carries. Unit: turns (an attempt's Human and
/// its output). Checked at: packing, from the newest turn back. The packing
/// stops earlier when the next turn does not fit one of the other limits
/// (tokens, the create's parent read budget below): a window is the newest
/// turns that all fit, never a selection with gaps.
pub(crate) const HISTORY_MAX_TURNS: usize = 16;
/// Past messages the final request carries. Unit: messages.
pub(crate) const HISTORY_MAX_MESSAGES: usize = 32;
/// One past message the final request may carry. Unit: bytes of the body.
/// A longer message is not shortened; its turn is not adopted.
pub(crate) const HISTORY_MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// The most the history may take of the request's token budget, after the
/// required Raw and the accepted IR (which it never displaces). Unit: tokens.
pub(crate) const HISTORY_MAX_TOKENS: usize = 8_192;
/// References the adopted history adds to the new attempt for each message: one
/// input row and the qualification rows of a past Human or output (K4/3
/// section 3). Unit: rows per message. The test
/// `history_reference_rows_per_message_is_what_the_writer_stores` measures it.
pub(crate) const HISTORY_REFERENCE_ROWS_PER_MESSAGE: usize = 9;

// ---- what the new attempt's create reads back (DI1B-1 review) ----
//
// The create (`validate_refs`) reads the stored attempt of the parent of every
// adopted output, to check that the parent succeeded with that output, and it
// debits every reference row it reads from one parent read budget: the
// create's own `ReadBudget` (8,192 rows and 8 MiB for Native,
// `NIR1_LOCAL_ATTEMPT_READ_BUDGET`). The parents are not read again by the
// run; their size is the size of the attempts the earlier turns stored,
// which grows with every Revision and every message they adopted. A window of
// turns whose parents together exceed that budget makes the create fail
// (`NIR1_GENERATION_REF_LIMIT`, nothing committed), and the next turn of the
// same session would choose the same window and fail the same way.
//
// So the number of turns a request adopts is bounded by this budget as well,
// and the rule is the packing's (DI1B-3): take the newest turns, in order, and
// stop at the first one whose parent does not fit. Older turns are dropped
// (never a turn skipped for an older one, never part of a turn). A turn
// without an output (a failed one) has no parent to read and costs nothing.

/// The create's parent read budget, rows. Equal to Native's
/// `NIR1_LOCAL_ATTEMPT_READ_BUDGET.max_references` (16 per input slot of
/// `MAX_PACKING_ITEMS`). That constant is in the Native crate, which this crate
/// does not depend on: the Native side of the connection (DI1B-4) asserts the
/// equality.
pub(crate) const CREATE_PARENT_READ_ROWS: usize =
    grimodex_core::narrative_nir1::MAX_PACKING_ITEMS * 16;
/// The create's parent read budget, bytes of stored reference JSON (1 KiB per
/// row slot).
pub(crate) const CREATE_PARENT_READ_BYTES: usize =
    grimodex_core::narrative_nir1::MAX_PACKING_ITEMS * 16 * 1024;

/// The create's parent read budget as a storage `ReadBudget`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "DI1B-4 asserts the Native create budget equals it"
    )
)]
pub(crate) const fn create_parent_read_budget() -> ReadBudget {
    ReadBudget {
        max_references: CREATE_PARENT_READ_ROWS,
        max_reference_bytes: CREATE_PARENT_READ_BYTES,
    }
}

/// What reading one stored attempt costs the create of an attempt that adopts
/// its output: the stored reference rows and their JSON bytes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ParentReadCost {
    pub(crate) rows: usize,
    pub(crate) bytes: usize,
}

/// The cost of reading `attempt_id` as the parent of an adopted output, from
/// the stored rows (counts only; nothing is decoded). Read in the snapshot
/// the packing runs in.
pub(crate) fn parent_read_cost_in_tx(
    conn: &Connection,
    attempt_id: &str,
) -> Result<ParentReadCost> {
    let (rows, bytes) = attempt_reference_read_cost_in_tx(conn, attempt_id)?;
    Ok(ParentReadCost { rows, bytes })
}

/// How many of the newest turns the request may adopt: at most
/// [`HISTORY_MAX_TURNS`], and the longest prefix of `newest_first` (the cost of
/// each turn's parent, newest turn first, [`ParentReadCost::default`] for a turn
/// without an output) whose total stays inside the create's parent read budget.
/// The first turn that does not fit ends the window.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the adoption sizes its window with the same rule; tests pin the two together"
    )
)]
pub(crate) fn adoptable_turn_count(newest_first: &[ParentReadCost]) -> usize {
    let (mut rows, mut bytes) = (0usize, 0usize);
    let mut count = 0usize;
    for cost in newest_first.iter().take(HISTORY_MAX_TURNS) {
        match (rows.checked_add(cost.rows), bytes.checked_add(cost.bytes)) {
            (Some(next_rows), Some(next_bytes))
                if next_rows <= CREATE_PARENT_READ_ROWS
                    && next_bytes <= CREATE_PARENT_READ_BYTES =>
            {
                rows = next_rows;
                bytes = next_bytes;
                count += 1;
            }
            _ => break,
        }
    }
    count
}

// How the values relate to each other and to the numbers around them. One
// cannot be moved alone: the build says which relation it breaks.
const _: () = {
    // DR-HC1-20: the attempt reads are 3n for a chain of n attempts.
    assert!(HISTORY_MAX_ATTEMPTS == 3 * HISTORY_MAX_CANDIDATE_ATTEMPTS);
    assert!(HISTORY_MAX_NODES >= HISTORY_MAX_CANDIDATE_ATTEMPTS);
    assert!(HISTORY_MAX_MESSAGES == 2 * HISTORY_MAX_TURNS);
    // D-final's prepare operation is 20 s with a 100 ms busy wait; the
    // history and the tail the rest of the read keeps fit inside it.
    assert!(HISTORY_DEADLINE_MS + HISTORY_TAIL_RESERVE_MS < 20_000);
    assert!(HISTORY_BUSY_WAIT_MS <= 100);
    // C-query's 512 and 100 ms are not reused (K4/3 section 11).
    assert!(HISTORY_MAX_ATTEMPTS != 512 && HISTORY_DEADLINE_MS != 100);
    // The new attempt's own references (the create's cap on one attempt is the
    // same budget): the largest request the packing admits (1,650 stored
    // references) and a full history on top of it.
    assert!(
        1_650 + HISTORY_MAX_MESSAGES * HISTORY_REFERENCE_ROWS_PER_MESSAGE
            <= CREATE_PARENT_READ_ROWS
    );
    // The window can hold at least four of the largest parents (a 102-Revision
    // turn that adopted a full window itself is 1,650 + 32 * 9 rows): Revision-
    // heavy turns that follow one another keep a useful window.
    assert!(
        4 * (1_650 + HISTORY_MAX_MESSAGES * HISTORY_REFERENCE_ROWS_PER_MESSAGE)
            <= CREATE_PARENT_READ_ROWS
    );
    // A message that fits is a message that the body ledger can read.
    assert!(HISTORY_MAX_MESSAGE_BYTES * 2 <= HISTORY_MAX_BODY_BYTES);
};

/// The wall of one prepare: when the history run starts and what the prepare
/// operation allows. The history's own deadline and busy wait are clipped to
/// it, so the run never outlasts the operation that contains it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct HistoryBudgetWindow {
    pub(crate) now: Instant,
    pub(crate) prepare_deadline: Instant,
    pub(crate) prepare_busy_wait: Duration,
}

impl HistoryBudgetWindow {
    pub(crate) fn new(now: Instant, prepare: &ParticipantSqlOperationBudget) -> Self {
        Self {
            now,
            prepare_deadline: prepare.deadline(),
            prepare_busy_wait: prepare.busy_timeout(),
        }
    }

    /// The history's deadline: its own allowance from `now`, and never later
    /// than the prepare deadline less the tail the rest of the read keeps. At
    /// or past that point it is `now` itself: the run is refused before any
    /// SQL, and the turn goes on without history.
    pub(crate) fn history_deadline(&self) -> Instant {
        let own = self.now + Duration::from_millis(HISTORY_DEADLINE_MS);
        let before_tail = self
            .prepare_deadline
            .checked_sub(Duration::from_millis(HISTORY_TAIL_RESERVE_MS))
            .unwrap_or(self.now);
        own.min(before_tail).max(self.now)
    }

    /// The busy-wait allowance: the history's own, and never more than the
    /// prepare operation's.
    pub(crate) fn history_busy_wait(&self) -> Duration {
        Duration::from_millis(HISTORY_BUSY_WAIT_MS).min(self.prepare_busy_wait)
    }
}

/// The budget of one turn's history run (K1b rule 5). A new one per turn: the
/// run shares it across its whole traversal and never resets it.
pub(crate) fn production_history_read_budget(
    window: HistoryBudgetWindow,
) -> GenerationHistoryReadBudget {
    GenerationHistoryReadBudget {
        max_attempts: HISTORY_MAX_ATTEMPTS,
        sql: Some(GenerationHistorySqlLedger::new(
            GenerationHistorySnapshotSqlBudget {
                max_vm_steps: HISTORY_MAX_SQL_VM_STEPS,
                deadline: window.history_deadline(),
                busy_wait: window.history_busy_wait(),
            },
        )),
        max_candidates: HISTORY_MAX_CANDIDATE_ATTEMPTS,
        max_reference_count: HISTORY_MAX_REFERENCE_ROWS,
        max_reference_bytes: HISTORY_MAX_REFERENCE_BYTES,
        max_resolved_body_bytes: HISTORY_MAX_BODY_BYTES,
        remaining_project_authority_rows: HISTORY_MAX_PROJECT_AUTHORITY_ROWS,
        remaining_nodes: HISTORY_MAX_NODES,
        remaining_edges: HISTORY_MAX_EDGES,
        remaining_qualification_refs: HISTORY_MAX_QUALIFICATION_REFS,
    }
}

/// Re-authorize the history of one turn inside the D-final snapshot's own
/// read transaction (`conn`): the production entry of the run.
///
/// * The range is the turn's own: the capture's project and chat session and
///   the Scene incarnation read in this snapshot ([`TurnHistoryRange`]).
/// * `now_ms` is the Native clock's value for the turn; this crate reads no
///   clock. `started` is the monotonic instant the history's allowances run
///   from.
/// * The budget is the production one, clipped to `prepare` (the D-final
///   operation that contains the call). A spent SQL ledger, an elapsed
///   history deadline or a busy wait beyond the allowance ends the history,
///   not the turn: the outcome is `without_history`, the transaction stays
///   open and the D-final reads go on in the same snapshot.
/// * `owner_check` is D-final's own checkpoint (the participant, the stop
///   flag and the operation deadline). Its error is the turn's error and is
///   returned as it is, never as "no history": a cancel stops the turn.
#[allow(clippy::too_many_arguments)] // One explicit value per input of the D-final snapshot.
pub(crate) fn reauthorize_turn_history_in_tx(
    conn: &Connection,
    stage: &HistoryContextStage,
    range: &TurnHistoryRange,
    purpose: GenerationPurpose,
    now_ms: i64,
    started: Instant,
    prepare: &ParticipantSqlOperationBudget,
    owner_check: &mut dyn FnMut() -> Result<()>,
) -> Result<SessionHistoryOutcome> {
    reauthorize_turn_history_with_budget_in_tx(
        conn,
        stage,
        range,
        purpose,
        now_ms,
        prepare,
        production_history_read_budget(HistoryBudgetWindow::new(started, prepare)),
        owner_check,
    )
}

/// [`reauthorize_turn_history_in_tx`] with the turn's budget given. The
/// production entry passes [`production_history_read_budget`]; a test passes
/// a shorter one to reach a dimension's edge.
#[allow(clippy::too_many_arguments)] // One explicit value per input of the D-final snapshot.
pub(crate) fn reauthorize_turn_history_with_budget_in_tx(
    conn: &Connection,
    stage: &HistoryContextStage,
    range: &TurnHistoryRange,
    purpose: GenerationPurpose,
    now_ms: i64,
    prepare: &ParticipantSqlOperationBudget,
    mut budget: GenerationHistoryReadBudget,
    owner_check: &mut dyn FnMut() -> Result<()>,
) -> Result<SessionHistoryOutcome> {
    let current = stage.current_history_context_for_turn(range, purpose);
    let cancellation = GenerationHistorySnapshotCancellation::from_operation_budget(prepare);
    let mut owner_error = None;
    let mut cancelled = || {
        if owner_error.is_some() {
            return true;
        }
        match owner_check() {
            Ok(()) => false,
            Err(error) => {
                owner_error = Some(error);
                true
            }
        }
    };
    let outcome = reauthorize_session_history_for_turn_in_tx(
        conn,
        &cancellation,
        &mut budget,
        &SessionHistoryRequest {
            current: &current,
            now_ms,
        },
        &mut cancelled,
    );
    // The owner's own stop wins, with its own typed reason.
    match owner_error {
        Some(error) => Err(error),
        None => outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn prepare(deadline_in: Duration, busy: Duration) -> ParticipantSqlOperationBudget {
        ParticipantSqlOperationBudget::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + deadline_in,
            busy,
        )
    }

    /// The recorded values (DR-DI1B-2). Changing one is a change to a
    /// confirmed budget: tightening is the integrator's technical decision,
    /// loosening needs a new confirmation (K1b rules 6 and 7), and either one
    /// also changes the record and the pull request's table.
    #[test]
    fn production_history_budget_values_are_the_recorded_ones() {
        assert_eq!(ENVELOPE_SESSION_ATTEMPTS, 128);
        assert_eq!(ENVELOPE_HEAVY_TURNS, 8);
        assert_eq!(HISTORY_MAX_ATTEMPTS, 384);
        assert_eq!(HISTORY_MAX_CANDIDATE_ATTEMPTS, 128);
        assert_eq!(HISTORY_MAX_REFERENCE_ROWS, 57_500);
        assert_eq!(HISTORY_MAX_REFERENCE_BYTES, 10_485_760);
        assert_eq!(HISTORY_MAX_BODY_BYTES, 14_155_776);
        assert_eq!(HISTORY_MAX_NODES, 128);
        assert_eq!(HISTORY_MAX_EDGES, 5_800);
        assert_eq!(HISTORY_MAX_QUALIFICATION_REFS, 52_000);
        assert_eq!(HISTORY_MAX_PROJECT_AUTHORITY_ROWS, 0);
        assert_eq!(HISTORY_MAX_SQL_VM_STEPS, 8_000_000);
        assert_eq!(HISTORY_DEADLINE_MS, 10_000);
        assert_eq!(HISTORY_TAIL_RESERVE_MS, 3_000);
        assert_eq!(HISTORY_BUSY_WAIT_MS, 100);
        assert_eq!(HISTORY_MAX_TURNS, 16);
        assert_eq!(HISTORY_MAX_MESSAGES, 32);
        assert_eq!(HISTORY_MAX_MESSAGE_BYTES, 65_536);
        assert_eq!(HISTORY_MAX_TOKENS, 8_192);
        assert_eq!(HISTORY_REFERENCE_ROWS_PER_MESSAGE, 9);

        let budget = production_history_read_budget(HistoryBudgetWindow::new(
            Instant::now(),
            &prepare(Duration::from_secs(20), Duration::from_millis(100)),
        ));
        assert_eq!(budget.max_attempts, HISTORY_MAX_ATTEMPTS);
        assert_eq!(budget.max_candidates, HISTORY_MAX_CANDIDATE_ATTEMPTS);
        assert_eq!(budget.max_reference_count, HISTORY_MAX_REFERENCE_ROWS);
        assert_eq!(budget.max_reference_bytes, HISTORY_MAX_REFERENCE_BYTES);
        assert_eq!(budget.max_resolved_body_bytes, HISTORY_MAX_BODY_BYTES);
        assert_eq!(budget.remaining_nodes, HISTORY_MAX_NODES);
        assert_eq!(budget.remaining_edges, HISTORY_MAX_EDGES);
        assert_eq!(
            budget.remaining_qualification_refs,
            HISTORY_MAX_QUALIFICATION_REFS
        );
        assert_eq!(
            budget.remaining_project_authority_rows,
            HISTORY_MAX_PROJECT_AUTHORITY_ROWS
        );
        assert!(budget.sql.is_some());
    }

    #[test]
    fn history_budget_never_exceeds_the_prepare_deadline() {
        let now = Instant::now();
        let window = |deadline_in: Duration, busy: Duration| {
            let window = HistoryBudgetWindow {
                now,
                prepare_deadline: now + deadline_in,
                prepare_busy_wait: busy,
            };
            (window.history_deadline(), window.history_busy_wait())
        };
        // A prepare with time to spare: the history's own allowance.
        let (deadline, busy) = window(Duration::from_secs(20), Duration::from_millis(100));
        assert_eq!(deadline, now + Duration::from_millis(HISTORY_DEADLINE_MS));
        assert_eq!(busy, Duration::from_millis(100));
        // Less time left: the history ends before the prepare does, by the
        // tail the rest of the read keeps.
        let (deadline, _) = window(Duration::from_secs(12), Duration::from_millis(100));
        assert_eq!(deadline, now + Duration::from_secs(9));
        let (deadline, _) = window(Duration::from_secs(13), Duration::from_millis(100));
        assert_eq!(deadline, now + Duration::from_secs(10));
        // N and N + 1 of the tail: with exactly the tail left the history
        // ends now; with less it cannot start (never a deadline in the past
        // of the call, never one after the prepare deadline).
        for left in [3_000u64, 2_999, 1_000, 1, 0] {
            let (deadline, _) = window(Duration::from_millis(left), Duration::from_millis(100));
            assert_eq!(deadline, now, "{left} ms left");
        }
        let (deadline, _) = window(Duration::from_millis(3_001), Duration::from_millis(100));
        assert_eq!(deadline, now + Duration::from_millis(1));
        for left in [0u64, 1, 2_999, 3_000, 3_001, 5_000, 13_000, 20_000, 600_000] {
            let (deadline, _) = window(Duration::from_millis(left), Duration::from_millis(100));
            assert!(deadline >= now);
            assert!(
                deadline <= now + Duration::from_millis(left.max(1)),
                "{left}"
            );
            assert!(deadline <= now + Duration::from_millis(HISTORY_DEADLINE_MS));
        }
        // The busy wait is the history's own and never more than the prepare
        // operation's.
        let (_, busy) = window(Duration::from_secs(20), Duration::from_millis(30));
        assert_eq!(busy, Duration::from_millis(30));
        let (_, busy) = window(Duration::from_secs(20), Duration::ZERO);
        assert_eq!(busy, Duration::ZERO);
        let (_, busy) = window(Duration::from_secs(20), Duration::from_secs(5));
        assert_eq!(busy, Duration::from_millis(HISTORY_BUSY_WAIT_MS));
        // From a real operation budget.
        let operation = prepare(Duration::from_secs(20), Duration::from_millis(100));
        let window = HistoryBudgetWindow::new(now, &operation);
        assert!(window.history_deadline() <= operation.deadline());
        assert_eq!(window.history_busy_wait(), operation.busy_timeout());
    }

    /// A new budget for each turn: the run's use of one never replenishes or
    /// reduces another.
    #[test]
    fn production_history_budget_is_new_for_each_turn() {
        let operation = prepare(Duration::from_secs(20), Duration::from_millis(100));
        let window = HistoryBudgetWindow::new(Instant::now(), &operation);
        let mut first = production_history_read_budget(window);
        first.max_attempts = 0;
        first.remaining_nodes = 0;
        let second = production_history_read_budget(window);
        assert_eq!(second.max_attempts, HISTORY_MAX_ATTEMPTS);
        assert_eq!(second.remaining_nodes, HISTORY_MAX_NODES);
        assert_eq!(
            second.sql.as_ref().expect("a ledger").sql_steps_used(),
            0,
            "a ledger starts with no step used"
        );
    }
}
