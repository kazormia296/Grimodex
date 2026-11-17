use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::fake::{request, Fake, PendingSpec, PrepareMode};
use crate::chat_ir::flow::{execute, run_call, ChatIrResult};
use crate::chat_ir::item::{select_items, Candidate, IrItem};
use crate::chat_ir::ledger::Ledger;
use crate::chat_ir::permit::PermitPool;
use crate::chat_ir::status::ChatIrStatus;
use crate::chat_ir::{ChatIrConfig, ChatIrState};

fn config() -> ChatIrConfig {
    ChatIrConfig {
        deadline: Duration::from_millis(400),
        connection_probe: Duration::from_millis(50),
        max_in_flight: 2,
        ledger_capacity: 10,
        tail_budget: Duration::from_secs(5),
        tail_slice: Duration::from_millis(20),
        close_flush: Duration::from_millis(40),
    }
}

fn some_items(count: usize) -> Vec<IrItem> {
    let scenes: Vec<String> = (0..count).map(|index| format!("scene-{index}")).collect();
    let candidates: Vec<_> = scenes
        .iter()
        .map(|scene| Candidate {
            score: 0.9,
            scene_id: scene,
            revision_id: "r",
            evidence_id: "e",
            statement: r#"{"summary":"s"}"#,
            quote: "q".into(),
        })
        .collect();
    select_items(candidates, 0.8, 100, 1, |scene| Ok(Some(scene.to_string()))).unwrap()
}

fn ledger(capacity: usize) -> Mutex<Ledger> {
    Mutex::new(Ledger::new(capacity))
}

fn call(fake: &Fake, ledger: &Mutex<Ledger>) -> ChatIrResult {
    run_call(fake, &config(), ledger, &request(), Instant::now()).0
}

/// Runs `execute` in a thread like the product does and returns what the
/// receiver gets, with the thread's handle.
fn spawn_execute<'scope, 'env>(
    scope: &'scope std::thread::Scope<'scope, 'env>,
    fake: Fake,
    pool: &Arc<PermitPool>,
    ledger: &'scope Mutex<Ledger>,
    config: ChatIrConfig,
    accepted_at: Instant,
) -> (
    tokio::sync::oneshot::Receiver<ChatIrResult>,
    std::thread::ScopedJoinHandle<'scope, ()>,
) {
    let permit = pool.try_acquire().expect("a permit");
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = scope.spawn(move || {
        execute(fake, permit, config, ledger, request(), accepted_at, sender);
    });
    (receiver, handle)
}

// ---- order of the steps (S1A-7, S1A-14) ----------------------------------------

#[test]
fn steps_run_in_order_and_prepare_is_a_step_of_its_own() {
    let mut fake = Fake::new();
    fake.select = Ok(some_items(1));
    let result = call(&fake, &ledger(10));
    assert_eq!(result.status, ChatIrStatus::Available);
    assert_eq!(
        fake.entries()[..5],
        ["first_read", "prepare", "qualify", "score", "select"]
    );
}

#[test]
fn a_busy_first_read_ends_the_call_before_anything_is_embedded() {
    let mut fake = Fake::new();
    fake.first = Err(ChatIrStatus::ConnectionBusy);
    let result = call(&fake, &ledger(10));
    assert_eq!(result.status, ChatIrStatus::ConnectionBusy);
    assert_eq!(
        fake.entries(),
        ["first_read"],
        "prepare (admission, embedder) ran"
    );
}

#[test]
fn every_step_failure_is_the_closed_status_and_stops_the_call() {
    let mut fake = Fake::new();
    fake.prepare = PrepareMode::Cold;
    let result = call(&fake, &ledger(10));
    assert_eq!(result.status, ChatIrStatus::EmbedderCold);
    assert_eq!(fake.entries(), ["first_read", "prepare"]);
    let mut fake = Fake::new();
    fake.select = Err(ChatIrStatus::ProjectChanged);
    let result = call(&fake, &ledger(10));
    assert_eq!(result.status, ChatIrStatus::ProjectChanged);
    assert!(result.items.is_empty());
}

