use super::EmbedderAdmission;
use anyhow::{anyhow, Result};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

// Timeouts only bound a broken test's lifetime. Ordering is established by
// operation-entry messages and the admission helper's actual waiter count.
const WATCHDOG: Duration = Duration::from_secs(5);
type Worker<T> = (Receiver<thread::Result<T>>, JoinHandle<()>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Entry {
    Background(usize),
    Foreground(usize),
}

#[derive(Clone, Copy, Debug)]
enum Failure {
    Error,
    Panic,
}

impl Failure {
    fn raise(self) -> Result<()> {
        match self {
            Self::Error => Err(anyhow!("synthetic admitted operation error")),
            Self::Panic => panic!("synthetic admitted operation panic"),
        }
    }
}

#[derive(Default)]
struct Activity {
    current: AtomicUsize,
    maximum: AtomicUsize,
}

impl Activity {
    fn enter(&self) -> Active<'_> {
        let active = self.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(active, Ordering::SeqCst);
        Active(self)
    }

    fn assert_serial_and_idle(&self) {
        assert_eq!(self.maximum.load(Ordering::SeqCst), 1);
        assert_eq!(self.current.load(Ordering::SeqCst), 0);
    }
}

struct Active<'a>(&'a Activity);

impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.current.fetch_sub(1, Ordering::SeqCst);
    }
}

fn receive<T>(receiver: &Receiver<T>) -> Result<T> {
    receiver
        .recv_timeout(WATCHDOG)
        .map_err(|error| anyhow!("admission test watchdog or disconnected channel: {error}"))
}

fn report(sender: &Sender<Entry>, entry: Entry) -> Result<()> {
    sender
        .send(entry)
        .map_err(|_| anyhow!("admission test observer disconnected"))
}

fn worker<T: Send + 'static>(operation: impl FnOnce() -> T + Send + 'static) -> Worker<T> {
    let (done, completed) = mpsc::channel();
    let handle = thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation));
        let _ = done.send(result);
    });
    (completed, handle)
}

fn finish<T>((completed, handle): Worker<T>) -> thread::Result<T> {
    // Never join an unfinished worker after a failed callback/watchdog. Its
    // channels are owned, and dropping the test's release senders unblocks it.
    let result = receive(&completed).expect("admitted worker must finish");
    handle.join().expect("worker wrapper must finish normally");
    result
}

fn background(
    admission: &Arc<EmbedderAdmission>,
    activity: &Arc<Activity>,
    entries: &Sender<Entry>,
    release_first: Receiver<()>,
    failure: Option<Failure>,
) -> Worker<Result<Vec<usize>>> {
    let admission = Arc::clone(admission);
    let activity = Arc::clone(activity);
    let entries = entries.clone();
    worker(move || {
        admission.map_background(
            &[1, 2],
            || Ok(()),
            |document| {
                let _active = activity.enter();
                report(&entries, Entry::Background(*document))?;
                if *document == 1 {
                    receive(&release_first)?;
                    if let Some(failure) = failure {
                        failure.raise()?;
                    }
                }
                Ok(document * 10)
            },
        )
    })
}

fn foreground(
    admission: &Arc<EmbedderAdmission>,
    activity: &Arc<Activity>,
    entries: &Sender<Entry>,
    id: usize,
    release: Receiver<()>,
    failure: Option<Failure>,
) -> Worker<Result<usize>> {
    let admission = Arc::clone(admission);
    let activity = Arc::clone(activity);
    let entries = entries.clone();
    worker(move || {
        admission.foreground(|| {
            let _active = activity.enter();
            report(&entries, Entry::Foreground(id))?;
            receive(&release)?;
            if let Some(failure) = failure {
                failure.raise()?;
            }
            Ok(id)
        })
    })
}

fn assert_failure<T>(result: thread::Result<Result<T>>, failure: Failure) {
    match (failure, result) {
        (Failure::Error, Ok(Err(error))) => {
            assert!(error
                .to_string()
                .contains("synthetic admitted operation error"));
        }
        (Failure::Panic, Err(_)) => {}
        _ => panic!("expected admitted {failure:?} to propagate"),
    }
}

