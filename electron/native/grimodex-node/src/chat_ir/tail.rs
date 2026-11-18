//! The write of the terminal audit records that did not become durable inside
//! the deadline, after the response was sent (DR-CHATIR-S1-15; the user's
//! answer of 2026-11-17 approves this form).
//!
//! It runs in the same blocking task that answered, so the permit and the
//! workspace participant are still held: no new registry, queue, ticket or
//! handle exists. The participant is waited for by shutdown and by a
//! transition without a limit, so this loop looks at the participant's stop
//! request between short slices and ends: when it is requested it makes one
//! last attempt of `close_flush`, cut at the tail's deadline, and gives up. A record that is not written is
//! dropped by `PendingTerminalAudit`'s `Drop`, which logs the execution IDs
//! only.

use std::time::{Duration, Instant};

use anyhow::Result;
use grimodex_semantic::runtime::PendingTerminalAudit;

/// What the loop needs of the pending records. The shared crate's type cannot
/// be built without a model, so the tests use their own.
pub(crate) trait TailFlush {
    fn is_empty(&self) -> bool;
    fn flush_until(&mut self, deadline: Instant) -> Result<bool>;
}

impl TailFlush for PendingTerminalAudit {
    fn is_empty(&self) -> bool {
        PendingTerminalAudit::is_empty(self)
    }

    fn flush_until(&mut self, deadline: Instant) -> Result<bool> {
        PendingTerminalAudit::flush_until(self, deadline)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TailTiming {
    /// The whole tail, counted from the response.
    pub(crate) budget: Duration,
    /// How long one `flush_until` may run before the stop request is read.
    pub(crate) slice: Duration,
    /// The last attempt once the stop request is seen.
    pub(crate) close_flush: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TailEnd {
    /// The records are durable.
    Flushed,
    /// The stop request was seen; the last attempt did (`true`) or did not
    /// (`false`) write them.
    Stopped { flushed: bool },
    /// The budget ran out.
    Expired,
    /// The append kept failing for another reason than a busy connection.
    Failed,
}

/// How many non-busy errors in a row end the tail.
const MAX_FLUSH_ERRORS: u32 = 5;

pub(crate) fn run_tail<P: TailFlush>(
    pending: &mut P,
    timing: &TailTiming,
    stop_requested: impl Fn() -> bool,
) -> TailEnd {
    let tail_deadline = Instant::now() + timing.budget;
    let mut errors = 0;
    loop {
        if pending.is_empty() {
            return TailEnd::Flushed;
        }
        if stop_requested() {
            // DR-CHATIR-S1-28: the last attempt is cut at the tail's deadline too, so a
            // stop seen just before the budget runs out does not carry the tail past it
            // (the approved bound is 30 s after the response). Once the deadline has
            // passed no attempt starts.
            let now = Instant::now();
            let close_deadline = tail_deadline.min(now + timing.close_flush);
            let flushed =
                now < close_deadline && matches!(pending.flush_until(close_deadline), Ok(true));
            return TailEnd::Stopped { flushed };
        }
        let now = Instant::now();
        if now >= tail_deadline {
            return TailEnd::Expired;
        }
        let slice_end = tail_deadline.min(now + timing.slice);
        match pending.flush_until(slice_end) {
            Ok(true) => return TailEnd::Flushed,
            Ok(false) => {}
            Err(_) => {
                errors += 1;
                if errors >= MAX_FLUSH_ERRORS {
                    return TailEnd::Failed;
                }
                std::thread::sleep(slice_end.saturating_duration_since(Instant::now()));
            }
        }
    }
}
