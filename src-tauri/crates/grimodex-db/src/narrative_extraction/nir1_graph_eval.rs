//! Evaluation-only (CP-4 S1a, K6/2 `graph-eval-procedure`, Mandatory defenses).
//!
//! The A3 record of a measurement: the same Native qualification D-final uses
//! (`evaluate_nir1_entity_relation_disclosure`), read on a connection of its
//! own that is opened read-only. It takes neither the workspace's DB mutex nor
//! a lifecycle participant, so the record cannot make the measured owner
//! `busy`. It exists only under the `nir1-graph-eval` feature, which is never in
//! `default` and is never enabled by the normal N-API build or release
//! packaging. The precedent is `src/bin/nir1-disclosure-precheck.rs`.
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{ensure, Result};
use rusqlite::{Connection, OpenFlags, MAIN_DB};

use super::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDisclosureRead,
};

/// The most Revisions one record reads (a fixture has a handful).
pub const MAX_A3_RECORD_REVISIONS: usize = 64;

/// The A3 verdict of one Revision against the query Scene. Reason codes only:
/// no excerpt, body, path or Scope text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct A3RevisionRecord {
    pub revision_id: String,
    pub eligible: bool,
    /// `None` when eligible; the qualification's reason code otherwise.
    pub reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct A3ReadOnlyRecord {
    /// Before the connection was opened.
    pub open_started: Instant,
    /// After the read snapshot was established (the first read of the
    /// transaction), before the first Revision was evaluated.
    pub snapshot_at: Instant,
    /// After the last Revision was evaluated, before the transaction ended.
    pub finished_at: Instant,
    /// Read back from the open connection (`sqlite3_db_readonly` and
    /// `PRAGMA query_only`), not assumed from the flags passed.
    pub read_only: bool,
    pub query_only: bool,
    pub revisions: Vec<A3RevisionRecord>,
}

/// Opens `database` read-only (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`,
/// `query_only`, no busy wait), evaluates each Revision in one read
/// transaction and closes the connection. Never migrates and never writes.
pub fn read_a3_read_only(
    database: &Path,
    project_id: &str,
    query_scene_id: &str,
    revision_ids: &[String],
) -> Result<A3ReadOnlyRecord> {
    ensure!(database.is_absolute(), "NIR1_GRAPH_EVAL_A3_DATABASE_PATH");
    ensure!(
        database
            .file_name()
            .is_some_and(|name| name == "grimodex.db"),
        "NIR1_GRAPH_EVAL_A3_DATABASE_PATH"
    );
    ensure!(
        !project_id.is_empty() && !query_scene_id.is_empty(),
        "NIR1_GRAPH_EVAL_A3_REQUEST"
    );
    ensure!(
        !revision_ids.is_empty()
            && revision_ids.len() <= MAX_A3_RECORD_REVISIONS
            && revision_ids.iter().all(|id| !id.is_empty()),
        "NIR1_GRAPH_EVAL_A3_REQUEST"
    );
    let open_started = Instant::now();
    let mut conn = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::ZERO)?;
    conn.execute_batch("PRAGMA query_only=ON")?;
    let read_only = conn.is_readonly(MAIN_DB)?;
    let query_only = conn.query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))? == 1;
    ensure!(read_only && query_only, "NIR1_GRAPH_EVAL_A3_CONNECTION_WRITABLE");
    let tx = conn.transaction()?;
    // A deferred transaction takes its snapshot at the first read.
    tx.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let snapshot_at = Instant::now();
    let mut revisions = Vec::with_capacity(revision_ids.len());
    for revision_id in revision_ids {
        let record = match evaluate_nir1_entity_relation_disclosure(
            &tx,
            project_id,
            revision_id,
            query_scene_id,
        )? {
            Nir1EntityRelationDisclosureRead::Eligible(_) => A3RevisionRecord {
                revision_id: revision_id.clone(),
                eligible: true,
                reason: None,
            },
            Nir1EntityRelationDisclosureRead::Unavailable { reason } => A3RevisionRecord {
                revision_id: revision_id.clone(),
                eligible: false,
                reason: Some(reason),
            },
        };
        revisions.push(record);
    }
    let finished_at = Instant::now();
    drop(tx);
    Ok(A3ReadOnlyRecord {
        open_started,
        snapshot_at,
        finished_at,
        read_only,
        query_only,
        revisions,
    })
}
