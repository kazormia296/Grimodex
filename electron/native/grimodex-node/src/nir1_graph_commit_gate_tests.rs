//! LP-GATE (DR-CQD-GATE-9): the gate's state machine on a manual clock. A
//! wait advances the clock instead of sleeping, and a hook may change the
//! state "during" a wait (another actor), so every case is deterministic.
use super::*;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

type WaitHook = Box<dyn FnMut(&mut GateCore, Duration) + Send>;

struct ManualClock {
    base: Instant,
    offset: Arc<Mutex<Duration>>,
    hook: Mutex<Option<WaitHook>>,
}

impl GateClock for ManualClock {
    fn now(&self) -> Instant {
        self.base + *self.offset.lock().unwrap()
    }

    fn wait<'a>(
        &self,
        _changed: &Condvar,
        mut core: MutexGuard<'a, GateCore>,
        timeout: Duration,
    ) -> MutexGuard<'a, GateCore> {
        let at = {
            let mut offset = self.offset.lock().unwrap();
            *offset += timeout;
            *offset
        };
        if let Some(hook) = self.hook.lock().unwrap().as_mut() {
            hook(&mut core, at);
        }
        core
    }
}

struct Fixture {
    gate: Arc<GraphCommitGate>,
    offset: Arc<Mutex<Duration>>,
}

impl Fixture {
    fn new() -> Self {
        Self::with(GateLimits::default(), None)
    }

    fn with(limits: GateLimits, hook: Option<WaitHook>) -> Self {
        let offset = Arc::new(Mutex::new(Duration::ZERO));
        let clock = ManualClock {
            base: Instant::now(),
            offset: Arc::clone(&offset),
            hook: Mutex::new(hook),
        };
        Self {
            gate: GraphCommitGate::with_clock(limits, Box::new(clock)),
            offset,
        }
    }

    fn hooked(hook: impl FnMut(&mut GateCore, Duration) + Send + 'static) -> Self {
        Self::with(GateLimits::default(), Some(Box::new(hook)))
    }

    fn at(&self) -> Duration {
        *self.offset.lock().unwrap()
    }

    fn advance(&self, by: Duration) {
        *self.offset.lock().unwrap() += by;
    }

    fn open(&self) -> Option<WindowLease> {
        self.gate.open_window(|| true)
    }

    fn enter(&self) -> FreshnessAdmission {
        self.gate.enter_freshness(|| false)
    }

    fn core<R>(&self, f: impl FnOnce(&mut GateCore) -> R) -> R {
        f(&mut self.gate.lock())
    }
}

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

fn admitted(admission: FreshnessAdmission) -> FreshnessSection {
    match admission {
        FreshnessAdmission::Admitted(section) => section,
        FreshnessAdmission::Overridden(_) => panic!("overridden, expected admitted"),
        FreshnessAdmission::Deferred => panic!("deferred, expected admitted"),
        FreshnessAdmission::Stopped => panic!("stopped, expected admitted"),
    }
}

fn kind(admission: &FreshnessAdmission) -> &'static str {
    match admission {
        FreshnessAdmission::Admitted(_) => "admitted",
        FreshnessAdmission::Overridden(_) => "overridden",
        FreshnessAdmission::Deferred => "deferred",
        FreshnessAdmission::Stopped => "stopped",
    }
}

#[test]
fn an_idle_gate_admits_freshness_at_once_and_the_section_ends_on_drop() {
    let fixture = Fixture::new();
    let section = admitted(fixture.enter());
    assert_eq!(fixture.at(), Duration::ZERO, "no wait");
    assert_eq!(fixture.gate.live_for_test(), (0, 1));
    drop(section);
    assert_eq!(fixture.gate.live_for_test(), (0, 0));
    assert_eq!(fixture.gate.counters(), GateCounters::default());
}

#[test]
fn a_live_window_defers_freshness_after_the_admit_wait_and_gives_it_the_turn() {
    let fixture = Fixture::new();
    let lease = fixture.open().expect("an idle gate opens a window");
    let admission = fixture.enter();
    assert_eq!(kind(&admission), "deferred");
    assert_eq!(
        fixture.at(),
        FRESHNESS_ADMIT_WAIT,
        "it waited exactly the admit wait"
    );
    let counters = fixture.gate.counters();
    assert_eq!((counters.deferred, counters.windows_opened), (1, 1));
    assert_eq!(
        fixture.gate.live_for_test(),
        (1, 0),
        "no section while deferred"
    );
    fixture.core(|core| {
        assert_eq!(
            core.turn_until,
            Some(fixture.gate.clock.now() + FRESHNESS_DEFER_TURN)
        );
    });
    drop(lease);
}

