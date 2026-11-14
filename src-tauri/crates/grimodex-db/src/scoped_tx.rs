//! BEGIN DEFERRED ... COMMIT／ROLLBACK を、`&mut Connection` を借りたまま行う guard（DR-DBC-4）。
//!
//! rusqlite 0.41 の `Transaction` は `Deref<Target = Connection>` だけで `DerefMut` を持たず、
//! その下では hook（authorizer／progress／commit）を登録できない。Graph の読みは
//! transaction の下で capacity scope（progress hook の入れ替え）と commit hook を使うので、
//! `unchecked_transaction()` の代わりにこの guard を使い、接続の排他的な借用を保つ。
//!
//! 意味は `Transaction`（既定の `DropBehavior::Rollback`）と同じ。`BEGIN DEFERRED`、`commit` は
//! `COMMIT`、drop 時に transaction が開いたままなら `ROLLBACK`（失敗は無視。`Transaction` も同様）。

use rusqlite::Connection;
use std::ops::{Deref, DerefMut};

pub struct ScopedTransaction<'conn> {
    conn: &'conn mut Connection,
}

impl<'conn> ScopedTransaction<'conn> {
    pub fn begin(conn: &'conn mut Connection) -> rusqlite::Result<Self> {
        conn.execute_batch("BEGIN DEFERRED")?;
        Ok(Self { conn })
    }

    /// `ROLLBACK` して guard を消費する。
    pub fn rollback(self) -> rusqlite::Result<()> {
        self.conn.execute_batch("ROLLBACK")
    }

    /// `COMMIT` して guard を消費する。失敗して transaction が開いたままなら、drop が ROLLBACK する。
    pub fn commit(self) -> rusqlite::Result<()> {
        self.conn.execute_batch("COMMIT")
    }
}

impl Deref for ScopedTransaction<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn
    }
}

impl DerefMut for ScopedTransaction<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn
    }
}

impl Drop for ScopedTransaction<'_> {
    fn drop(&mut self) {
        if !self.conn.is_autocommit() {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(x INTEGER)").unwrap();
        conn
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn commit_publishes_and_drop_rolls_back_like_transaction() {
        let mut conn = memory();
        let tx = ScopedTransaction::begin(&mut conn).unwrap();
        tx.execute("INSERT INTO t VALUES (1)", []).unwrap();
        tx.commit().unwrap();
        assert_eq!(count(&conn), 1);
        assert!(conn.is_autocommit());

        {
            let tx = ScopedTransaction::begin(&mut conn).unwrap();
            tx.execute("INSERT INTO t VALUES (2)", []).unwrap();
            assert!(!tx.is_autocommit());
        }
        assert!(conn.is_autocommit());
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn hooks_can_be_registered_under_the_transaction_through_deref_mut() {
        let mut conn = memory();
        let mut tx = ScopedTransaction::begin(&mut conn).unwrap();
        tx.progress_handler(1, Some(|| false)).unwrap();
        tx.execute("INSERT INTO t VALUES (3)", []).unwrap();
        tx.progress_handler(0, None::<fn() -> bool>).unwrap();
        tx.commit().unwrap();
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn a_failed_commit_leaves_no_open_transaction() {
        let mut conn = memory();
        let mut tx = ScopedTransaction::begin(&mut conn).unwrap();
        tx.execute("INSERT INTO t VALUES (4)", []).unwrap();
        tx.commit_hook(Some(|| true)).unwrap();
        assert!(tx.commit().is_err());
        assert!(conn.is_autocommit());
        assert_eq!(count(&conn), 0);
    }
}