// ---- S1A-11: result shape -------------------------------------------------------

#[test]
fn none_above_threshold_is_a_success_and_a_failure_never_is() {
    let fake = Fake::new();
    let ledger = ledger(10);
    let none = call(&fake, &ledger);
    assert_eq!(none.status, ChatIrStatus::NoneAboveThreshold);
    let wire = none.to_wire();
    assert_eq!(wire["success"], true);
    assert_eq!(wire["items"], serde_json::json!([]));
    assert_eq!(
        ledger.lock().unwrap().len(),
        0,
        "a call without items issues nothing"
    );
    for status in ChatIrStatus::ALL {
        let wire = ChatIrResult::status_only(status).to_wire();
        assert_eq!(wire["status"], status.as_str());
        assert_eq!(wire["success"], status.is_success());
        assert_eq!(wire["items"], serde_json::json!([]));
        assert_eq!(wire.as_object().unwrap().len(), 3);
    }
}

#[test]
fn an_answer_carries_the_item_values_and_issues_them() {
    let mut fake = Fake::new();
    let items = some_items(2);
    fake.select = Ok(items.clone());
    let ledger = ledger(10);
    let result = call(&fake, &ledger);
    assert_eq!(result.status, ChatIrStatus::Available);
    let wire = result.to_wire();
    assert_eq!(wire["items"].as_array().unwrap().len(), 2);
    assert_eq!(wire["items"][0], items[0].value);
    assert_eq!(ledger.lock().unwrap().len(), 2);
}

// ---- S1A-18: issuing -----------------------------------------------------------

#[test]
fn a_full_ledger_refuses_the_call_and_returns_no_item() {
    let mut fake = Fake::new();
    fake.select = Ok(some_items(3));
    let small = ledger(2);
    let result = call(&fake, &small);
    assert_eq!(result.status, ChatIrStatus::LedgerFull);
    assert!(
        result.items.is_empty(),
        "an item that was not issued was returned"
    );
    assert_eq!(
        small.lock().unwrap().len(),
        0,
        "a part of the call was issued"
    );
}

#[test]
fn the_ledger_follows_the_database_identity() {
    let mut fake = Fake::new();
    fake.select = Ok(some_items(2));
    let ledger = ledger(10);
    call(&fake, &ledger);
    assert_eq!(ledger.lock().unwrap().len(), 2);
    fake.identity = 2;
    fake.select = Ok(some_items(1));
    call(&fake, &ledger);
    assert_eq!(
        ledger.lock().unwrap().len(),
        1,
        "an entry of another database stayed"
    );
}

// ---- S1A-6: the deadline -----------------------------------------------------------

#[test]
fn a_call_that_waited_for_the_blocking_pool_past_its_deadline_touches_nothing() {
    let fake = Fake::new();
    let accepted = Instant::now() - Duration::from_secs(30);
    let (result, pending) = run_call(&fake, &config(), &ledger(10), &request(), accepted);
    assert_eq!(result.status, ChatIrStatus::Timeout);
    assert!(pending.is_none());
    assert!(
        fake.entries().is_empty(),
        "the database or the model was touched"
    );
}

#[test]
fn an_inference_that_outlasts_the_deadline_ends_as_timeout_and_returns_everything() {
    let pool = PermitPool::new(2);
    let ledger = ledger(10);
    let mut fake = Fake::new();
    fake.prepare_sleep = Duration::from_millis(600); // the deadline is 400 ms
    fake.select = Ok(some_items(1));
    std::thread::scope(|scope| {
        let started = Instant::now();
        let (receiver, handle) = spawn_execute(scope, fake, &pool, &ledger, config(), started);
        let result = receiver.blocking_recv().expect("an answer");
        assert_eq!(result.status, ChatIrStatus::Timeout);
        assert!(
            result.items.is_empty(),
            "an answer after the deadline was returned"
        );
        // Deadline plus one inference, not more.
        assert!(started.elapsed() < Duration::from_millis(400 + 600 + 400));
        handle.join().unwrap();
    });
    assert_eq!(pool.in_flight(), 0);
    assert_eq!(
        ledger.lock().unwrap().len(),
        0,
        "an item after the deadline was issued"
    );
}

