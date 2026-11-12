//! Private test fixtures. Migration, file, repair, and connection-counter tests
//! keep their real initialization path; current-schema behavior tests use a copy.

use crate::Database;
use std::path::Path;

#[path = "../test-support/current_schema.rs"]
mod current_schema;

pub(crate) use current_schema::current_schema_memory;

/// A second, non-owning `Connection` over the same SQLite handle as `conn`
/// (DR-DBC-4). A few tests check what a write that lands *inside* a read, on
/// the same connection, does to the shared read caches; the reader now holds
/// `&mut Connection`, so such a write cannot go through the reader's own
/// reference. This hands the injector its own Rust object over the one handle:
/// no Rust reference aliases, and SQLite itself serializes same-thread use of a
/// handle. Test-only; production code never builds a second wrapper.
pub(crate) fn same_handle_writer(conn: &rusqlite::Connection) -> rusqlite::Connection {
    // SAFETY: `conn` is open and outlives the writer in every caller (the
    // writer is declared after `conn`'s guard and dropped first); `from_handle`
    // does not close the handle on drop, and the injector runs on the thread
    // that owns `conn`.
    unsafe { rusqlite::Connection::from_handle(conn.handle()) }.expect("same-handle writer")
}

fn new_memory() -> anyhow::Result<Database> {
    Database::new(Path::new(":memory:"))
}

pub(crate) fn fresh_migrated_memory() -> anyhow::Result<Database> {
    let db = new_memory()?;
    db.migrate()?;
    Ok(db)
}

#[path = "test_support_tests.rs"]
mod tests;