#[test]
fn a_window_that_closes_during_the_wait_admits_freshness_in_the_same_call() {
    let fixture = Fixture::hooked(|core, at| {
        if at >= ms(30) {
            core.leases.clear();
        }
    });
    let _lease = fixture.open().expect("window");
    let section = admitted(fixture.enter());
    assert_eq!(
        fixture.at(),
        ms(30),
        "admitted at the first wake after the close"
    );
    let counters = fixture.gate.counters();
    assert_eq!((counters.waited_admit, counters.deferred), (1, 0));
    drop(section);
}

#[test]
fn a_lease_stops_counting_at_its_deadline() {
    let fixture = Fixture::new();
    let lease = fixture.open().expect("window");
    assert_eq!(kind(&fixture.enter()), "deferred");
    fixture.advance(ms(10));
    // The second call wakes at the lease's deadline (500 ms), not at a step
    // past it.
    let section = admitted(fixture.enter());
    assert_eq!(fixture.at(), WINDOW_LEASE_MAX);
    let counters = fixture.gate.counters();
    assert_eq!((counters.lease_expired, counters.deferred), (1, 1));
    // The expired lease's own Drop finds nothing.
    drop(lease);
    assert_eq!(fixture.gate.live_for_test(), (0, 1));
    drop(section);
}

#[test]
fn freshness_goes_on_past_the_ceiling_while_a_window_stays_live() {
    let limits = GateLimits {
        lease_max: Duration::from_secs(5),
        ..GateLimits::default()
    };
    let fixture = Fixture::with(limits, None);
    let _lease = fixture.open().expect("window");
    let mut kinds = Vec::new();
    let section = loop {
        let admission = fixture.enter();
        kinds.push(kind(&admission));
        match admission {
            FreshnessAdmission::Overridden(section) => break section,
            FreshnessAdmission::Deferred => fixture.advance(ms(10)),
            _ => panic!("unexpected {kinds:?}"),
        }
    };
    // 0→250, 260→510, 520→770 deferred; 780→1000 (the ceiling) overridden.
    assert_eq!(kinds, ["deferred", "deferred", "deferred", "overridden"]);
    assert_eq!(
        fixture.at(),
        FRESHNESS_BLOCK_CEILING,
        "the ceiling counts from the first wait"
    );
    let counters = fixture.gate.counters();
    assert_eq!((counters.deferred, counters.overridden), (3, 1));
    fixture.core(|core| {
        assert_eq!(core.blocked_since, None, "a section resets the ceiling");
        assert_eq!(core.turn_until, None);
    });
    drop(section);
}

#[test]
fn a_stopped_lifecycle_ends_the_wait_without_the_turn() {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let fixture = Fixture::hooked(move |_core, at| {
        if at >= ms(20) {
            flag.store(true, Ordering::SeqCst);
        }
    });
    let _lease = fixture.open().expect("window");
    let admission = fixture.gate.enter_freshness(|| stop.load(Ordering::SeqCst));
    assert_eq!(kind(&admission), "stopped");
    assert_eq!(fixture.at(), ms(20), "at the first step after the stop");
    fixture.core(|core| assert_eq!(core.turn_until, None, "a stop takes no turn"));
    let counters = fixture.gate.counters();
    assert_eq!((counters.stopped, counters.deferred), (1, 0));
}

#[test]
fn a_waiting_graph_holds_new_sections_back_but_not_during_freshnesss_turn() {
    let fixture = Fixture::new();
    // A Graph waiting (for a section that is not there yet in this model).
    fixture.core(|core| core.graph_waiters = 1);
    let admission = fixture.enter();
    assert_eq!(kind(&admission), "deferred", "a waiting Graph goes first");
    // Deferred: Freshness has the turn, so the same waiting Graph no longer
    // holds it back.
    fixture.advance(ms(10));
    let section = admitted(fixture.enter());
    fixture.core(|core| assert_eq!(core.turn_until, None, "the section ends the turn"));
    drop(section);
    // After the turn the waiter holds a fresh call back again.
    fixture.advance(ms(10));
    assert_eq!(kind(&fixture.enter()), "deferred");
    fixture.core(|core| core.graph_waiters = 0);
}

#[test]
fn the_graph_waits_for_a_section_in_flight_and_opens_when_it_ends() {
    let fixture = Fixture::hooked(|core, at| {
        if at >= ms(30) && core.sections > 0 {
            core.end_section();
        }
    });
    let section = admitted(fixture.enter());
    let lease = fixture.open().expect("opens once the section ended");
    assert_eq!(fixture.at(), ms(30));
    let counters = fixture.gate.counters();
    assert_eq!((counters.graph_waited, counters.windows_opened), (1, 1));
    fixture.core(|core| assert_eq!(core.graph_waiters, 0));
    std::mem::forget(section); // its section was ended by the hook
    drop(lease);
}

