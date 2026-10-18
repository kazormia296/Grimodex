//! The OS-dependent part of the DT-5b cancellation: a shutdown wakes a blocked
//! read, a blocked write ends within a bound, and the join is bounded. These
//! run on Linux, macOS and Windows (CI), and only use `std`.

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

#[test]
fn io2_shutdown_wakes_a_blocked_read() {
    let Some((client, server)) = pair() else {
        return;
    };
    // The server side stays idle and open: only the shutdown can wake the read.
    let reader = client.try_clone().expect("clone");
    // A long timeout is only a backstop so that a failure cannot hang CI. It
    // is far above the bound asserted below.
    reader
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("backstop timeout");
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel::<(io::Result<usize>, Duration)>();
    let handle = thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 16];
        let started = Instant::now();
        started_tx.send(()).expect("started");
        let result = reader.read(&mut buffer);
        let _ = result_tx.send((result, started.elapsed()));
    });
    started_rx.recv().expect("the reader started");
    thread::sleep(Duration::from_millis(200));
    assert!(
        result_rx.try_recv().is_err(),
        "the read blocks while the peer is idle"
    );
    let shutdown_at = Instant::now();
    shutdown_both(&client);
    let (result, _) = result_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the shutdown woke the blocked read");
    let woke_after = shutdown_at.elapsed();
    match &result {
        Ok(0) => {}
        Err(error)
            if !matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) => {}
        other => panic!("the read must end by the shutdown, not a timeout: {other:?}"),
    }
    eprintln!("io2: blocked read woke {woke_after:?} after shutdown with {result:?}");
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