#[test]
fn an_answer_that_is_ready_only_after_the_deadline_is_not_issued() {
    let mut fake = Fake::new();
    fake.select_sleep = Duration::from_millis(500); // past the 400 ms deadline
    fake.select = Ok(some_items(2));
    let ledger = ledger(10);
    let result = call(&fake, &ledger);
    assert_eq!(result.status, ChatIrStatus::Timeout);
    assert_eq!(ledger.lock().unwrap().len(), 0);
}

// ---- S1A-5: a panic ------------------------------------------------------------------

#[test]
fn a_panic_returns_the_permit_and_everything_held_and_the_caller_gets_no_answer() {
    let pool = PermitPool::new(2);
    let ledger = ledger(10);
    let mut fake = Fake::new();
    fake.prepare = PrepareMode::Panic;
    fake.pool = Some(Arc::clone(&pool));
    let database = Arc::clone(&fake.database);
    let log = Arc::clone(&fake.log);
    std::thread::scope(|scope| {
        let (receiver, handle) =
            spawn_execute(scope, fake, &pool, &ledger, config(), Instant::now());
        assert!(handle.join().is_err(), "the task did not panic");
        // The caller side maps a dropped sender to `internal` (see
        // `a_task_that_ended_without_answering_is_internal`).
        assert!(receiver.blocking_recv().is_err());
    });
    assert_eq!(pool.in_flight(), 0, "the permit stayed after a panic");
    assert_eq!(
        Arc::strong_count(&database),
        1,
        "the pinned database stayed"
    );
    assert!(log
        .lock()
        .unwrap()
        .iter()
        .any(|entry| entry.starts_with("backend dropped")));
}

// ---- S1A-12 / S1A-4: the tail -----------------------------------------------------------

#[test]
fn the_answer_comes_before_the_tail_and_the_permit_is_held_through_it() {
    let pool = PermitPool::new(2);
    let ledger = ledger(10);
    let spec = PendingSpec::on_call(Duration::from_millis(150), 2);
    let written = Arc::clone(&spec.written);
    let mut fake = Fake::new();
    fake.prepare = PrepareMode::Pending(spec);
    fake.pool = Some(Arc::clone(&pool));
    std::thread::scope(|scope| {
        let (receiver, handle) =
            spawn_execute(scope, fake, &pool, &ledger, config(), Instant::now());
        let result = receiver.blocking_recv().expect("an answer");
        assert_eq!(result.status, ChatIrStatus::Timeout);
        // The write has not finished: the answer did not wait for it.
        assert!(
            !written.load(Ordering::SeqCst),
            "the answer waited for the flush"
        );
        // The task is still running and still holds its permit.
        assert_eq!(pool.in_flight(), 1, "the permit was released at the answer");
        handle.join().unwrap();
    });
    assert!(
        written.load(Ordering::SeqCst),
        "the tail never wrote the records"
    );
    assert_eq!(pool.in_flight(), 0);
}

#[test]
fn tails_count_against_the_in_flight_limit() {
    let pool = PermitPool::new(2);
    let ledger = ledger(10);
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..2 {
            let mut fake = Fake::new();
            fake.prepare =
                PrepareMode::Pending(PendingSpec::on_call(Duration::from_millis(100), 4));
            let (receiver, handle) =
                spawn_execute(scope, fake, &pool, &ledger, config(), Instant::now());
            receiver.blocking_recv().expect("an answer");
            handles.push(handle);
        }
        // Both answered and are in their tails: a third call is `busy`.
        assert!(
            pool.try_acquire().is_none(),
            "a tail did not hold its permit"
        );
        for handle in handles {
            handle.join().unwrap();
        }
    });
    assert!(pool.try_acquire().is_some());
}

