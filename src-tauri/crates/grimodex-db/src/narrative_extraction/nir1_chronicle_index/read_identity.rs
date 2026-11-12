//! Reuse a full proof check only for the same committed connection state.
//! This is private to an existing runtime proof, never a durable capability.
use std::sync::Mutex;

use anyhow::{ensure, Result};
use rusqlite::{Connection, TransactionState};

use crate::write_clock::{read_db_clock_with_versions, DbClock};

/// The committed database state as the in-database write clock names it
/// (DR-DBC-5): lineage, main `schema_version`, `user_version` and the global
/// sequence. Every connection and process reads the same value for the same
/// state; nothing here is connection-local.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReadIdentity {
    clock: DbClock,
    main_schema: i64,
    user_version: i64,
}

impl ReadIdentity {
    /// Observe committed state outside a transaction. One statement reads one
    /// snapshot, so the four components always belong to a single state (the
    /// former before/after pair of pragma reads is no longer needed). `None`
    /// only when the state cannot be named (today never: it always returns
    /// `Some`); an unreadable clock is an `Err`, never a silent `None`.
    pub(crate) fn read_unpinned(conn: &Connection) -> Result<Option<Self>> {
        ensure!(
            conn.is_autocommit(),
            "NIR1 unpinned identity requires autocommit"
        );
        let (clock, main_schema, user_version) = read_db_clock_with_versions(conn)?;
        Ok(Some(Self {
            clock,
            main_schema,
            user_version,
        }))
    }

    /// The same state as `self` under another lineage (a replaced database).
    #[cfg(test)]
    pub(crate) fn with_lineage_for_test(&self, lineage: &str) -> Self {
        let mut other = self.clone();
        other.clock.lineage = lineage.to_owned();
        other
    }

    pub fn read(conn: &Connection) -> Result<Option<Self>> {
        ensure!(
            !conn.is_autocommit(),
            "NIR1 proof identity requires a transaction"
        );
        let (clock, main_schema, user_version) = read_db_clock_with_versions(conn)?;
        // A rolled-back write reuses its sequence values. Never retain or
        // reuse a verdict observed in a write transaction, including after a
        // savepoint rollback. SQLite keeps TXN_WRITE until the outer
        // COMMIT/ROLLBACK.
        if conn.transaction_state(None::<&str>)? != TransactionState::Read {
            return Ok(None);
        }
        Ok(Some(Self {
            clock,
            main_schema,
            user_version,
        }))
    }
}

impl ReadIdentity {
    /// DR-CP4-V-6: the connection state inside the generic AI-audit append's
    /// `BEGIN IMMEDIATE` transaction, read while this connection holds the
    /// write lock (no other connection can commit in between). `None` outside
    /// a Write transaction or when the state cannot be read; a caller then
    /// records nothing.
    pub(crate) fn read_in_audit_append(conn: &Connection) -> Option<Self> {
        if conn.transaction_state(None::<&str>).ok()? != TransactionState::Write {
            return None;
        }
        let (clock, main_schema, user_version) = read_db_clock_with_versions(conn).ok()?;
        Some(Self {
            clock,
            main_schema,
            user_version,
        })
    }
}

/// DR-CP4-V-6: per database (the main file's path and the lineage the states
/// carry), the committed states joined only by generic AI-audit appends,
/// oldest first. Process memory only (never durable). Any other write moves the
/// identity away from the list's last state, so the next append starts a new
/// list and a reader never inherits across that write. The path keeps a
/// duplicated workspace folder (same lineage, another file) from reading this
/// list; the lineage keeps a restored or migrated file from reading the old
/// one (DR-DBC-5). A file put back from an old copy under the same path keeps
/// its lineage and can reach the same sequence values again, so opening a
/// workspace authority drops every list of that path
/// (`forget_audit_only_states`). Most recently used databases last; dropping a
/// list only costs a complete check.
static AUDIT_ONLY_STATES: Mutex<AuditOnlyStates> = Mutex::new(AuditOnlyStates::new(
    AUDIT_ONLY_CONNECTIONS,
    AUDIT_ONLY_STATES_PER_CONNECTION,
));
/// Parallel test binaries open hundreds of databases; keep enough of them.
const AUDIT_ONLY_CONNECTIONS: usize = 256;
const AUDIT_ONLY_STATES_PER_CONNECTION: usize = 16;

