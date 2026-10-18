//! Table-presence checks that cost no SQLite VM steps inside the Graph
//! C-query's pinned read snapshot.
//!
//! `SELECT ... FROM sqlite_master WHERE name = ?` has no index to use, so every
//! presence check walks all schema rows (thousands of VM steps in a migrated
//! workspace database). The C-query repeats it 13 times per Revision (Scene
//! Scope, declaration set, Scope authority and C2-ZC marker reads), and those
//! steps are charged to its 600,000-step budget although they validate nothing
//! about the Revision.
//!
//! Inside a read transaction in which an ordinary statement that reads a table
//! has run, SQLite has already compared the schema cookie of the pinned
//! snapshot with the connection's schema cache and reloaded the cache when they
//! differed. From then on the cache is the snapshot's schema and cannot change
//! until the transaction ends, so `sqlite3_table_column_metadata` answers the
//! same question from memory without running a statement. (A header PRAGMA such
//! as `schema_version` pins the snapshot but does not make that comparison.)
//! Only values that cannot change inside that one snapshot are shared; no
//! Revision-wide check is skipped or narrowed.
//!
//! Only the C-query opens a [`with_pinned_snapshot`] scope, after its pinned
//! identity and seal reads. Every other caller keeps its SQL check, because some of them
//! observe cancellation through the steps that check consumes (the Chronicle
//! index publication stops at its 1,000-step progress callback), so a global
//! shortcut would change when they stop.
//!
//! A scope does not rely on the transaction it was opened in staying the one
//! that runs. It records the connection and the pager's data version
//! (`SQLITE_FCNTL_DATA_VERSION`: it moves when the database file changes,
//! through this connection or another one, and another connection's commit is
//! noticed when a read transaction starts) and answers only while the
//! connection holds a read snapshot at that data version. If the transaction
//! ends inside the scope and another begins, the new one holds no snapshot until
//! its first statement has run, and a header PRAGMA that pins a snapshot of a
//! changed file shows another data version, so both go back to SQL; at an
//! unchanged data version the file is the one the scope verified, so the cache
//! still describes it. A scope opened where the connection holds no read
//! snapshot is inert.

use rusqlite::{Connection, TransactionState};
use std::cell::Cell;
use std::ffi::c_uint;

/// What a scope verified: the connection, and the data version of the snapshot
/// whose schema the connection's cache describes.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Pin {
    connection: usize,
    data_version: c_uint,
}

thread_local! {
    /// The snapshot this thread's innermost scope verified, `None` when it is
    /// not inside a scope or the scope found no read snapshot to verify.
    static PINNED: Cell<Option<Pin>> = const { Cell::new(None) };
    /// Test-only: answer every presence check with the callers' SQL, the
    /// behavior before the shortcut, to compare responses and steps with it.
    #[cfg(test)]
    static SQL_ONLY: Cell<bool> = const { Cell::new(false) };
}

fn identity(conn: &Connection) -> usize {
    std::ptr::from_ref(conn).addr()
}

/// The pager's data version of the main database, read without running a
/// statement. It changes whenever the database file does, through this
/// connection or another one, and it cannot move inside one read transaction.
fn data_version(conn: &Connection) -> Option<c_uint> {
    let mut version: c_uint = 0;
    // SAFETY: `conn` is borrowed, so its handle is live. "main" is
    // NUL-terminated, and `SQLITE_FCNTL_DATA_VERSION` writes one `unsigned int`
    // through the pointer and nothing else.
    let code = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            conn.handle(),
            c"main".as_ptr(),
            rusqlite::ffi::SQLITE_FCNTL_DATA_VERSION,
            std::ptr::from_mut(&mut version).cast(),
        )
    };
    (code == rusqlite::ffi::SQLITE_OK).then_some(version)
}

/// The snapshot `conn` holds now, or `None` when it holds no read snapshot:
/// outside an explicit transaction, in a transaction that has not run a
/// statement yet (`BEGIN DEFERRED` alone pins nothing), or in a write
/// transaction. Nothing here runs a statement.
fn current_pin(conn: &Connection) -> Option<Pin> {
    if conn.is_autocommit() {
        return None;
    }
    if conn.transaction_state(Some("main")).ok()? != TransactionState::Read {
        return None;
    }
    Some(Pin {
        connection: identity(conn),
        data_version: data_version(conn)?,
    })
}

