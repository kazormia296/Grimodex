//! Reuse a full proof check only for the same committed connection state.
//! This is private to an existing runtime proof, never a durable capability.
use std::sync::Mutex;

use anyhow::{ensure, Result};
use rusqlite::{Connection, TransactionState};

use crate::{read_sqlite_source_revision, SqliteSourceRevision};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReadIdentity {
    source: SqliteSourceRevision,
    main_schema: i64,
    temp_schema: i64,
    user_version: i64,
}

impl ReadIdentity {
    /// Observe committed state before pinning a validation snapshot and again
    /// after releasing it. A commit during the observation makes it unusable;
    /// callers retain the original pre-validation stamp, never a later one.
    pub(crate) fn read_unpinned(conn: &Connection) -> Result<Option<Self>> {
        ensure!(
            conn.is_autocommit(),
            "NIR1 unpinned identity requires autocommit"
        );
        let before = read_sqlite_source_revision(conn)?;
        let main_schema = conn.pragma_query_value(Some("main"), "schema_version", |r| r.get(0))?;
        let temp_schema = conn.pragma_query_value(Some("temp"), "schema_version", |r| r.get(0))?;
        let user_version = conn.pragma_query_value(Some("main"), "user_version", |r| r.get(0))?;
        let source = read_sqlite_source_revision(conn)?;
        Ok((source == before).then_some(Self {
            source,
            main_schema,
            temp_schema,
            user_version,
        }))
    }

    /// The same state as `self` seen through another connection epoch.
    #[cfg(test)]
    pub(crate) fn with_connection_epoch_for_test(&self, epoch: &str) -> Self {
        let mut other = self.clone();
        other.source.connection_epoch = epoch.to_owned();
        other
    }

    pub fn read(conn: &Connection) -> Result<Option<Self>> {
        ensure!(
            !conn.is_autocommit(),
            "NIR1 proof identity requires a transaction"
        );
        // Pin the main snapshot before reading its data_version. Schema-only
        // changes need their own guard because total_changes counts row writes.
        let main_schema =
            conn.pragma_query_value(Some("main"), "schema_version", |row| row.get(0))?;
        let temp_schema =
            conn.pragma_query_value(Some("temp"), "schema_version", |row| row.get(0))?;
        let user_version =
            conn.pragma_query_value(Some("main"), "user_version", |row| row.get(0))?;
        let source = read_sqlite_source_revision(conn)?;
        // A rolled-back write retains total_changes. Never retain or reuse a
        // verdict observed in a write transaction, including after a savepoint
        // rollback. SQLite keeps TXN_WRITE until the outer COMMIT/ROLLBACK.
        if conn.transaction_state(None::<&str>)? != TransactionState::Read {
            return Ok(None);
        }
        Ok(Some(Self {
            source,
            main_schema,
            temp_schema,
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
        let main_schema = conn
            .pragma_query_value(Some("main"), "schema_version", |row| row.get(0))
            .ok()?;
        let temp_schema = conn
            .pragma_query_value(Some("temp"), "schema_version", |row| row.get(0))
            .ok()?;
        let user_version = conn
            .pragma_query_value(Some("main"), "user_version", |row| row.get(0))
            .ok()?;
        let source = read_sqlite_source_revision(conn).ok()?;
        Some(Self {
            source,
            main_schema,
            temp_schema,
            user_version,
        })
    }
}

/// DR-CP4-V-6: per connection, the committed states joined only by generic
/// AI-audit appends, oldest first. Process memory only (never durable); a new
/// connection has a new `connection_epoch` and therefore its own list. Any
/// other write moves the identity away from the list's last state, so the next
/// append starts a new list and a reader never inherits across that write.
/// Most recently used connections last; dropping a list only costs a complete
/// check.
static AUDIT_ONLY_STATES: Mutex<AuditOnlyStates> = Mutex::new(AuditOnlyStates::new(
    AUDIT_ONLY_CONNECTIONS,
    AUDIT_ONLY_STATES_PER_CONNECTION,
));
/// Parallel test binaries open hundreds of connections; keep enough of them.
const AUDIT_ONLY_CONNECTIONS: usize = 256;
const AUDIT_ONLY_STATES_PER_CONNECTION: usize = 16;

/// The process registry's lists, with their bounds (a value, so the bounds can
/// be tested without the shared registry).
pub(super) struct AuditOnlyStates {
    connections: Vec<Vec<ReadIdentity>>,
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

    pub(super) fn record(&mut self, before: ReadIdentity, after: ReadIdentity) {
        if before.source.connection_epoch != after.source.connection_epoch {
            return;
        }
        let mut states = self
            .connections
            .iter()
            .position(|states| {
                states.first().is_some_and(|first| {
                    first.source.connection_epoch == after.source.connection_epoch
                })
            })
            .map(|index| self.connections.remove(index))
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
        self.connections.push(states);
        if self.connections.len() > self.max_connections {
            self.connections.remove(0);
        }
    }

    pub(super) fn joined(&self, validated: &ReadIdentity, current: &ReadIdentity) -> bool {
        self.connections.iter().any(|states| {
            states.last() == Some(current) && states.iter().any(|state| state == validated)
        })
    }
}

/// Record one committed generic AI-audit append whose `before` and `after`
/// states were both read inside its IMMEDIATE transaction.
pub(crate) fn record_audit_only_commit(before: ReadIdentity, after: ReadIdentity) {
    if let Ok(mut states) = AUDIT_ONLY_STATES.lock() {
        states.record(before, after);
    }
}

/// Whether only generic AI-audit appends of this connection lie between
/// `validated` and `current`: `validated` is in the connection's list and
/// `current` is its last state.
pub(crate) fn joined_by_audit_only_commits(
    validated: &ReadIdentity,
    current: &ReadIdentity,
) -> bool {
    AUDIT_ONLY_STATES
        .lock()
        .is_ok_and(|states| states.joined(validated, current))
}

/// A synthetic state of connection `epoch` after `changes` row changes.
#[cfg(test)]
pub(super) fn state_for_test(epoch: &str, changes: u64) -> ReadIdentity {
    ReadIdentity {
        source: SqliteSourceRevision {
            connection_epoch: epoch.to_owned(),
            total_changes: changes,
            data_version: 1,
        },
        main_schema: 1,
        temp_schema: 1,
        user_version: 1,
    }
}