/// The main database file of `conn` (empty for an in-memory database).
fn audit_only_path(conn: &Connection) -> String {
    conn.path().unwrap_or("").to_owned()
}

/// The process registry's lists, with their bounds (a value, so the bounds can
/// be tested without the shared registry).
pub(super) struct AuditOnlyStates {
    /// (file path, states). Every state of a list carries the same lineage.
    connections: Vec<(String, Vec<ReadIdentity>)>,
    max_connections: usize,
    max_states: usize,
}

impl AuditOnlyStates {
    pub(super) const fn new(max_connections: usize, max_states: usize) -> Self {
        Self {
            connections: Vec::new(),
            max_connections,
            max_states,
        }
    }

    pub(super) fn record(&mut self, path: &str, before: ReadIdentity, after: ReadIdentity) {
        if before.clock.lineage != after.clock.lineage {
            return;
        }
        let mut states = self
            .connections
            .iter()
            .position(|(known, states)| {
                known == path
                    && states
                        .first()
                        .is_some_and(|first| first.clock.lineage == after.clock.lineage)
            })
            .map(|index| self.connections.remove(index).1)
            .unwrap_or_default();
        if states.last() != Some(&before) {
            states.clear();
            states.push(before);
        }
        if states.last() != Some(&after) {
            states.push(after);
        }
        if states.len() > self.max_states {
            states.drain(..states.len() - self.max_states);
        }
        self.connections.push((path.to_owned(), states));
        if self.connections.len() > self.max_connections {
            self.connections.remove(0);
        }
    }

    /// Drop every list of the file at `path` (whatever its lineage).
    pub(super) fn forget(&mut self, path: &str) {
        self.connections.retain(|(known, _)| known != path);
    }

    pub(super) fn joined(
        &self,
        path: &str,
        validated: &ReadIdentity,
        current: &ReadIdentity,
    ) -> bool {
        self.connections.iter().any(|(known, states)| {
            known == path
                && states.last() == Some(current)
                && states.iter().any(|state| state == validated)
        })
    }
}

/// Record one committed generic AI-audit append whose `before` and `after`
/// states were both read inside its IMMEDIATE transaction.
pub(crate) fn record_audit_only_commit(
    conn: &Connection,
    before: ReadIdentity,
    after: ReadIdentity,
) {
    let path = audit_only_path(conn);
    if let Ok(mut states) = AUDIT_ONLY_STATES.lock() {
        states.record(&path, before, after);
    }
}

/// Drop the lists of the database file of `conn`. A workspace authority calls
/// this when it opens: the file may have been replaced by an older copy of the
/// same database since the lists were recorded (a manual backup promotion
/// while the process kept running), and such a copy has the same path and
/// lineage and can reach the same sequence values with other content (P2-1 of
/// the DR-DBC-5 review). The lists are process memory, so this only costs a
/// complete check.
pub(crate) fn forget_audit_only_states(conn: &Connection) {
    let path = audit_only_path(conn);
    if let Ok(mut states) = AUDIT_ONLY_STATES.lock() {
        states.forget(&path);
    }
}

/// Whether only generic AI-audit appends of this database lie between
/// `validated` and `current`: `validated` is in the database's list and
/// `current` is its last state.
pub(crate) fn joined_by_audit_only_commits(
    conn: &Connection,
    validated: &ReadIdentity,
    current: &ReadIdentity,
) -> bool {
    let path = audit_only_path(conn);
    AUDIT_ONLY_STATES
        .lock()
        .is_ok_and(|states| states.joined(&path, validated, current))
}

/// A synthetic state of database `lineage` after `seq` commits.
#[cfg(test)]
pub(super) fn state_for_test(lineage: &str, seq: i64) -> ReadIdentity {
    ReadIdentity {
        clock: DbClock {
            lineage: lineage.to_owned(),
            seq,
        },
        main_schema: 1,
        user_version: 1,
    }
}