#[cfg(test)]
fn sql_only() -> bool {
    SQL_ONLY.get()
}

#[cfg(not(test))]
const fn sql_only() -> bool {
    false
}

/// Run `operation` inside the pinned read snapshot `conn` holds now: presence
/// checks on `conn` made by this thread while it runs are answered from the
/// schema cache for as long as `conn` holds a read snapshot at the data version
/// the scope verified. The scope is the dynamic extent of the call, so scopes
/// nest and always end, also when `operation` unwinds.
///
/// The caller must already have run an ordinary statement that reads a table
/// on `conn` inside that transaction (the C-query's seal read): until then
/// SQLite has not compared the snapshot's schema cookie with the connection's
/// schema cache. Where `conn` holds no read snapshot the scope is inert, and it
/// hides the enclosing scope's snapshot too, which `conn` no longer holds.
pub(crate) fn with_pinned_snapshot<T>(conn: &Connection, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<Pin>);
    impl Drop for Restore {
        fn drop(&mut self) {
            PINNED.set(self.0);
        }
    }
    let _restore = Restore(PINNED.get());
    PINNED.set(current_pin(conn));
    operation()
}

/// Whether `table` is a table of the main schema, as
/// `SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)`
/// answers it, or `None` when the caller must run its SQL check instead:
/// outside a pinned snapshot, on another connection, when `conn` no longer holds
/// a read snapshot at the data version the scope verified, and for the names
/// whose answers differ (`sqlite_*` schema tables, which `sqlite_master` does
/// not list, and names the SQL check could not bind). Views are not tables, and
/// virtual and shadow tables are. SQLite resolves the name without regard to
/// case; callers pass the lowercase spelling their DDL creates.
pub(crate) fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<Option<bool>> {
    let bytes = table.as_bytes();
    let plain_name = !bytes
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"sqlite_"))
        && !bytes.contains(&0);
    if sql_only() || !plain_name {
        return Ok(None);
    }
    match PINNED.get() {
        Some(pinned) if current_pin(conn) == Some(pinned) => {
            conn.table_exists(Some("main"), table).map(Some)
        }
        _ => Ok(None),
    }
}