#[test]
fn past_its_budget_the_graph_goes_on_without_a_window() {
    let fixture = Fixture::new();
    let section = admitted(fixture.enter());
    assert!(
        fixture.open().is_none(),
        "no window while the section stays"
    );
    assert_eq!(fixture.at(), GRAPH_SECTION_WAIT);
    let counters = fixture.gate.counters();
    assert_eq!(
        (counters.graph_wait_expired, counters.windows_opened),
        (1, 0)
    );
    fixture.core(|core| {
        assert_eq!(core.graph_waiters, 0);
        assert!(core.leases.is_empty(), "no lease is taken past the budget");
    });
    drop(section);
}

#[test]
fn the_graph_waits_out_freshnesss_turn_within_its_budget() {
    let fixture = Fixture::new();
    let lease = fixture.open().expect("window");
    assert_eq!(kind(&fixture.enter()), "deferred");
    drop(lease);
    let deferred_at = fixture.at();
    // Freshness does not come back (no retry): the turn ends after 50 ms.
    let lease = fixture.open().expect("opens when the turn ends");
    assert_eq!(fixture.at() - deferred_at, FRESHNESS_DEFER_TURN);
    assert_eq!(fixture.gate.counters().graph_waited, 1);
    drop(lease);
}

#[test]
fn freshness_retrying_in_its_turn_goes_before_a_waiting_graph() {
    // The Graph waits in the turn; Freshness re-enters (the scheduler's 10 ms
    // retry) and must not wait for that Graph.
    let fixture = Fixture::new();
    let lease = fixture.open().expect("window");
    assert_eq!(kind(&fixture.enter()), "deferred");
    drop(lease);
    fixture.core(|core| core.graph_waiters = 1); // a Graph waiting in the turn
    fixture.advance(ms(10));
    let section = admitted(fixture.enter());
    assert_eq!(
        fixture.at(),
        FRESHNESS_ADMIT_WAIT + ms(10),
        "no wait at all"
    );
    drop(section);
    fixture.core(|core| core.graph_waiters = 0);
}

#[test]
fn an_unwanted_window_is_not_opened() {
    let fixture = Fixture::new();
    assert!(fixture.gate.open_window(|| false).is_none());
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancelled);
    let fixture = Fixture::hooked(move |_core, at| {
        if at >= ms(20) {
            flag.store(true, Ordering::SeqCst);
        }
    });
    let section = admitted(fixture.enter());
    assert!(fixture
        .gate
        .open_window(|| !cancelled.load(Ordering::SeqCst))
        .is_none());
    assert!(
        fixture.at() < GRAPH_SECTION_WAIT,
        "a cancellation ends the wait at its step"
    );
    let counters = fixture.gate.counters();
    assert_eq!(
        (counters.graph_wait_expired, counters.windows_opened),
        (0, 0)
    );
    fixture.core(|core| assert_eq!(core.graph_waiters, 0));
    drop(section);
}

#[test]
fn an_edge_drops_every_window_and_a_close_refuses_new_ones() {
    let fixture = Fixture::new();
    let first = fixture.open().expect("window");
    fixture.gate.invalidate_all(false);
    assert_eq!(fixture.gate.live_for_test(), (0, 0));
    drop(admitted(fixture.enter()));
    let second = fixture.open().expect("an edge does not close the gate");
    fixture.gate.invalidate_all(true);
    assert!(fixture.open().is_none(), "closed");
    drop((first, second));
    assert_eq!(fixture.gate.live_for_test(), (0, 0));
}

#[test]
fn leases_and_sections_end_on_an_unwind() {
    let fixture = Fixture::new();
    let gate = Arc::clone(&fixture.gate);
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _lease = gate.open_window(|| true).expect("window");
        panic!("owner thread panics with a window");
    }));
    assert!(result.is_err());
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _section = admitted(gate.enter_freshness(|| false));
        panic!("cycle panics in its section");
    }));
    assert!(result.is_err());
    assert_eq!(fixture.gate.live_for_test(), (0, 0));
}

#[test]
fn every_window_must_end_before_freshness_enters_without_an_override() {
    let fixture = Fixture::with(
        GateLimits {
            lease_max: Duration::from_secs(5),
            ..GateLimits::default()
        },
        None,
    );
    let first = fixture.open().expect("window");
    let second = fixture.open().expect("a second window");
    assert_eq!(kind(&fixture.enter()), "deferred");
    drop(first);
    fixture.advance(ms(60));
    assert_eq!(
        kind(&fixture.enter()),
        "deferred",
        "one window is still live"
    );
    drop(second);
    fixture.advance(ms(10));
    drop(admitted(fixture.enter()));
}