#[test]
fn a_stop_request_ends_the_tail_within_a_slice_and_the_last_attempt() {
    let pool = PermitPool::new(2);
    let ledger = ledger(10);
    let mut cfg = config();
    cfg.tail_budget = Duration::from_secs(30);
    let mut fake = Fake::new();
    fake.prepare = PrepareMode::Pending(PendingSpec::never(Duration::from_millis(500)));
    let stop = Arc::clone(&fake.stop);
    std::thread::scope(|scope| {
        let (receiver, handle) = spawn_execute(scope, fake, &pool, &ledger, cfg, Instant::now());
        receiver.blocking_recv().expect("an answer");
        let stop_at = Instant::now();
        stop.store(true, Ordering::SeqCst);
        handle.join().unwrap();
        let after = stop_at.elapsed();
        // slice 20 ms + close flush 40 ms (+ scheduling): nowhere near 30 s.
        assert!(
            after < Duration::from_millis(1500),
            "the tail outlived the stop by {after:?}"
        );
    });
    assert_eq!(pool.in_flight(), 0);
}

#[test]
fn what_the_task_holds_is_released_pending_then_backend_then_permit() {
    let pool = PermitPool::new(2);
    let ledger = ledger(10);
    let mut fake = Fake::new();
    fake.prepare = PrepareMode::Pending(PendingSpec::on_call(Duration::ZERO, 1));
    fake.pool = Some(Arc::clone(&pool));
    let database = Arc::clone(&fake.database);
    let log = Arc::clone(&fake.log);
    std::thread::scope(|scope| {
        let (receiver, handle) =
            spawn_execute(scope, fake, &pool, &ledger, config(), Instant::now());
        receiver.blocking_recv().expect("an answer");
        handle.join().unwrap();
    });
    let entries = log.lock().unwrap().clone();
    let position = |needle: &str| entries.iter().position(|entry| entry.starts_with(needle));
    let pending_at = position("pending dropped").expect("the pending records were dropped");
    let backend_at = position("backend dropped").expect("the backend was dropped");
    assert!(pending_at < backend_at, "{entries:?}");
    // The permit was still held when the backend was dropped.
    assert!(
        entries
            .iter()
            .any(|e| e == "backend dropped (permits held: 1)"),
        "{entries:?}"
    );
    assert_eq!(pool.in_flight(), 0);
    // Nothing keeps the pinned database any more (the sole-owner wait of a
    // shutdown or a restore would otherwise fail).
    assert_eq!(Arc::strong_count(&database), 1);
}

#[test]
fn a_task_that_ended_without_answering_is_internal() {
    // The caller side: a dropped sender is the closed `internal`.
    let (sender, receiver) = tokio::sync::oneshot::channel::<ChatIrResult>();
    drop(sender);
    let status = match receiver.blocking_recv() {
        Ok(result) => result.status,
        Err(_) => crate::chat_ir::answer_of_dropped_sender(),
    };
    assert_eq!(status, ChatIrStatus::Internal);
}

#[test]
fn the_state_defaults_are_the_documented_initial_values() {
    let state = ChatIrState::default();
    let config = state.config;
    assert_eq!(config.deadline, Duration::from_secs(10));
    assert_eq!(config.connection_probe, Duration::from_secs(1));
    assert_eq!(config.max_in_flight, 2);
    assert_eq!(config.ledger_capacity, 4096);
    assert_eq!(config.tail_budget, Duration::from_secs(30));
    assert_eq!(config.tail_slice, Duration::from_millis(250));
    assert_eq!(config.close_flush, Duration::from_secs(1));
}