/// Run `operation` with every presence check answered by the callers' SQL.
#[cfg(test)]
pub(crate) fn with_sql_checks<T>(operation: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            SQL_ONLY.set(self.0);
        }
    }
    let _restore = Restore(SQL_ONLY.replace(true));
    operation()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    const SQL_CHECK: &str =
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)";

    /// A schema with a few dozen entries so a `sqlite_master` walk is visible.
    fn schema_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let mut ddl = String::from(
            "CREATE TABLE present_table(id INTEGER PRIMARY KEY, value TEXT);
             CREATE VIEW present_view AS SELECT id FROM present_table;
             CREATE VIRTUAL TABLE present_search USING fts5(body);",
        );
        for index in 0..40 {
            ddl.push_str(&format!(
                "CREATE TABLE padding_{index}(id INTEGER PRIMARY KEY, value TEXT);
                 CREATE INDEX padding_{index}_value ON padding_{index}(value);"
            ));
        }
        conn.execute_batch(&ddl).unwrap();
        conn
    }

    /// Run an ordinary table-reading statement, as the C-query's seal read does
    /// before it opens the scope.
    fn read_a_table(conn: &Connection) {
        conn.query_row("SELECT count(*) FROM present_table", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    }

    /// Start a transaction and run its first ordinary statement.
    fn pin_transaction(conn: &Connection) {
        conn.execute_batch("BEGIN DEFERRED").unwrap();
        read_a_table(conn);
    }

    fn sql_answer(conn: &Connection, table: &str) -> bool {
        conn.query_row(SQL_CHECK, [table], |row| row.get(0))
            .unwrap()
    }

    /// VM steps `operation` spends on `conn`, counted per instruction like the
    /// Graph budget.
    fn steps_of<T>(conn: &Connection, operation: impl FnOnce() -> T) -> (T, u64) {
        let steps = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&steps);
        crate::set_sqlite_progress_handler(
            conn,
            1,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        let value = operation();
        crate::set_sqlite_progress_handler(conn, 0, None::<fn() -> bool>).unwrap();
        (value, steps.load(Ordering::Relaxed))
    }

    #[test]
    fn a_transaction_alone_does_not_shortcut_the_callers_sql() {
        let conn = schema_connection();
        assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
        pin_transaction(&conn);
        assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
    }

    #[test]
    fn pinned_snapshot_answers_like_sqlite_master_without_vm_steps() {
        let conn = schema_connection();
        pin_transaction(&conn);
        // EXISTS stops at the first match, so a missing name shows the walk.
        let (_, sql_steps) = steps_of(&conn, || sql_answer(&conn, "missing_table"));
        assert!(
            sql_steps > 100,
            "the SQL check walks the schema: {sql_steps}"
        );
        with_pinned_snapshot(&conn, || {
            for (table, expected) in [
                ("present_table", true),
                ("padding_17", true),
                // Virtual tables and their shadow tables are listed as tables.
                ("present_search", true),
                ("present_search_data", true),
                ("present_view", false),
                ("present_table_value", false),
                ("missing_table", false),
                ("", false),
            ] {
                assert_eq!(sql_answer(&conn, table), expected, "{table}");
                let (answer, steps) = steps_of(&conn, || table_exists(&conn, table));
                assert_eq!(answer.unwrap(), Some(expected), "{table}");
                assert_eq!(steps, 0, "{table} must not run a statement");
            }
        });
    }

    #[test]
    fn names_whose_answers_differ_stay_with_the_callers_sql() {
        let conn = schema_connection();
        pin_transaction(&conn);
        with_pinned_snapshot(&conn, || {
            // sqlite_master does not list itself, but the schema cache resolves it.
            for table in [
                "sqlite_master",
                "sqlite_schema",
                "SQLITE_MASTER",
                "sqlite_temp_master",
                "sqlite_sequence",
                "nul\0name",
            ] {
                assert_eq!(table_exists(&conn, table).unwrap(), None, "{table:?}");
            }
            // Not a prefix of `sqlite_` and not a char-boundary hazard.
            assert_eq!(table_exists(&conn, "sqlit").unwrap(), Some(false));
            assert_eq!(
                table_exists(&conn, "日本語のテーブル").unwrap(),
                Some(false)
            );
        });
    }

    #[test]
    fn the_scope_is_bound_to_the_connection_and_the_snapshot_it_verified() {
        let conn = schema_connection();
        let other = schema_connection();
        pin_transaction(&conn);
        pin_transaction(&other);
        with_pinned_snapshot(&conn, || {
            assert_eq!(table_exists(&conn, "present_table").unwrap(), Some(true));
            // Another connection on the same thread is not covered.
            assert_eq!(table_exists(&other, "present_table").unwrap(), None);
            // The transaction ended inside the scope: back to SQL. The next one
            // holds no snapshot before its first statement.
            conn.execute_batch("ROLLBACK").unwrap();
            assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
            conn.execute_batch("BEGIN DEFERRED").unwrap();
            assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
            // Once it has read, the file is the one the scope verified (nothing
            // wrote to it), so the cache is the snapshot's schema.
            read_a_table(&conn);
            assert_eq!(table_exists(&conn, "present_table").unwrap(), Some(true));
        });

        // A scope opened outside a transaction stays inert, also once one starts.
        conn.execute_batch("ROLLBACK").unwrap();
        with_pinned_snapshot(&conn, || {
            pin_transaction(&conn);
            assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
        });
    }

    #[test]
    fn a_scope_opened_without_a_snapshot_hides_the_enclosing_scope() {
        let conn = schema_connection();
        pin_transaction(&conn);
        with_pinned_snapshot(&conn, || {
            assert_eq!(table_exists(&conn, "present_table").unwrap(), Some(true));
            // The enclosing scope's transaction ends. The inner scope finds no
            // snapshot to verify, so a transaction begun inside it is not
            // answered from the cache the enclosing scope verified.
            conn.execute_batch("ROLLBACK").unwrap();
            with_pinned_snapshot(&conn, || {
                pin_transaction(&conn);
                assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
            });
        });
    }

    #[test]
    fn a_write_transaction_is_not_a_pinned_read() {
        let conn = schema_connection();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        read_a_table(&conn);
        with_pinned_snapshot(&conn, || {
            assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
        });
    }

    #[test]
    fn scopes_nest_and_end_even_when_unwinding() {
        let conn = schema_connection();
        let other = schema_connection();
        pin_transaction(&conn);
        pin_transaction(&other);
        with_pinned_snapshot(&conn, || {
            with_pinned_snapshot(&other, || {
                assert_eq!(table_exists(&other, "present_table").unwrap(), Some(true));
                assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
            });
            assert_eq!(table_exists(&conn, "present_table").unwrap(), Some(true));
            assert_eq!(table_exists(&other, "present_table").unwrap(), None);
        });
        assert_eq!(table_exists(&conn, "present_table").unwrap(), None);

        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_pinned_snapshot(&conn, || {
                assert_eq!(table_exists(&conn, "present_table").unwrap(), Some(true));
                std::panic::resume_unwind(Box::new("unwind through the scope"));
            })
        }));
        assert!(unwound.is_err());
        assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
    }

    #[test]
    fn the_test_switch_restores_the_sql_checks_inside_a_scope() {
        let conn = schema_connection();
        pin_transaction(&conn);
        with_pinned_snapshot(&conn, || {
            assert_eq!(table_exists(&conn, "present_table").unwrap(), Some(true));
            with_sql_checks(|| {
                assert_eq!(table_exists(&conn, "present_table").unwrap(), None);
            });
            assert_eq!(table_exists(&conn, "present_table").unwrap(), Some(true));
        });
    }

    struct TempDatabase(std::path::PathBuf);
    impl TempDatabase {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("nir1-pinned-{}.db", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for TempDatabase {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
            }
        }
    }

    /// A WAL database with one table, a connection that has loaded its schema
    /// cache, and a writer.
    fn reader_and_writer(database: &TempDatabase) -> (Connection, Connection) {
        let writer = Connection::open(&database.0).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE present_table(id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        let reader = Connection::open(&database.0).unwrap();
        // Load the reader's schema cache while `late_table` does not exist.
        assert!(!sql_answer(&reader, "late_table"));
        (reader, writer)
    }

    // Why the scope asks for an ordinary table-reading statement first.
    #[test]
    fn only_an_ordinary_statement_refreshes_a_stale_schema_cache() {
        let database = TempDatabase::new();
        let (reader, writer) = reader_and_writer(&database);
        writer
            .execute_batch("CREATE TABLE late_table(id INTEGER PRIMARY KEY);")
            .unwrap();

        reader.execute_batch("BEGIN DEFERRED").unwrap();
        // A header pragma pins the snapshot without comparing the schema cookie
        // with the cache: the cache still describes the older schema.
        reader
            .pragma_query_value(Some("main"), "schema_version", |row| row.get::<_, i64>(0))
            .unwrap();
        with_pinned_snapshot(&reader, || {
            assert_eq!(table_exists(&reader, "late_table").unwrap(), Some(false));
            // The first ordinary statement reloads the cache for the snapshot.
            read_a_table(&reader);
            assert_eq!(table_exists(&reader, "late_table").unwrap(), Some(true));
        });
    }

    // The shortcut reads the connection's schema cache, so it is only as good
    // as the cache. These are the schema changes a pinned C-query can meet.
    #[test]
    fn the_schema_cache_is_the_pinned_snapshots_schema() {
        let database = TempDatabase::new();
        let (reader, writer) = reader_and_writer(&database);

        // Changed after the cache was loaded, before the transaction pins its
        // snapshot: the first statement of the transaction refreshes the cache.
        writer
            .execute_batch("CREATE TABLE late_table(id INTEGER PRIMARY KEY);")
            .unwrap();
        pin_transaction(&reader);
        with_pinned_snapshot(&reader, || {
            assert_eq!(table_exists(&reader, "late_table").unwrap(), Some(true));
            assert_eq!(table_exists(&reader, "later_table").unwrap(), Some(false));

            // Changed after the snapshot was pinned: both the cache and the
            // pinned `sqlite_master` still describe the snapshot.
            writer
                .execute_batch(
                    "DROP TABLE late_table; CREATE TABLE later_table(id INTEGER PRIMARY KEY);",
                )
                .unwrap();
            for table in ["late_table", "later_table", "present_table"] {
                let sql = sql_answer(&reader, table);
                assert_eq!(table_exists(&reader, table).unwrap(), Some(sql), "{table}");
            }
            assert_eq!(table_exists(&reader, "late_table").unwrap(), Some(true));
            assert_eq!(table_exists(&reader, "later_table").unwrap(), Some(false));
        });
        reader.execute_batch("ROLLBACK").unwrap();
        assert!(!sql_answer(&reader, "late_table"));
        assert!(sql_answer(&reader, "later_table"));
    }

    // The data version the scope's binding rests on, observed on a real file.
    #[test]
    fn the_data_version_follows_the_file_and_not_the_transaction() {
        let database = TempDatabase::new();
        let (reader, writer) = reader_and_writer(&database);
        pin_transaction(&reader);
        let verified = data_version(&reader).unwrap();
        assert_eq!(current_pin(&reader).unwrap().data_version, verified);

        // A commit by another connection does not reach a snapshot that is
        // held, and a new transaction notices it when it reads, not at BEGIN.
        writer
            .execute_batch("CREATE TABLE late_table(id INTEGER PRIMARY KEY);")
            .unwrap();
        assert_eq!(data_version(&reader), Some(verified));
        reader.execute_batch("ROLLBACK; BEGIN DEFERRED").unwrap();
        assert_eq!(data_version(&reader), Some(verified));
        assert!(current_pin(&reader).is_none(), "BEGIN holds no snapshot");
        read_a_table(&reader);
        let changed = data_version(&reader).unwrap();
        assert_ne!(changed, verified);
        assert_eq!(current_pin(&reader).unwrap().data_version, changed);

        // This connection's own commit moves it too.
        reader.execute_batch("ROLLBACK").unwrap();
        reader
            .execute_batch("CREATE TABLE own_table(id INTEGER PRIMARY KEY);")
            .unwrap();
        assert_ne!(data_version(&reader), Some(changed));
    }

    // A transaction that ends and one that begins inside a scope must not be
    // answered from the cache the first one verified: another connection may
    // have changed the schema in between.
    #[test]
    fn a_later_snapshot_of_a_changed_file_is_not_answered_from_the_old_cache() {
        let database = TempDatabase::new();
        let (reader, writer) = reader_and_writer(&database);
        pin_transaction(&reader);
        with_pinned_snapshot(&reader, || {
            assert_eq!(table_exists(&reader, "late_table").unwrap(), Some(false));
            reader.execute_batch("ROLLBACK").unwrap();
            writer
                .execute_batch("CREATE TABLE late_table(id INTEGER PRIMARY KEY);")
                .unwrap();

            // BEGIN pins nothing: the cache is still the old snapshot's, and
            // the SQL check would answer true.
            reader.execute_batch("BEGIN DEFERRED").unwrap();
            assert_eq!(table_exists(&reader, "late_table").unwrap(), None);
            // A header pragma pins the new snapshot but leaves the cache as it
            // was; the file's data version already differs.
            reader
                .pragma_query_value(Some("main"), "schema_version", |row| row.get::<_, i64>(0))
                .unwrap();
            assert_eq!(table_exists(&reader, "late_table").unwrap(), None);
            // An ordinary statement refreshes the cache, but the scope answers
            // for the snapshot it verified only.
            read_a_table(&reader);
            assert_eq!(table_exists(&reader, "late_table").unwrap(), None);
            assert!(sql_answer(&reader, "late_table"));
        });
    }
}
