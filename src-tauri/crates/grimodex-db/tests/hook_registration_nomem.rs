//! DR-DBC-4, P3-1: a hook registration that runs out of memory must not leave an
//! SQLite hook registered.
//!
//! rusqlite 0.41 hands SQLite the pointer of the boxed closure first and records
//! it with `sqlite3_set_clientdata` afterwards. When that second step cannot
//! allocate (it allocates only for a name with no entry yet), rusqlite frees the
//! closure, returns `SQLITE_NOMEM` and leaves the hook registered. This file makes
//! SQLite's allocator refuse (`sqlite3_hard_heap_limit64`, process wide, so it is
//! the only test of this binary and nothing else runs in the window) and checks,
//! for each hook kind:
//!
//! * premise: the plain rusqlite registration returns `Err` **and the hook is
//!   still registered** (the closures here have no captures, so nothing is really
//!   freed and calling the hook is harmless);
//! * fix: `hook_registration` returns `Err` and no hook is registered;
//! * the entry it reserves is the one rusqlite replaces (a plain registration
//!   under the same memory limit then succeeds), and a disabled progress handler
//!   keeps its entry.

#![allow(dead_code)]

#[path = "../src/hook_registration.rs"]
mod hook_registration;

use rusqlite::hooks::{AuthContext, Authorization};
use rusqlite::{ffi, Connection};
use std::sync::atomic::{AtomicUsize, Ordering};

static AUTHORIZER_CALLS: AtomicUsize = AtomicUsize::new(0);
static PROGRESS_CALLS: AtomicUsize = AtomicUsize::new(0);
static COMMIT_CALLS: AtomicUsize = AtomicUsize::new(0);

fn count_authorizer(_: AuthContext<'_>) -> Authorization {
    AUTHORIZER_CALLS.fetch_add(1, Ordering::SeqCst);
    Authorization::Allow
}

fn count_progress() -> bool {
    PROGRESS_CALLS.fetch_add(1, Ordering::SeqCst);
    false
}

fn count_commit() -> bool {
    COMMIT_CALLS.fetch_add(1, Ordering::SeqCst);
    false
}

/// Run `operation` while SQLite's allocator refuses every further allocation.
fn without_sqlite_memory<T>(operation: impl FnOnce() -> T) -> T {
    // SAFETY: plain SQLite status calls; the limit is restored before returning.
    let prior = unsafe {
        let used = ffi::sqlite3_memory_used();
        ffi::sqlite3_hard_heap_limit64(used)
    };
    let result = operation();
    unsafe { ffi::sqlite3_hard_heap_limit64(prior) };
    result
}

fn is_nomem(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _) if failure.code == rusqlite::ErrorCode::OutOfMemory
    )
}

/// Statements that fire every hook kind: a progress tick (interval 1), an
/// authorizer call, and a commit.
fn fire_hooks(conn: &Connection) {
    conn.execute_batch(
        "BEGIN; CREATE TABLE IF NOT EXISTS probe(x); INSERT INTO probe VALUES (1); COMMIT;",
    )
    .expect("statements run without memory pressure");
}

fn reset_counters() {
    AUTHORIZER_CALLS.store(0, Ordering::SeqCst);
    PROGRESS_CALLS.store(0, Ordering::SeqCst);
    COMMIT_CALLS.store(0, Ordering::SeqCst);
}

/// The three checks share one process-wide memory limit, so they run in turn in
/// one test (the default harness runs separate tests in parallel threads).
#[test]
fn hook_registration_under_memory_pressure() {
    a_registration_that_runs_out_of_memory_leaves_no_hook();
    the_reserved_entry_is_the_one_rusqlite_replaces();
    a_disabled_progress_handler_keeps_its_entry_and_does_not_fire();
}

