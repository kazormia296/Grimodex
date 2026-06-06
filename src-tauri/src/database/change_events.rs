use std::time::Duration;

use anyhow::Context;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::Database;

const GENESIS_HASH_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppendChangeEvent {
    pub(crate) event_uid: String,
    pub(crate) scene_id: Option<String>,
    pub(crate) domain: String,
    pub(crate) op_type: String,
    pub(crate) entity_type: Option<String>,
    pub(crate) entity_id: Option<String>,
    pub(crate) payload: String,
    pub(crate) timestamp: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppendResult {
    pub(crate) inserted_count: usize,
    pub(crate) tail_sequence: i64,
    pub(crate) tail_hash: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct HashInput<'a> {
    project_id: &'a str,
    scene_id: Option<&'a str>,
    domain: &'a str,
    op_type: &'a str,
    entity_type: Option<&'a str>,
    entity_id: Option<&'a str>,
    payload: &'a str,
    session_id: &'a str,
    sequence: i64,
    timestamp: i64,
    prev_hash: &'a str,
}

fn canonical_serialize_event(input: HashInput<'_>) -> anyhow::Result<Vec<u8>> {
    serde_json::to_vec(&input).context("serialize change event hash body")
}

fn compute_event_hash_hex(input: HashInput<'_>) -> anyhow::Result<String> {
    let body = canonical_serialize_event(input)?;
    Ok(hex::encode(Sha256::digest(body)))
}

fn current_tail(conn: &Connection, project_id: &str) -> anyhow::Result<(i64, String)> {
    Ok(conn
        .query_row(
            "SELECT sequence, hash
             FROM change_events
             WHERE project_id = ?
             ORDER BY sequence DESC
             LIMIT 1",
            params![project_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .unwrap_or_else(|| (0, GENESIS_HASH_HEX.to_string())))
}

fn event_uid_exists(conn: &Connection, project_id: &str, event_uid: &str) -> anyhow::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1
             FROM change_events
             WHERE project_id = ? AND event_uid = ?
             LIMIT 1",
            params![project_id, event_uid],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

fn live_scene_id(conn: &Connection, scene_id: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(scene_id) = scene_id else {
        return Ok(None);
    };
    let exists = conn
        .query_row(
            "SELECT 1 FROM tree_nodes WHERE id = ? LIMIT 1",
            params![scene_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    Ok(exists.then(|| scene_id.to_string()))
}

pub(crate) fn append_change_events_in_tx(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    events: &[AppendChangeEvent],
) -> anyhow::Result<AppendResult> {
    // Idempotent resend handling. A committed-but-rejected flush is re-sent by
    // the webview, possibly *merged* with new events queued meanwhile
    // (`state.queue = batch.concat(state.queue)`). Skipping the whole batch on
    // the first uid would silently drop those new events, so we filter
    // per-event and append only the genuinely-new suffix.
    //
    // Fast path: if the first event is new, the whole batch is new — events are
    // appended atomically and in order, so an already-present uid can only be a
    // committed prefix from a resend. Only then do we pay the per-event lookup.
    let first_present = match events.first() {
        Some(first) => {
            anyhow::ensure!(!first.event_uid.is_empty(), "eventUid is required");
            event_uid_exists(conn, project_id, &first.event_uid)?
        }
        None => false,
    };

    let (mut sequence, mut prev_hash) = current_tail(conn, project_id)?;
    let mut inserted_count = 0usize;
    for event in events {
        anyhow::ensure!(!event.event_uid.is_empty(), "eventUid is required");
        if first_present && event_uid_exists(conn, project_id, &event.event_uid)? {
            continue;
        }
        sequence += 1;
        let scene_id = live_scene_id(conn, event.scene_id.as_deref())?;
        let hash = compute_event_hash_hex(HashInput {
            project_id,
            scene_id: scene_id.as_deref(),
            domain: &event.domain,
            op_type: &event.op_type,
            entity_type: event.entity_type.as_deref(),
            entity_id: event.entity_id.as_deref(),
            payload: &event.payload,
            session_id,
            sequence,
            timestamp: event.timestamp,
            prev_hash: &prev_hash,
        })?;
        conn.execute(
            "INSERT INTO change_events
             (event_uid, project_id, scene_id, domain, op_type, entity_type,
              entity_id, payload, session_id, sequence, timestamp, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                event.event_uid.as_str(),
                project_id,
                scene_id.as_deref(),
                event.domain.as_str(),
                event.op_type.as_str(),
                event.entity_type.as_deref(),
                event.entity_id.as_deref(),
                event.payload.as_str(),
                session_id,
                sequence,
                event.timestamp,
                prev_hash.as_str(),
                hash.as_str(),
            ],
        )?;
        prev_hash = hash;
        inserted_count += 1;
    }

    Ok(AppendResult {
        inserted_count,
        tail_sequence: sequence,
        tail_hash: prev_hash,
    })
}

pub(crate) fn append_change_events(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    events: &[AppendChangeEvent],
) -> anyhow::Result<AppendResult> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = append_change_events_in_tx(conn, project_id, session_id, events);
    match result {
        Ok(result) => {
            if let Err(err) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(err.into());
            }
            Ok(result)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

impl Database {
    pub(crate) fn append_change_events(
        &self,
        project_id: &str,
        session_id: &str,
        events: &[AppendChangeEvent],
    ) -> anyhow::Result<AppendResult> {
        self.with_conn(|conn| append_change_events(conn, project_id, session_id, events))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::Path;
    use std::sync::{Arc, Barrier};
    use std::thread;

    use rusqlite::Connection;

    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HashVector {
        name: String,
        body: HashVectorBody,
        expected_hash_hex: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HashVectorBody {
        project_id: String,
        scene_id: Option<String>,
        domain: String,
        op_type: String,
        entity_type: Option<String>,
        entity_id: Option<String>,
        payload: String,
        session_id: String,
        sequence: i64,
        timestamp: i64,
        prev_hash: String,
    }

    #[derive(Debug)]
    struct StoredEvent {
        project_id: String,
        scene_id: Option<String>,
        domain: String,
        op_type: String,
        entity_type: Option<String>,
        entity_id: Option<String>,
        payload: String,
        session_id: String,
        sequence: i64,
        timestamp: i64,
        prev_hash: String,
        hash: String,
    }

    fn event(uid: &str, scene_id: Option<&str>, timestamp: i64) -> AppendChangeEvent {
        AppendChangeEvent {
            event_uid: uid.to_string(),
            scene_id: scene_id.map(str::to_string),
            domain: "editor".to_string(),
            op_type: "step".to_string(),
            entity_type: Some("scene".to_string()),
            entity_id: scene_id.map(str::to_string),
            payload: format!("{{\"uid\":\"{uid}\"}}"),
            timestamp,
        }
    }

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL
             );
             CREATE TABLE tree_nodes (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                node_type TEXT NOT NULL,
                title TEXT NOT NULL
             );
             CREATE TABLE change_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_uid TEXT,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                scene_id TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                domain TEXT NOT NULL,
                op_type TEXT NOT NULL,
                entity_type TEXT,
                entity_id TEXT,
                payload TEXT NOT NULL,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                prev_hash TEXT NOT NULL,
                hash TEXT NOT NULL
             );
             CREATE UNIQUE INDEX uq_change_events_project_seq
                ON change_events(project_id, sequence);
             CREATE UNIQUE INDEX uq_change_events_project_uid
                ON change_events(project_id, event_uid);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p', 'Project')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene-1', 'p', 'scene', 'Scene 1')",
            [],
        )
        .unwrap();
        conn
    }

    fn open_file_conn(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.busy_timeout(BUSY_TIMEOUT).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;",
        )
        .unwrap();
        conn
    }

    fn stored_events(conn: &Connection) -> Vec<StoredEvent> {
        let mut stmt = conn
            .prepare(
                "SELECT project_id, scene_id, domain, op_type, entity_type, entity_id,
                        payload, session_id, sequence, timestamp, prev_hash, hash
                 FROM change_events
                 WHERE project_id = 'p'
                 ORDER BY sequence",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok(StoredEvent {
                project_id: row.get(0)?,
                scene_id: row.get(1)?,
                domain: row.get(2)?,
                op_type: row.get(3)?,
                entity_type: row.get(4)?,
                entity_id: row.get(5)?,
                payload: row.get(6)?,
                session_id: row.get(7)?,
                sequence: row.get(8)?,
                timestamp: row.get(9)?,
                prev_hash: row.get(10)?,
                hash: row.get(11)?,
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    fn assert_chain_ok(conn: &Connection) {
        let events = stored_events(conn);
        let mut previous: Option<String> = None;
        for (idx, event) in events.iter().enumerate() {
            assert_eq!(event.sequence, idx as i64 + 1);
            if let Some(previous) = &previous {
                assert_eq!(&event.prev_hash, previous);
            } else {
                assert_eq!(event.prev_hash, GENESIS_HASH_HEX);
            }
            let recomputed = compute_event_hash_hex(HashInput {
                project_id: &event.project_id,
                scene_id: event.scene_id.as_deref(),
                domain: &event.domain,
                op_type: &event.op_type,
                entity_type: event.entity_type.as_deref(),
                entity_id: event.entity_id.as_deref(),
                payload: &event.payload,
                session_id: &event.session_id,
                sequence: event.sequence,
                timestamp: event.timestamp,
                prev_hash: &event.prev_hash,
            })
            .unwrap();
            assert_eq!(event.hash, recomputed);
            previous = Some(event.hash.clone());
        }
    }

    #[test]
    fn golden_hash_vectors_match_js_fixture() {
        let raw = include_str!("../../../src/features/timelapse/hash-vectors.json");
        let vectors: Vec<HashVector> = serde_json::from_str(raw).unwrap();
        for vector in vectors {
            let body = vector.body;
            let hash = compute_event_hash_hex(HashInput {
                project_id: &body.project_id,
                scene_id: body.scene_id.as_deref(),
                domain: &body.domain,
                op_type: &body.op_type,
                entity_type: body.entity_type.as_deref(),
                entity_id: body.entity_id.as_deref(),
                payload: &body.payload,
                session_id: &body.session_id,
                sequence: body.sequence,
                timestamp: body.timestamp,
                prev_hash: &body.prev_hash,
            })
            .unwrap();
            assert_eq!(hash, vector.expected_hash_hex, "{}", vector.name);
        }
    }

    #[test]
    fn append_allocates_monotone_sequence_and_chain() {
        let conn = setup_conn();
        let result = append_change_events(
            &conn,
            "p",
            "session-1",
            &[event("uid-1", Some("scene-1"), 1), event("uid-2", None, 2)],
        )
        .unwrap();

        assert_eq!(result.inserted_count, 2);
        assert_eq!(result.tail_sequence, 2);
        assert_chain_ok(&conn);
    }

    #[test]
    fn append_dedupes_resent_batch_by_first_event_uid() {
        let conn = setup_conn();
        let batch = [event("uid-1", Some("scene-1"), 1), event("uid-2", None, 2)];
        let first = append_change_events(&conn, "p", "session-1", &batch).unwrap();
        let second = append_change_events(&conn, "p", "session-1", &batch).unwrap();

        assert_eq!(first.inserted_count, 2);
        assert_eq!(second.inserted_count, 0);
        assert_eq!(second.tail_sequence, 2);
        assert_eq!(stored_events(&conn).len(), 2);
        assert_chain_ok(&conn);
    }

    #[test]
    fn append_keeps_merged_new_events_when_prefix_already_committed() {
        let conn = setup_conn();
        // First flush commits [uid-1].
        append_change_events(&conn, "p", "session-1", &[event("uid-1", None, 1)]).unwrap();

        // Committed-but-rejected resend: the webview re-sends uid-1 merged with a
        // new uid-2 that was queued during the in-flight flush. uid-1 must dedupe
        // while uid-2 must still be appended (never silently dropped).
        let merged = [event("uid-1", None, 1), event("uid-2", None, 2)];
        let result = append_change_events(&conn, "p", "session-1", &merged).unwrap();

        assert_eq!(result.inserted_count, 1);
        assert_eq!(result.tail_sequence, 2);

        let uid1_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM change_events WHERE event_uid = 'uid-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let uid2_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM change_events WHERE event_uid = 'uid-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(uid1_count, 1, "committed prefix must not duplicate");
        assert_eq!(uid2_count, 1, "merged-in new event must persist");
        assert_eq!(stored_events(&conn).len(), 2);
        assert_chain_ok(&conn);
    }

    #[test]
    fn append_nulls_dangling_scene_id_before_insert() {
        let conn = setup_conn();
        conn.execute("DELETE FROM tree_nodes WHERE id = 'scene-1'", [])
            .unwrap();

        append_change_events(
            &conn,
            "p",
            "session-1",
            &[event("uid-1", Some("scene-1"), 1)],
        )
        .unwrap();

        let scene_id: Option<String> = conn
            .query_row(
                "SELECT scene_id FROM change_events WHERE event_uid = 'uid-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(scene_id.is_none());
        assert_chain_ok(&conn);
    }

    #[test]
    fn append_restarts_from_genesis_after_wipe() {
        let conn = setup_conn();
        append_change_events(&conn, "p", "session-1", &[event("uid-1", None, 1)]).unwrap();
        conn.execute("DELETE FROM change_events WHERE project_id = 'p'", [])
            .unwrap();

        append_change_events(&conn, "p", "session-2", &[event("uid-2", None, 2)]).unwrap();

        let rows = stored_events(&conn);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sequence, 1);
        assert_eq!(rows[0].prev_hash, GENESIS_HASH_HEX);
        assert_chain_ok(&conn);
    }

    #[test]
    fn cross_connection_concurrent_append_serializes_without_sequence_collision() {
        let path = std::env::temp_dir().join(format!(
            "grimodex-change-events-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let db = Database::new(&path).unwrap();
            db.migrate().unwrap();
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title, created_at, updated_at)
                     VALUES ('p', 'Project', datetime('now'), datetime('now'))",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        }

        let barrier = Arc::new(Barrier::new(2));
        let path_a = path.clone();
        let barrier_a = Arc::clone(&barrier);
        let handle_a = thread::spawn(move || {
            let conn = open_file_conn(&path_a);
            let events: Vec<AppendChangeEvent> =
                (0..10).map(|i| event(&format!("a-{i}"), None, i)).collect();
            barrier_a.wait();
            append_change_events(&conn, "p", "session-a", &events)
        });

        let path_b = path.clone();
        let barrier_b = Arc::clone(&barrier);
        let handle_b = thread::spawn(move || {
            let conn = open_file_conn(&path_b);
            let events: Vec<AppendChangeEvent> = (0..10)
                .map(|i| event(&format!("b-{i}"), None, 100 + i))
                .collect();
            barrier_b.wait();
            append_change_events(&conn, "p", "session-b", &events)
        });

        handle_a.join().unwrap().unwrap();
        handle_b.join().unwrap().unwrap();

        let conn = open_file_conn(&path);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 20);
        assert_chain_ok(&conn);

        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
