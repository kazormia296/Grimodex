//! The OS-dependent part of the DT-5b cancellation: a cancelled read and a
//! blocked write end within a bound set by `IO_SLICE` (whether or not the OS
//! lets `shutdown` wake them), and the join is bounded. These run on Linux,
//! macOS and Windows (CI), and only use `std`.

use super::*;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};

/// A connected loopback pair: (client, server side). `None` is a skip, which is
/// printed so that it cannot pass for a success.
fn pair() -> Option<(TcpStream, TcpStream)> {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("SKIPPED nir1_local_io: no IPv4 loopback listener ({error})");
            return None;
        }
    };
    let addr = listener.local_addr().expect("address");
    let client = TcpStream::connect(addr).expect("connect");
    let (server, _) = listener.accept().expect("accept");
    Some((client, server))
}

#[test]
fn io1_join_bounded_joins_a_finished_thread_and_reports_a_panic() {
    let finished = thread::spawn(|| {});
    assert_eq!(
        join_bounded(finished, Duration::from_secs(5)),
        JoinOutcome::Joined
    );
    // A panic in the joined thread is reported, not propagated.
    let panicked = thread::Builder::new()
        .name("io1-panic".into())
        .spawn(|| {
            panic!("expected: the test thread panics on purpose");
        })
        .expect("spawn");
    assert_eq!(
        join_bounded(panicked, Duration::from_secs(5)),
        JoinOutcome::Panicked
    );
}

#[test]
fn io1b_join_bounded_gives_up_on_a_stuck_thread_within_the_limit() {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (ended_tx, ended_rx) = mpsc::channel::<()>();
    let stuck = thread::spawn(move || {
        let _ = release_rx.recv();
        let _ = ended_tx.send(());
    });
    let limit = Duration::from_millis(150);
    let started = Instant::now();
    assert_eq!(join_bounded(stuck, limit), JoinOutcome::Overrun);
    let elapsed = started.elapsed();
    assert!(elapsed >= limit, "waited the whole limit: {elapsed:?}");
    assert!(
        elapsed < limit + Duration::from_secs(2),
        "the join is bounded: {elapsed:?}"
    );
    // The detached thread still runs; it ends when its own wait ends.
    assert!(ended_rx.try_recv().is_err());
    release_tx.send(()).expect("release");
    ended_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the detached thread ends by itself");
}

/// The bound on the end of a cancelled reader (DR-DT5-29): one [`IO_SLICE`]
/// plus a margin for timer granularity, CI scheduling and the reported
/// Winsock habit of returning a short `SO_RCVTIMEO` up to about 500 ms late.
/// It is half of the node's `join_limit` (2 s, DR-DT5-21), so a reader that
/// keeps it is joined, not quarantined, on every OS.
const CANCELLED_READ_END_BOUND: Duration = IO_SLICE.saturating_add(Duration::from_millis(900));

/// What the slice-reading thread of io2 reports.
enum ReaderEvent {
    Bytes(Vec<u8>),
    Ended(String),
}

