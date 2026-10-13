//! Parent-connection freshness stamp for a READY C-query worker (CP-2a).
//! Never an authority: the worker's own registration-drift check stays final.
use std::sync::atomic::Ordering;

use crate::{narrative_extraction::nir1_chronicle_index::read_identity::ReadIdentity, Database};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CQueryFreshnessStamp(ReadIdentity);

/// Wait-0 read on the parent's main connection. None when the connection is
/// not reusable, a foreground waiter or maintenance finalization is pending,
/// the mutex is held, the connection is inside a transaction, or a commit
/// raced the observation.
pub fn try_read_c_query_freshness_stamp(db: &Database) -> Option<CQueryFreshnessStamp> {
    if db.ensure_connection_reusable().is_err()
        || db.foreground_connection_waiters.load(Ordering::SeqCst) > 0
        || db.maintenance_finalization_reserved.load(Ordering::SeqCst)
    {
        return None;
    }
    let conn = db.conn.try_lock().ok()?;
    if !conn.is_autocommit() {
        return None;
    }
    ReadIdentity::read_unpinned(&conn)
        .ok()
        .flatten()
        .map(CQueryFreshnessStamp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;

    struct TestDirectory(std::path::PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stamp_tracks_commits_and_is_absent_while_the_connection_is_busy() -> Result<()> {
        let directory = TestDirectory(std::env::temp_dir().join(format!(
            "grimodex-c-query-freshness-{}",
            uuid::Uuid::new_v4()
        )));
        std::fs::create_dir_all(&directory.0)?;
        let path = directory.0.join("grimodex.db");
        let db = Database::new(&path)?;
        db.migrate()?;
        db.with_conn(|conn| {
            conn.execute_batch("CREATE TABLE freshness_probe (x INTEGER);")?;
            Ok(())
        })?;

        let first = try_read_c_query_freshness_stamp(&db).expect("idle connection stamps");
        let second = try_read_c_query_freshness_stamp(&db).expect("idle connection stamps");
        assert_eq!(first, second);

        db.with_conn(|conn| {
            conn.execute("INSERT INTO freshness_probe (x) VALUES (1)", [])?;
            Ok(())
        })?;
        let own_commit = try_read_c_query_freshness_stamp(&db).expect("idle connection stamps");
        assert_ne!(first, own_commit);

        let other = rusqlite::Connection::open(&path)?;
        other.execute("INSERT INTO freshness_probe (x) VALUES (2)", [])?;
        drop(other);
        let other_commit = try_read_c_query_freshness_stamp(&db).expect("idle connection stamps");
        assert_ne!(own_commit, other_commit);

        {
            let guard = db.lock_conn()?;
            assert!(try_read_c_query_freshness_stamp(&db).is_none());
            drop(guard);
        }

        db.with_conn(|conn| {
            conn.execute_batch("BEGIN")?;
            Ok(())
        })?;
        assert!(try_read_c_query_freshness_stamp(&db).is_none());
        db.with_conn(|conn| {
            conn.execute_batch("ROLLBACK")?;
            Ok(())
        })?;
        assert!(try_read_c_query_freshness_stamp(&db).is_some());
        Ok(())
    }
}
