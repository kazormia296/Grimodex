//! The only place that registers an SQLite hook (authorizer, progress handler,
//! commit hook) on a connection in production code (DR-DBC-4, P3-1).
//!
//! rusqlite 0.41 registers a hook in two steps (`InnerConnection::set_clientdata`,
//! rusqlite-0.41.1/src/inner_connection.rs): first the `preset` closure hands
//! SQLite the raw pointer of the boxed closure (`sqlite3_commit_hook(db, x, ptr)`),
//! then `sqlite3_set_clientdata(db, name, ptr, destructor)` records the box under
//! the hook's name so that it is freed when the hook is replaced or the
//! connection closes. `sqlite3_set_clientdata` allocates (`sqlite3_malloc64`)
//! only when **no entry of that name exists yet**; if that allocation fails it
//! calls the destructor on the closure and returns `SQLITE_NOMEM`. By then
//! SQLite already holds the pointer: the hook is left registered, pointing at a
//! freed closure, and the next statement that fires the hook calls it
//! (use after free). Replacing an existing entry, and removing one, never
//! allocate.
//!
//! So a failed *first* registration of a kind is the dangerous one. This module
//! closes it by construction:
//!
//! * `reserve_entry` creates the entry first, with a placeholder value and a
//!   no-op `preset` (`Connection::set_clientdata`), so a failing allocation
//!   leaves SQLite's hook untouched. The registration that follows only ever
//!   replaces an existing entry, which cannot fail for lack of memory.
//! * If the registration still returns an error, the hook of that kind is
//!   cleared (`None` never allocates) before the error is returned: after an
//!   `Err` from this module no hook of that kind is registered.
//! * The progress handler is never removed with `None`: it is "disabled" with
//!   interval 0 and a no-op closure, which keeps the entry. The nested
//!   progress owners (`nir1_capacity`) disable it for rollback cleanup and
//!   re-enable it afterwards, so re-enabling must not need an allocation.
//!
//! The entry names are rusqlite 0.41's own (`sqlite3_set_authorizer`,
//! `sqlite3_commit_hook`, `sqlite3_progress_handler`). If they ever changed,
//! `reserve_entry` would only reserve a name nothing reads and the
//! "clear on error" step would still keep the hook from dangling; the
//! integration test `hook_registration_nomem` pins both.
//!
//! This file depends on `rusqlite` only, so that test includes it by path.

use rusqlite::hooks::{AuthContext, Authorization};
use rusqlite::Connection;
use std::ffi::CStr;

/// rusqlite 0.41's clientdata names (hooks/mod.rs).
pub(crate) const AUTHORIZER_ENTRY: &CStr = c"sqlite3_set_authorizer";
pub(crate) const COMMIT_HOOK_ENTRY: &CStr = c"sqlite3_commit_hook";
pub(crate) const PROGRESS_HANDLER_ENTRY: &CStr = c"sqlite3_progress_handler";

/// What `reserve_entry` stores: a value of no size, so the placeholder owns no
/// memory and its destructor is a no-op.
struct ReservedHookEntry;

/// True when SQLite holds a clientdata entry of this name on `conn`.
pub(crate) fn entry_exists(conn: &Connection, name: &'static CStr) -> rusqlite::Result<bool> {
    // SAFETY: the stored pointer is only tested for null, through a reference to
    // `()` (a type of no size, valid for any non-null, aligned pointer). It is
    // never read as another type.
    Ok(unsafe { conn.get_clientdata::<(), _>(name) }?.is_some())
}

/// Make sure the entry of `name` exists, so the registration that follows
/// cannot fail in `sqlite3_set_clientdata`. Registers no hook itself.
pub(crate) fn reserve_entry(conn: &mut Connection, name: &'static CStr) -> rusqlite::Result<()> {
    if entry_exists(conn, name)? {
        return Ok(());
    }
    // SAFETY: `Connection::set_clientdata` runs a `preset` that does nothing, so
    // no hook is registered, and stores a value of no size. A failed allocation
    // frees only that value. The name is not read as another type by anyone
    // but the hook that is registered next (which replaces the entry).
    unsafe { conn.set_clientdata(name, Some(ReservedHookEntry)) }?;
    Ok(())
}

/// Register (`Some`) or clear (`None`) the authorizer. After an `Err` no
/// authorizer is registered.
pub(crate) fn set_authorizer<F>(
    conn: &mut Connection,
    authorizer: Option<F>,
) -> rusqlite::Result<()>
where
    F: for<'r> FnMut(AuthContext<'r>) -> Authorization + Send + 'static,
{
    if authorizer.is_none() {
        return conn.authorizer(authorizer);
    }
    reserve_entry(conn, AUTHORIZER_ENTRY)?;
    let registered = conn.authorizer(authorizer);
    if registered.is_err() {
        let _ = conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    }
    registered
}

/// Register (`Some`) or clear (`None`) the commit hook. After an `Err` no
/// commit hook is registered.
pub(crate) fn set_commit_hook<F>(conn: &mut Connection, hook: Option<F>) -> rusqlite::Result<()>
where
    F: FnMut() -> bool + Send + 'static,
{
    if hook.is_none() {
        return conn.commit_hook(hook);
    }
    reserve_entry(conn, COMMIT_HOOK_ENTRY)?;
    let registered = conn.commit_hook(hook);
    if registered.is_err() {
        let _ = conn.commit_hook(None::<fn() -> bool>);
    }
    registered
}

/// Register (`Some` with a positive `interval`) or disable the progress
/// handler. Disabling keeps the entry (interval 0 and a no-op closure), so
/// enabling it again never allocates. After an `Err` no progress handler is
/// enabled.
pub(crate) fn set_progress_handler<F>(
    conn: &mut Connection,
    interval: i32,
    handler: Option<F>,
) -> rusqlite::Result<()>
where
    F: FnMut() -> bool + Send + 'static,
{
    let Some(handler) = handler.filter(|_| interval > 0) else {
        return disable_progress_handler(conn);
    };
    reserve_entry(conn, PROGRESS_HANDLER_ENTRY)?;
    let registered = conn.progress_handler(interval, Some(handler));
    if registered.is_err() {
        let _ = disable_progress_handler(conn);
    }
    registered
}

fn disable_progress_handler(conn: &mut Connection) -> rusqlite::Result<()> {
    if entry_exists(conn, PROGRESS_HANDLER_ENTRY)? {
        // `sqlite3_progress_handler` with interval 0 clears the callback; the
        // no-op closure replaces the entry's value without allocating.
        conn.progress_handler(0, Some(|| false))
    } else {
        // No entry: this module (or rusqlite) never registered a handler.
        Ok(())
    }
}