#[test]
fn io2_a_blocked_read_ends_within_the_slice_bound_after_cancel() {
    // The product's read (node `io_run`): every `read` has a timeout of at most
    // `IO_SLICE`, a timeout is not an end, and the abort flag is looked at
    // before each slice. Whether `shutdown` also wakes a blocked `recv` is up
    // to the OS (Linux: yes; Winsock: not promised, and the Windows CI showed
    // it does not), so the assertion is the bound, not the way it ended.
    let Some((client, mut server)) = pair() else {
        return;
    };
    let reader = client.try_clone().expect("clone");
    reader
        .set_read_timeout(Some(IO_SLICE))
        .expect("slice timeout");
    let abort = Arc::new(AtomicBool::new(false));
    let slices = Arc::new(AtomicUsize::new(0));
    let (event_tx, event_rx) = mpsc::channel::<ReaderEvent>();
    let handle = {
        let abort = Arc::clone(&abort);
        let slices = Arc::clone(&slices);
        thread::spawn(move || {
            let mut stream = reader;
            let mut buffer = [0u8; 64];
            let how = loop {
                if abort.load(Ordering::Acquire) {
                    break "abort-flag".to_owned();
                }
                match stream.read(&mut buffer) {
                    Ok(0) => break "end-of-stream".to_owned(),
                    Ok(n) => {
                        let _ = event_tx.send(ReaderEvent::Bytes(buffer[..n].to_vec()));
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::Interrupted
                                | io::ErrorKind::WouldBlock
                                | io::ErrorKind::TimedOut
                        ) =>
                    {
                        slices.fetch_add(1, Ordering::AcqRel);
                    }
                    Err(error) => break format!("io-error:{:?}", error.kind()),
                }
            };
            let _ = event_tx.send(ReaderEvent::Ended(how));
        })
    };
    let wait_for_slices = |at_least: usize| {
        let started = Instant::now();
        while slices.load(Ordering::Acquire) < at_least {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the read timeout never fired"
            );
            thread::sleep(Duration::from_millis(5));
        }
        started.elapsed()
    };

    // A slice timeout is not an end: the reader keeps blocking on an idle peer,
    // and bytes that arrive after several timeouts are read whole.
    let idle = wait_for_slices(3);
    eprintln!("io2: 3 slice timeouts of {IO_SLICE:?} took {idle:?}");
    server.write_all(b"ping").expect("peer writes");
    let mut received = Vec::new();
    while received.len() < 4 {
        match event_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(ReaderEvent::Bytes(bytes)) => received.extend(bytes),
            Ok(ReaderEvent::Ended(how)) => panic!("the reader ended on an idle peer: {how}"),
            Err(error) => panic!("the bytes after the timeouts never arrived: {error}"),
        }
    }
    assert_eq!(received, b"ping");
    let seen = slices.load(Ordering::Acquire);
    wait_for_slices(seen + 2);
    assert!(
        event_rx.try_recv().is_err(),
        "the read blocks while the peer is idle"
    );

    // Cancel as the supervisor does (node `IoSide::stop`): the flag, then the
    // shutdown. The reader ends by the shutdown or by its next slice.
    let cancel_at = Instant::now();
    abort.store(true, Ordering::Release);
    shutdown_both(&client);
    let how = match event_rx.recv_timeout(CANCELLED_READ_END_BOUND) {
        Ok(ReaderEvent::Ended(how)) => how,
        Ok(ReaderEvent::Bytes(bytes)) => panic!("unexpected bytes after cancel: {bytes:?}"),
        Err(error) => {
            panic!("the cancelled reader did not end within {CANCELLED_READ_END_BOUND:?}: {error}")
        }
    };
    let elapsed = cancel_at.elapsed();
    eprintln!("io2: cancelled read ended {elapsed:?} after cancel via {how}");
    assert!(
        elapsed < CANCELLED_READ_END_BOUND,
        "bounded by the slice, not by the shutdown: {elapsed:?}"
    );
    assert_eq!(
        join_bounded(handle, Duration::from_secs(5)),
        JoinOutcome::Joined
    );
    drop(server);
}

#[test]
fn io3_a_blocked_write_ends_within_the_slice_bound() {
    let Some((client, server)) = pair() else {
        return;
    };
    // The server never reads, so the writer fills the buffers and blocks.
    let writer_stream = client.try_clone().expect("clone");
    writer_stream
        .set_write_timeout(Some(IO_SLICE))
        .expect("slice timeout");
    let abort = Arc::new(AtomicBool::new(false));
    let written = Arc::new(AtomicUsize::new(0));
    let (result_tx, result_rx) = mpsc::channel::<String>();
    let handle = {
        let abort = Arc::clone(&abort);
        let written = Arc::clone(&written);
        thread::spawn(move || {
            let mut stream = writer_stream;
            let chunk = vec![0u8; 64 * 1024];
            let how = loop {
                if abort.load(Ordering::Acquire) {
                    break "abort-flag".to_owned();
                }
                match stream.write(&chunk) {
                    Ok(n) => {
                        written.fetch_add(n, Ordering::AcqRel);
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                        ) => {}
                    Err(error) => break format!("io-error:{:?}", error.kind()),
                }
            };
            let _ = result_tx.send(how);
        })
    };
    // Wait until the writer stops making progress (the buffers are full).
    let started = Instant::now();
    let mut last = usize::MAX;
    let mut stable = 0;
    while stable < 4 {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the send buffer never filled"
        );
        thread::sleep(Duration::from_millis(100));
        let now = written.load(Ordering::Acquire);
        stable = if now == last { stable + 1 } else { 0 };
        last = now;
    }
    // Cancel: set the flag, then shut the socket down, as the supervisor does.
    let cancel_at = Instant::now();
    abort.store(true, Ordering::Release);
    shutdown_both(&client);
    let how = result_rx
        .recv_timeout(IO_SLICE * 20)
        .expect("the blocked write ends within the bound");
    let elapsed = cancel_at.elapsed();
    eprintln!(
        "io3: blocked write ended {elapsed:?} after cancel via {how} ({} bytes written)",
        written.load(Ordering::Acquire)
    );
    assert!(
        elapsed < IO_SLICE * 20,
        "bounded by the slice, not by the peer: {elapsed:?}"
    );
    assert_eq!(
        join_bounded(handle, Duration::from_secs(5)),
        JoinOutcome::Joined
    );
    drop(server);
}

#[test]
fn io4_a_shutdown_socket_gives_the_peer_an_end_of_stream() {
    // The server side sees the close that a cancelled attempt leaves behind.
    let Some((client, mut server)) = pair() else {
        return;
    };
    server
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("timeout");
    shutdown_both(&client);
    let mut buffer = [0u8; 8];
    match server.read(&mut buffer) {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
            ) => {}
        other => panic!("the peer must see the close: {other:?}"),
    }
}