fn a_registration_that_runs_out_of_memory_leaves_no_hook() {
    // The harness must be able to refuse memory: statistics are on by default.
    let _open = Connection::open_in_memory().expect("open");
    assert!(unsafe { ffi::sqlite3_memory_used() } > 0);

    // ---- premise: rusqlite's own registration leaves the hook registered. ----
    let mut conn = Connection::open_in_memory().expect("open");
    let error = without_sqlite_memory(|| conn.commit_hook(Some(count_commit)))
        .expect_err("the entry cannot be allocated");
    assert!(is_nomem(&error), "{error:?}");
    // `sqlite3_commit_hook` returns the previous argument: not null means a hook
    // is still registered (with the argument of the freed closure).
    let still_registered =
        unsafe { ffi::sqlite3_commit_hook(conn.handle(), None, std::ptr::null_mut()) };
    assert!(
        !still_registered.is_null(),
        "premise: rusqlite 0.41 leaves the commit hook registered after SQLITE_NOMEM; \
         if this fails, rusqlite fixed it and DR-DBC-4 P3-1 can be simplified"
    );

    let mut conn = Connection::open_in_memory().expect("open");
    reset_counters();
    let error = without_sqlite_memory(|| conn.authorizer(Some(count_authorizer)))
        .expect_err("the entry cannot be allocated");
    assert!(is_nomem(&error), "{error:?}");
    conn.execute_batch("CREATE TABLE t(x)").expect("run");
    assert!(
        AUTHORIZER_CALLS.load(Ordering::SeqCst) > 0,
        "premise: the authorizer is still registered after SQLITE_NOMEM"
    );

    let mut conn = Connection::open_in_memory().expect("open");
    reset_counters();
    let error = without_sqlite_memory(|| conn.progress_handler(1, Some(count_progress)))
        .expect_err("the entry cannot be allocated");
    assert!(is_nomem(&error), "{error:?}");
    conn.execute_batch("CREATE TABLE t(x)").expect("run");
    assert!(
        PROGRESS_CALLS.load(Ordering::SeqCst) > 0,
        "premise: the progress handler is still registered after SQLITE_NOMEM"
    );

    // ---- fix: the same failures through hook_registration. ----
    let mut conn = Connection::open_in_memory().expect("open");
    reset_counters();
    let error =
        without_sqlite_memory(|| hook_registration::set_commit_hook(&mut conn, Some(count_commit)))
            .expect_err("the entry cannot be reserved");
    assert!(is_nomem(&error), "{error:?}");
    let leftover = unsafe { ffi::sqlite3_commit_hook(conn.handle(), None, std::ptr::null_mut()) };
    assert!(
        leftover.is_null(),
        "no commit hook is registered after the failure"
    );
    fire_hooks(&conn);
    assert_eq!(COMMIT_CALLS.load(Ordering::SeqCst), 0);

    let mut conn = Connection::open_in_memory().expect("open");
    reset_counters();
    let error = without_sqlite_memory(|| {
        hook_registration::set_authorizer(&mut conn, Some(count_authorizer))
    })
    .expect_err("the entry cannot be reserved");
    assert!(is_nomem(&error), "{error:?}");
    fire_hooks(&conn);
    assert_eq!(AUTHORIZER_CALLS.load(Ordering::SeqCst), 0);

    let mut conn = Connection::open_in_memory().expect("open");
    reset_counters();
    let error = without_sqlite_memory(|| {
        hook_registration::set_progress_handler(&mut conn, 1, Some(count_progress))
    })
    .expect_err("the entry cannot be reserved");
    assert!(is_nomem(&error), "{error:?}");
    fire_hooks(&conn);
    assert_eq!(PROGRESS_CALLS.load(Ordering::SeqCst), 0);

    // A handler registered by raw FFI (no clientdata entry, like the opt-in
    // diagnostics' meter installed at open) is not left enabled either when the
    // reservation fails.
    let mut raw = Connection::open_in_memory().expect("open");
    unsafe extern "C" fn raw_meter(_: *mut std::ffi::c_void) -> std::ffi::c_int {
        PROGRESS_CALLS.fetch_add(1, Ordering::SeqCst);
        0
    }
    // SAFETY: a live connection and a callback that ignores its argument.
    unsafe {
        ffi::sqlite3_progress_handler(raw.handle(), 1, Some(raw_meter), std::ptr::null_mut())
    };
    reset_counters();
    fire_hooks(&raw);
    assert!(
        PROGRESS_CALLS.load(Ordering::SeqCst) > 0,
        "premise: the raw meter fires"
    );
    reset_counters();
    let error = without_sqlite_memory(|| {
        hook_registration::set_progress_handler(&mut raw, 1, Some(count_progress))
    })
    .expect_err("the entry cannot be reserved");
    assert!(is_nomem(&error), "{error:?}");
    fire_hooks(&raw);
    assert_eq!(
        PROGRESS_CALLS.load(Ordering::SeqCst),
        0,
        "no progress handler (neither the new one nor the raw meter) is enabled after the failure"
    );
}

