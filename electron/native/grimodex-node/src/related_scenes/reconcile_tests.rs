//! DR-MPS-15: the timer-driven `reconcile` round gives way to a busy database
//! connection. The per-ticket check and the stale handling are injected, so
//! these cases drive the round without a Chronicle index proof; the real
//! `current_operation_mode` is the one place that turns "busy" into `None`.
use super::*;
use std::cell::RefCell;

/// A fake check: `busy` answers `None` whenever the round may only try.
struct Script {
    busy: bool,
    verdict: fn(&&'static str) -> Result<Option<bool>>,
    asked: RefCell<Vec<(&'static str, bool)>>,
    staled: RefCell<Vec<&'static str>>,
}

impl Script {
    fn new(busy: bool) -> Self {
        Self {
            busy,
            verdict: |_| Ok(Some(true)),
            asked: RefCell::default(),
            staled: RefCell::default(),
        }
    }

    fn round(
        &self,
        counter: &AtomicU32,
        periodic: bool,
        tickets: &[&'static str],
    ) -> Result<usize> {
        reconcile_round(
            counter,
            periodic,
            tickets.iter().map(|t| (t.to_string(), *t)).collect(),
            |lease, try_only| {
                self.asked.borrow_mut().push((*lease, try_only));
                if try_only && self.busy {
                    return Ok(None);
                }
                (self.verdict)(lease)
            },
            |ticket, lease| {
                assert_eq!(ticket, *lease);
                self.staled.borrow_mut().push(*lease);
                Ok(())
            },
        )
    }
}

#[test]
fn a_periodic_round_over_a_busy_connection_keeps_every_ticket_active() {
    let script = Script::new(true);
    let counter = AtomicU32::new(0);
    let active = script.round(&counter, true, &["a", "b"]).expect("round");
    assert_eq!(active, 2, "an unchecked ticket is counted as active");
    assert_eq!(
        *script.asked.borrow(),
        [("a", true), ("b", true)],
        "the periodic round only tries"
    );
    assert!(
        script.staled.borrow().is_empty(),
        "nothing is invalidated, rescheduled or announced for a skipped check"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[test]
fn a_periodic_round_over_a_free_connection_invalidates_and_schedules_as_before() {
    let mut script = Script::new(false);
    script.verdict = |lease| match *lease {
        "stale" => Ok(Some(false)),
        "broken" => Err(anyhow!("check failed")),
        _ => Ok(Some(true)),
    };
    let counter = AtomicU32::new(5);
    let active = script
        .round(&counter, true, &["fresh", "stale", "broken"])
        .expect("round");
    assert_eq!(active, 1);
    assert_eq!(
        *script.staled.borrow(),
        ["stale", "broken"],
        "a stale check and a failed check are handled as stale"
    );
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "nothing skipped: start over"
    );
}

#[test]
fn a_busy_ticket_does_not_hide_a_stale_one_in_the_same_round() {
    let staled = RefCell::new(Vec::<String>::new());
    let counter = AtomicU32::new(0);
    let active = reconcile_round(
        &counter,
        true,
        // The payload says whether the ticket's connection read is busy.
        vec![("busy".to_string(), true), ("stale".to_string(), false)],
        |busy, try_only| Ok(if try_only && *busy { None } else { Some(false) }),
        |ticket, _| {
            staled.borrow_mut().push(ticket.to_string());
            Ok(())
        },
    )
    .expect("round");
    assert_eq!(active, 1);
    assert_eq!(*staled.borrow(), ["stale"]);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[test]
fn a_round_after_a_commit_waits_even_over_a_busy_connection() {
    let script = Script::new(true);
    // A `Some(true)` answer is what a waiting check eventually gives.
    let counter = AtomicU32::new(7);
    let active = script.round(&counter, false, &["a"]).expect("round");
    assert_eq!(active, 1);
    assert_eq!(*script.asked.borrow(), [("a", false)]);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "a waiting round starts over"
    );
}

#[test]
fn forty_skipped_rounds_in_a_row_make_the_next_one_wait() {
    assert_eq!(MAX_CONSECUTIVE_SKIPPED_ROUNDS, 40);
    let script = Script::new(true);
    let counter = AtomicU32::new(0);
    for round in 1..=MAX_CONSECUTIVE_SKIPPED_ROUNDS {
        script.round(&counter, true, &["a"]).expect("round");
        assert_eq!(counter.load(Ordering::SeqCst), round);
    }
    script.asked.borrow_mut().clear();
    script.round(&counter, true, &["a"]).expect("forced round");
    assert_eq!(
        *script.asked.borrow(),
        [("a", false)],
        "the 41st round waits like a foreground caller"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    script.asked.borrow_mut().clear();
    script.round(&counter, true, &["a"]).expect("round");
    assert_eq!(
        *script.asked.borrow(),
        [("a", true)],
        "then it yields again"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[test]
fn a_round_without_a_skip_resets_the_count_and_an_error_still_updates_it() {
    let script = Script::new(false);
    let counter = AtomicU32::new(12);
    script.round(&counter, true, &["a"]).expect("round");
    assert_eq!(counter.load(Ordering::SeqCst), 0);

    let counter = AtomicU32::new(3);
    let failed = reconcile_round(
        &counter,
        true,
        vec![("a".to_string(), 0), ("b".to_string(), 1)],
        |lease, _| Ok(if *lease == 0 { None } else { Some(false) }),
        |_, _| Err(anyhow!("stale handling failed")),
    );
    assert!(failed.is_err());
    assert_eq!(
        counter.load(Ordering::SeqCst),
        4,
        "the skip before the failure counts"
    );
}

#[test]
fn the_service_starts_with_no_skipped_rounds() {
    let service = RelatedScenesService::default();
    assert_eq!(service.skipped_rounds.load(Ordering::SeqCst), 0);
}