#[test]
fn queued_foreground_and_late_foreground_run_before_the_next_document() {
    let admission = Arc::new(EmbedderAdmission::default());
    let activity = Arc::new(Activity::default());
    let (entries, observed) = mpsc::channel();
    let (release_first, first_released) = mpsc::channel();
    let batch = background(&admission, &activity, &entries, first_released, None);
    assert_eq!(
        receive(&observed).expect("doc1 entered"),
        Entry::Background(1)
    );

    let mut releases = Vec::new();
    let mut queries = Vec::new();
    for id in 1..=2 {
        let (release, released) = mpsc::channel();
        releases.push(release);
        queries.push(foreground(
            &admission, &activity, &entries, id, released, None,
        ));
    }
    assert!(admission.wait_for_foreground_waiters(2));
    release_first.send(()).expect("release doc1");
    let Entry::Foreground(first) = receive(&observed).expect("first foreground entered") else {
        panic!("doc2 overtook queued foreground work");
    };
    assert!((1..=2).contains(&first));

    // Register another query while the first query still owns admission.
    // One original waiter and this new waiter must both precede doc2.
    let (release_third, third_released) = mpsc::channel();
    releases.push(release_third);
    queries.push(foreground(
        &admission,
        &activity,
        &entries,
        3,
        third_released,
        None,
    ));
    assert!(admission.wait_for_foreground_waiters(2));
    let mut served = vec![first];
    releases[first - 1]
        .send(())
        .expect("release first foreground");
    for _ in 0..2 {
        let Entry::Foreground(id) = receive(&observed).expect("remaining foreground entered")
        else {
            panic!("doc2 overtook a registered foreground waiter");
        };
        assert!((1..=3).contains(&id));
        assert!(!served.contains(&id), "a query must execute exactly once");
        served.push(id);
        releases[id - 1].send(()).expect("release foreground");
    }
    served.sort_unstable();
    assert_eq!(served, vec![1, 2, 3]);
    assert_eq!(
        receive(&observed).expect("doc2 entered"),
        Entry::Background(2)
    );
    assert_eq!(
        finish(batch)
            .expect("batch did not panic")
            .expect("batch succeeded"),
        vec![10, 20]
    );
    for (index, query) in queries.into_iter().enumerate() {
        assert_eq!(
            finish(query)
                .expect("query did not panic")
                .expect("query succeeded"),
            index + 1
        );
    }
    activity.assert_serial_and_idle();
    assert!(matches!(
        observed.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn background_error_and_panic_release_foreground_and_stop_the_batch() {
    for failure in [Failure::Error, Failure::Panic] {
        let admission = Arc::new(EmbedderAdmission::default());
        let activity = Arc::new(Activity::default());
        let (entries, observed) = mpsc::channel();
        let (release_first, first_released) = mpsc::channel();
        let batch = background(
            &admission,
            &activity,
            &entries,
            first_released,
            Some(failure),
        );
        assert_eq!(
            receive(&observed).expect("doc1 entered"),
            Entry::Background(1)
        );
        let (release_query, query_released) = mpsc::channel();
        let query = foreground(&admission, &activity, &entries, 1, query_released, None);
        assert!(admission.wait_for_foreground_waiters(1));
        release_first.send(()).expect("fail doc1");
        assert_eq!(
            receive(&observed).expect("query entered after failure"),
            Entry::Foreground(1)
        );
        release_query.send(()).expect("release query");
        assert_failure(finish(batch), failure);
        assert_eq!(
            finish(query)
                .expect("query did not panic")
                .expect("query succeeded"),
            1
        );
        activity.assert_serial_and_idle();
        assert!(
            matches!(observed.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "doc2 must not execute after {failure:?}"
        );
    }
}

#[test]
fn foreground_error_and_panic_release_the_next_waiter_before_background() {
    for failure in [Failure::Error, Failure::Panic] {
        let admission = Arc::new(EmbedderAdmission::default());
        let activity = Arc::new(Activity::default());
        let (entries, observed) = mpsc::channel();
        let (release_first, first_released) = mpsc::channel();
        let batch = background(&admission, &activity, &entries, first_released, None);
        assert_eq!(
            receive(&observed).expect("doc1 entered"),
            Entry::Background(1)
        );
        let (release_failed, failed_released) = mpsc::channel();
        let failed_query = foreground(
            &admission,
            &activity,
            &entries,
            1,
            failed_released,
            Some(failure),
        );
        assert!(admission.wait_for_foreground_waiters(1));
        release_first.send(()).expect("release doc1");
        assert_eq!(
            receive(&observed).expect("first query entered"),
            Entry::Foreground(1)
        );

        let (release_next, next_released) = mpsc::channel();
        let next_query = foreground(&admission, &activity, &entries, 2, next_released, None);
        assert!(admission.wait_for_foreground_waiters(1));
        release_failed.send(()).expect("fail first query");
        assert_eq!(
            receive(&observed).expect("second query entered"),
            Entry::Foreground(2)
        );
        release_next.send(()).expect("release second query");
        assert_eq!(
            receive(&observed).expect("doc2 entered"),
            Entry::Background(2)
        );

        assert_failure(finish(failed_query), failure);
        assert_eq!(
            finish(next_query)
                .expect("second query did not panic")
                .expect("second query succeeded"),
            2
        );
        assert_eq!(
            finish(batch)
                .expect("batch did not panic")
                .expect("batch succeeded"),
            vec![10, 20]
        );
        activity.assert_serial_and_idle();
        assert!(matches!(
            observed.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }
}

/// Hold the admission on a thread until released: the holder is an admitted
/// foreground inference.
fn hold_admission(admission: &Arc<EmbedderAdmission>) -> (Sender<()>, Worker<Result<()>>) {
    let (held_tx, held_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let admission = Arc::clone(admission);
    let holder = worker(move || {
        admission.foreground(|| {
            held_tx.send(()).expect("announce held");
            receive(&release_rx)
        })
    });
    receive(&held_rx).expect("holder owns the admission");
    (release_tx, holder)
}

/// DR-CHATIR-S1-12 (c), released in time: a `foreground_until` that waits for a
/// holder runs its operation once the holder lets go inside the deadline; while
/// it waits it is one queued foreground waiter, so a background batch does not
/// enter (not while the waiter waits, and not between the holder and the
/// waiter's operation); the batch runs only after the operation ended.
#[test]
fn foreground_until_runs_when_the_holder_releases_in_time_and_queues_ahead_of_background() {
    let admission = Arc::new(EmbedderAdmission::default());
    let (release_holder, holder) = hold_admission(&admission);
    let (order_tx, order_rx) = mpsc::channel::<&'static str>();
    let (finish_op_tx, finish_op_rx) = mpsc::channel::<()>();

    let waiter = {
        let (admission, order) = (Arc::clone(&admission), order_tx.clone());
        worker(move || {
            admission.foreground_until(Instant::now() + Duration::from_secs(30), || {
                order.send("foreground-operation").expect("report");
                receive(&finish_op_rx)
            })
        })
    };
    assert!(admission.wait_for_foreground_waiters(1));
    assert_eq!(admission.foreground_waiters_for_test(), 1);

    let batch = {
        let (admission, order) = (Arc::clone(&admission), order_tx);
        worker(move || {
            admission.background(
                || Ok(()),
                || {
                    order.send("background").expect("report");
                    Ok(())
                },
            )
        })
    };
    // Nothing runs while the holder holds the admission.
    assert!(matches!(
        order_rx.recv_timeout(Duration::from_millis(150)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert_eq!(admission.foreground_waiters_for_test(), 1);

    release_holder.send(()).expect("release the holder");
    finish(holder)
        .expect("holder did not panic")
        .expect("holder ok");
    assert_eq!(
        receive(&order_rx).expect("the waiter's operation entered"),
        "foreground-operation"
    );
    // The background batch still waits while the operation runs.
    assert!(matches!(
        order_rx.recv_timeout(Duration::from_millis(150)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    finish_op_tx.send(()).expect("finish the operation");
    let result = finish(waiter).expect("waiter did not panic");
    assert!(matches!(result, Ok(Some(()))));
    assert_eq!(
        receive(&order_rx).expect("background ran after"),
        "background"
    );
    finish(batch)
        .expect("batch did not panic")
        .expect("batch ok");
    assert_eq!(admission.foreground_waiters_for_test(), 0);
}

/// DR-CHATIR-S1-12 (c), withdrawn at the deadline: while the holder keeps the
/// admission, a `foreground_until` gives up at its deadline without running its
/// operation, its waiter count is gone (0), and a background batch that queued
/// meanwhile enters as soon as the holder lets go. A waiter that stayed counted
/// would keep the batch out forever.
#[test]
fn foreground_until_withdraws_its_waiter_at_the_deadline_and_background_then_enters() {
    let admission = Arc::new(EmbedderAdmission::default());
    let (release_holder, holder) = hold_admission(&admission);
    let ran = Arc::new(AtomicUsize::new(0));
    let waiter = {
        let (admission, ran) = (Arc::clone(&admission), Arc::clone(&ran));
        worker(move || {
            admission.foreground_until(Instant::now() + Duration::from_millis(200), || {
                ran.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        })
    };
    assert!(admission.wait_for_foreground_waiters(1));
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let batch = {
        let admission = Arc::clone(&admission);
        worker(move || {
            admission.background(
                || Ok(()),
                || {
                    entered_tx.send(()).expect("report");
                    Ok(())
                },
            )
        })
    };
    let result = finish(waiter).expect("waiter did not panic");
    assert!(matches!(result, Ok(None)), "the wait ended at the deadline");
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    assert_eq!(admission.foreground_waiters_for_test(), 0);
    // Still held: the batch is queued, not running.
    assert!(matches!(
        entered_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_holder.send(()).expect("release the holder");
    finish(holder)
        .expect("holder did not panic")
        .expect("holder ok");
    receive(&entered_rx).expect("background entered with no waiter counted");
    finish(batch)
        .expect("batch did not panic")
        .expect("batch ok");
}