/// A bounded enumeration of operation sequences (length 4 over 7 operations)
/// on the real gate and the manual clock. After every step: a section and a
/// live window coexist only after an override; a Graph that opened a window
/// saw no section; no waiter is left behind; dropping everything empties it.
#[test]
fn every_short_sequence_keeps_the_invariants() {
    const OPS: usize = 7;
    let mut sequences = 0;
    for code in 0..OPS.pow(4) {
        let fixture = Fixture::new();
        let mut leases: Vec<WindowLease> = Vec::new();
        let mut sections: Vec<FreshnessSection> = Vec::new();
        let mut overridden = false;
        let mut digits = code;
        for _ in 0..4 {
            let op = digits % OPS;
            digits /= OPS;
            match op {
                0 => {
                    let had_section = fixture.gate.live_for_test().1 > 0;
                    if let Some(lease) = fixture.open() {
                        assert_eq!(
                            fixture.gate.live_for_test().1,
                            0,
                            "{code}: window over a section"
                        );
                        leases.push(lease);
                    } else {
                        assert!(had_section || fixture.core(|c| c.turn_until.is_some()));
                    }
                }
                1 => {
                    leases.pop();
                }
                2 => match fixture.enter() {
                    FreshnessAdmission::Admitted(section) => {
                        assert_eq!(
                            fixture.gate.live_for_test().0,
                            0,
                            "{code}: admitted over a window"
                        );
                        sections.push(section);
                    }
                    FreshnessAdmission::Overridden(section) => {
                        overridden = true;
                        sections.push(section);
                    }
                    FreshnessAdmission::Deferred => {}
                    FreshnessAdmission::Stopped => panic!("{code}: no stop here"),
                },
                3 => {
                    sections.pop();
                }
                4 => fixture.advance(ms(60)),
                5 => fixture.advance(ms(510)),
                _ => fixture.gate.invalidate_all(false),
            }
            let (live, live_sections) = fixture.gate.live_for_test();
            if live > 0 && live_sections > 0 {
                assert!(
                    overridden,
                    "{code}: a section and a window without an override"
                );
            }
            fixture.core(|core| assert_eq!(core.graph_waiters, 0, "{code}: a waiter left behind"));
        }
        drop(leases);
        drop(sections);
        assert_eq!(
            fixture.gate.live_for_test(),
            (0, 0),
            "{code}: not empty at the end"
        );
        sequences += 1;
    }
    assert_eq!(sequences, OPS.pow(4));
}

/// The product clock: a window that ends wakes a waiting Freshness at once
/// (the condition variable), not at the end of its admit wait.
#[test]
fn a_window_that_ends_wakes_a_waiting_freshness_on_the_system_clock() {
    struct SignalingClock(Mutex<Option<mpsc::Sender<()>>>);
    impl GateClock for SignalingClock {
        fn now(&self) -> Instant {
            Instant::now()
        }
        fn wait<'a>(
            &self,
            changed: &Condvar,
            core: MutexGuard<'a, GateCore>,
            timeout: Duration,
        ) -> MutexGuard<'a, GateCore> {
            if let Some(sender) = self.0.lock().unwrap().take() {
                let _ = sender.send(());
            }
            changed
                .wait_timeout(core, timeout)
                .unwrap_or_else(PoisonError::into_inner)
                .0
        }
    }
    let (sender, waiting) = mpsc::channel();
    let limits = GateLimits {
        admit_wait: Duration::from_secs(20),
        ceiling: Duration::from_secs(40),
        lease_max: Duration::from_secs(60),
        step: Duration::from_secs(10),
        ..GateLimits::default()
    };
    let gate =
        GraphCommitGate::with_clock(limits, Box::new(SignalingClock(Mutex::new(Some(sender)))));
    let lease = gate.open_window(|| true).expect("window");
    let freshness = {
        let gate = Arc::clone(&gate);
        std::thread::spawn(move || {
            let started = Instant::now();
            let admission = gate.enter_freshness(|| false);
            (kind(&admission), started.elapsed())
        })
    };
    waiting.recv().expect("freshness is waiting");
    drop(lease);
    let (admission, elapsed) = freshness.join().expect("join");
    assert_eq!(admission, "admitted");
    assert!(
        elapsed < Duration::from_secs(10),
        "woken by the release, not a step: {elapsed:?}"
    );
    assert_eq!(gate.live_for_test(), (0, 0));
}
