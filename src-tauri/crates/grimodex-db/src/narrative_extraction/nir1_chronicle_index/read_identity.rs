//! Reuse a full proof check only for the same committed connection state.
//! This is private to an existing runtime proof, never a durable capability.
use anyhow::{ensure, Result};
use rusqlite::{Connection, TransactionState};

use crate::{read_sqlite_source_revision, SqliteSourceRevision};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ReadIdentity {
    source: SqliteSourceRevision,
    main_schema: i64,
    temp_schema: i64,
    user_version: i64,
}

impl ReadIdentity {
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