fn the_reserved_entry_is_the_one_rusqlite_replaces() {
    // After `reserve_entry` a plain rusqlite registration allocates nothing, so it
    // succeeds with no memory at all. A name that differed from rusqlite's would
    // fail here with SQLITE_NOMEM.
    let mut conn = Connection::open_in_memory().expect("open");
    hook_registration::reserve_entry(&mut conn, hook_registration::COMMIT_HOOK_ENTRY)
        .expect("reserve");
    without_sqlite_memory(|| conn.commit_hook(Some(count_commit))).expect("replaces the entry");
    conn.commit_hook(None::<fn() -> bool>).expect("clear");

    let mut conn = Connection::open_in_memory().expect("open");
    hook_registration::reserve_entry(&mut conn, hook_registration::AUTHORIZER_ENTRY)
        .expect("reserve");
    without_sqlite_memory(|| conn.authorizer(Some(count_authorizer))).expect("replaces the entry");
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .expect("clear");

    let mut conn = Connection::open_in_memory().expect("open");
    hook_registration::reserve_entry(&mut conn, hook_registration::PROGRESS_HANDLER_ENTRY)
        .expect("reserve");
    without_sqlite_memory(|| conn.progress_handler(1, Some(count_progress)))
        .expect("replaces the entry");
    conn.progress_handler(0, None::<fn() -> bool>)
        .expect("clear");
}

fn a_disabled_progress_handler_keeps_its_entry_and_does_not_fire() {
    let mut conn = Connection::open_in_memory().expect("open");
    reset_counters();
    hook_registration::set_progress_handler(&mut conn, 1, Some(count_progress)).expect("enable");
    conn.execute_batch("CREATE TABLE t(x)").expect("run");
    let enabled_calls = PROGRESS_CALLS.load(Ordering::SeqCst);
    assert!(enabled_calls > 0);

    hook_registration::set_progress_handler(&mut conn, 0, None::<fn() -> bool>).expect("disable");
    assert!(
        hook_registration::entry_exists(&conn, hook_registration::PROGRESS_HANDLER_ENTRY).unwrap()
    );
    conn.execute_batch("INSERT INTO t VALUES (1)").expect("run");
    assert_eq!(
        PROGRESS_CALLS.load(Ordering::SeqCst),
        enabled_calls,
        "disabled"
    );

    // A handler registered by raw FFI (no clientdata entry, like the opt-in
    // diagnostics' meter installed at open) is cleared by a disable as well.
    let mut raw = Connection::open_in_memory().expect("open");
    reset_counters();
    unsafe extern "C" fn raw_progress(_: *mut std::ffi::c_void) -> std::ffi::c_int {
        PROGRESS_CALLS.fetch_add(1, Ordering::SeqCst);
        0
    }
    // SAFETY: a live connection and a callback that ignores its argument.
    unsafe {
        ffi::sqlite3_progress_handler(raw.handle(), 1, Some(raw_progress), std::ptr::null_mut())
    };
    raw.execute_batch("CREATE TABLE t(x)").expect("run");
    let raw_calls = PROGRESS_CALLS.load(Ordering::SeqCst);
    assert!(raw_calls > 0);
    assert!(
        !hook_registration::entry_exists(&raw, hook_registration::PROGRESS_HANDLER_ENTRY).unwrap()
    );
    hook_registration::set_progress_handler(&mut raw, 0, None::<fn() -> bool>).expect("disable");
    raw.execute_batch("INSERT INTO t VALUES (1)").expect("run");
    assert_eq!(
        PROGRESS_CALLS.load(Ordering::SeqCst),
        raw_calls,
        "the raw handler is cleared"
    );

    // Enabling it again needs no memory (the nested progress owners restore the
    // outer handler after a cleanup that disabled it).
    without_sqlite_memory(|| {
        hook_registration::set_progress_handler(&mut conn, 1, Some(count_progress))
    })
    .expect("re-enable without allocating");
    conn.execute_batch("INSERT INTO t VALUES (2)").expect("run");
    assert!(PROGRESS_CALLS.load(Ordering::SeqCst) > enabled_calls);
}
