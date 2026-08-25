//! Gate C2-1 acceptance coverage for the production incremental Freshness facade.
//!
//! Fixtures deliberately seed the persisted contract directly. The only behavior
//! entrypoint these tests call is `run_incremental_freshness_cycle`, so a passing
//! test proves the facade composes Feed range selection, reverse lookup,
//! evaluation, publication, Run completion, and cursor acknowledgement.

use grimodex_db::narrative_extraction::{
    ensure_test_schema, narrative_extraction_cancel_run, narrative_extraction_claim_task,
    narrative_extraction_fail_task, narrative_extraction_finish_task,
    run_incremental_freshness_cycle, ClaimTaskPayload, FailTaskPayload, FinishTaskPayload,
    IncrementalFreshnessCycleOutcome, RunRefPayload,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PROJECT_ID: &str = "project-c2-1";
const EPOCH_ID: &str = "epoch-c2-1";
const OCCURRED_AT: &str = "2026-08-19T00:00:00.000Z";
const CURRENT_UPDATED_AT: &str = "2026-08-19T00:00:02.000Z";
const STORED_REVISION_TOKEN: &str = "v1@2026-08-19T00:00:01.000Z";

type TerminalHoldLifecycle = (
    String,
    Option<String>,
    String,
    i64,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);

type RetryableHoldLifecycle = (
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        // Keep the integration fixture compatible with the repository's
        // public test schema contract as well as the current migration.
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-1 Project')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', ?3)",
            params![EPOCH_ID, PROJECT_ID, OCCURRED_AT],
        )?;
        Ok(())
    })
    .expect("seed base C2-1 fixture");
    db
}

fn seed_scene(conn: &Connection, scene_id: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO tree_nodes
            (id, project_id, node_type, title, content, version, updated_at)
         VALUES (?1, ?2, 'scene', ?1, '{}', 2, ?3)",
        params![scene_id, PROJECT_ID, CURRENT_UPDATED_AT],
    )?;
    Ok(())
}

fn seed_consumer_edge(
    conn: &Connection,
    consumer_run_id: &str,
    edge_id: &str,
    scene_id: &str,
) -> anyhow::Result<()> {
    seed_consumer_edge_with_read_set(
        conn,
        consumer_run_id,
        edge_id,
        scene_id,
        &format!("[\"{STORED_REVISION_TOKEN}\"]"),
    )
}

fn seed_consumer_edge_with_read_set(
    conn: &Connection,
    consumer_run_id: &str,
    edge_id: &str,
    scene_id: &str,
    read_set_json: &str,
) -> anyhow::Result<()> {
    seed_consumer_edge_for_source(
        conn,
        consumer_run_id,
        edge_id,
        &format!("project:scene:{scene_id}"),
        read_set_json,
    )
}

fn seed_consumer_edge_for_source(
    conn: &Connection,
    consumer_run_id: &str,
    edge_id: &str,
    source_object_identity: &str,
    read_set_json: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, completed_at, run_kind, semantic_epoch_id)
         VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', ?1,
                 'completed', '{}', ?3, ?3, 'interpretation', ?4)",
        params![consumer_run_id, PROJECT_ID, OCCURRED_AT, EPOCH_ID],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, generated_by_transaction_id, created_at, owning_run_id)
         VALUES (?1, ?2, 'narrative-extraction-run', ?3, ?4, ?5, NULL, ?6, ?3)",
        params![
            edge_id,
            PROJECT_ID,
            consumer_run_id,
            source_object_identity,
            read_set_json,
            OCCURRED_AT,
        ],
    )?;
    Ok(())
}

fn seed_scene_change(conn: &Connection, scene_id: &str, sequence: i64) -> anyhow::Result<()> {
    seed_scene_change_with(
        conn,
        scene_id,
        sequence,
        "update",
        &format!("sha256:before-{scene_id}"),
        &format!("sha256:after-{scene_id}"),
        &serde_json::json!({ "normalizerVersion": "gdx-canonical-text/1" }),
    )
}

#[allow(clippy::too_many_arguments)]
fn seed_scene_change_with(
    conn: &Connection,
    scene_id: &str,
    sequence: i64,
    mutation_kind: &str,
    before_digest: &str,
    after_digest: &str,
    text_impact: &Value,
) -> anyhow::Result<()> {
    seed_scene_change_for_project(
        conn,
        PROJECT_ID,
        scene_id,
        sequence,
        mutation_kind,
        before_digest,
        after_digest,
        text_impact,
    )
}

#[allow(clippy::too_many_arguments)]
fn seed_scene_change_for_project(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    sequence: i64,
    mutation_kind: &str,
    before_digest: &str,
    after_digest: &str,
    text_impact: &Value,
) -> anyhow::Result<()> {
    let event_uid = format!("canonical-scene-{scene_id}-{sequence}");
    let transaction_id = format!("feed-transaction-{scene_id}-{sequence}");
    let event_id = format!("feed-event-{scene_id}-{sequence}");
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES (?1, ?2, ?3, 'scene', 'scene.update', 'scene', ?3,
                 '{}', 'c2-1-test', ?4, 1787078400000, 'fixture-prev', 'fixture-hash')",
        params![event_uid, project_id, scene_id, sequence],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, application_ids_json,
             payload_digest, created_at)
         VALUES (?1, ?2, ?3, 'scene.update', ?4, ?5, 'forward', 'human', '[]',
                 ?6, ?7)",
        params![
            transaction_id,
            project_id,
            format!("request-{scene_id}-{sequence}"),
            event_uid,
            sequence,
            format!("sha256:payload-{scene_id}-{sequence}"),
            OCCURRED_AT,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, before_version, before_digest, after_version,
             after_digest, changed_paths_json, text_impact_json,
             structural_impact_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'content', 'update',
                 1, ?7, 2, ?8, '[\"/content\"]', ?9, NULL, ?10)",
        params![
            event_id,
            project_id,
            transaction_id,
            event_uid,
            sequence,
            format!(r#"{{"kind":"scene","sceneId":"{scene_id}"}}"#),
            before_digest,
            after_digest,
            serde_json::to_string(text_impact)?,
            OCCURRED_AT,
        ],
    )?;
    conn.execute(
        "UPDATE narrative_change_events SET mutation_kind = ?1 WHERE id = ?2",
        params![mutation_kind, event_id],
    )?;
    Ok(())
}

fn edge_state(db: &Database, edge_id: &str) -> (String, Option<String>, String) {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT evidence_freshness, reason_code, build_action
               FROM narrative_dependency_edge_states WHERE edge_id = ?1",
            [edge_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?)
    })
    .expect("read published Edge state")
}

fn seed_one_changed_scene(db: &Database) {
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed changed scene");
}

fn assert_completed_run_and_ack(db: &Database, expected_sequence: i64) -> String {
    db.with_conn(|conn| {
        let run_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'freshness-evaluation'",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(run_count, 1, "one Feed range must use one Freshness Run");

        let (run_id, status, run_consumer_id, completed_at): (
            String,
            String,
            Option<String>,
            Option<String>,
        ) = conn.query_row(
            "SELECT id, status, consumer_id, completed_at
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'freshness-evaluation'",
            [PROJECT_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(status, "completed");
        assert!(
            completed_at.is_some(),
            "completed Run must carry completed_at"
        );

        let cursor_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_cursors WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(cursor_count, 1, "the runtime owns one project cursor");
        let (consumer_id, acknowledged, epoch, reserved, active_run): (
            String,
            i64,
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = conn.query_row(
            "SELECT consumer_id, acknowledged_through_sequence, semantic_epoch_id,
                    reserved_through_sequence, active_run_id
               FROM narrative_change_cursors
              WHERE project_id = ?1",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(acknowledged, expected_sequence);
        assert_eq!(run_consumer_id.as_deref(), Some(consumer_id.as_str()));
        assert_eq!(epoch, None, "ack must release the Epoch reservation");
        assert_eq!(reserved, None, "ack must release the reserved range");
        assert_eq!(active_run, None, "ack must release the active Run");
        Ok(run_id)
    })
    .expect("Run completion and cursor acknowledgement are atomic")
}

fn count_rows(db: &Database, table: &str) -> i64 {
    db.with_conn(|conn| {
        Ok(
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })?,
        )
    })
    .expect("count fixture rows")
}

#[test]
fn pending_feed_without_an_epoch_waits_without_minting_authority() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM narrative_semantic_epochs WHERE project_id = ?1",
            [PROJECT_ID],
        )?;
        seed_scene(conn, "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed Feed without canonical Epoch");

    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("wait for Epoch authority"),
        IncrementalFreshnessCycleOutcome::Idle
    ));
    assert_eq!(count_rows(&db, "narrative_semantic_epochs"), 0);
    assert_eq!(count_rows(&db, "narrative_change_cursors"), 0);
    db.with_conn(|conn| {
        let freshness_runs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs
              WHERE run_kind = 'freshness-evaluation'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(freshness_runs, 0);
        Ok(())
    })
    .expect("no side-effect authority was minted");
}

#[test]
fn scene_feed_range_updates_only_reverse_dependent_consumers_and_acks_atomically() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_scene(conn, "scene-unrelated")?;
        seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;
        seed_consumer_edge(
            conn,
            "consumer-unrelated",
            "edge-unrelated",
            "scene-unrelated",
        )?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed reverse lookup fixture");

    let outcome = run_incremental_freshness_cycle(&db).expect("process one Feed range");
    let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
        panic!("pending Feed range must not report Idle");
    };
    assert_eq!(summary.project_id, PROJECT_ID);
    assert_eq!(summary.from_sequence_exclusive, 0);
    assert_eq!(summary.through_sequence_inclusive, 1);
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.affected_consumer_count, 1);
    assert!(!summary.has_more);

    let freshness_run_id = assert_completed_run_and_ack(&db, 1);
    db.with_conn(|conn| {
        let edge_rows = conn
            .prepare(
                "SELECT edge_id, evidence_freshness, reason_code, build_action
                   FROM narrative_dependency_edge_states ORDER BY edge_id",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            edge_rows,
            vec![(
                "edge-target".to_string(),
                "stale".to_string(),
                Some("source-revision-changed".to_string()),
                "rebuild-required".to_string(),
            )],
            "the unrelated Edge must not be evaluated"
        );

        let consumer_rows = conn
            .prepare(
                "SELECT consumer_key, evidence_freshness, build_action,
                        last_evaluated_run_id
                   FROM narrative_consumer_freshness ORDER BY consumer_key",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            consumer_rows,
            vec![(
                "consumer-target".to_string(),
                "stale".to_string(),
                "rebuild-required".to_string(),
                Some(freshness_run_id),
            )],
            "the unrelated Consumer must not be published"
        );
        Ok(())
    })
    .expect("inspect incremental publication");
}

#[test]
fn unknown_consumer_kind_replaces_old_freshness_before_feed_ack() {
    let db = fixture_db();
    let consumer_kind = "application-contribution";
    let consumer_key = "contribution-incremental-authority";
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, generated_by_transaction_id, created_at, owning_run_id)
             VALUES ('edge-unknown-incremental', ?1, ?2, ?3, 'project:scene:scene-target',
                     ?4, NULL, ?5, NULL)",
            params![
                PROJECT_ID,
                consumer_kind,
                consumer_key,
                r#"["v1@2026-08-19T00:00:01.000Z"]"#,
                OCCURRED_AT,
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edge_states
                (edge_id, project_id, evidence_freshness, reason_code, build_action,
                 evaluated_at_epoch_id, evaluated_at)
             VALUES ('edge-unknown-incremental', ?1, 'fresh', NULL, 'none', ?2, ?3)",
            params![PROJECT_ID, EPOCH_ID, OCCURRED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness,
                 build_action, semantic_epoch_id, last_evaluated_run_id, updated_at)
             VALUES (?1, ?2, ?3, 'fresh', 'none', ?4, 'legacy-incremental-run', ?5)",
            params![
                PROJECT_ID,
                consumer_kind,
                consumer_key,
                EPOCH_ID,
                OCCURRED_AT,
            ],
        )?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed an unknown Consumer with an old Fresh authority and a change event");

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("process unknown Consumer change")
    else {
        panic!("the pending Feed range must be processed")
    };
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.affected_consumer_count, 1);
    assert_eq!(
        edge_state(&db, "edge-unknown-incremental"),
        ("unknown".to_string(), None, "manual".to_string())
    );

    db.with_conn(|conn| {
        let freshness: (String, String, Option<String>) = conn.query_row(
            "SELECT evidence_freshness, build_action, last_evaluated_run_id
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![PROJECT_ID, consumer_kind, consumer_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(freshness.0, "unknown");
        assert_eq!(freshness.1, "manual");
        assert_ne!(freshness.2.as_deref(), Some("legacy-incremental-run"));
        Ok(())
    })
    .expect("read the published unknown Consumer authority");
    assert_completed_cursor_without_reservation(&db, 1);
}

#[test]
fn one_source_publishes_both_consumers_before_the_single_range_ack() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge(conn, "consumer-a", "edge-a", "scene-target")?;
        seed_consumer_edge(conn, "consumer-b", "edge-b", "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed fan-out fixture");

    let outcome = run_incremental_freshness_cycle(&db).expect("process fan-out Feed range");
    let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
        panic!("pending Feed range must not report Idle");
    };
    assert_eq!(summary.affected_edge_count, 2);
    assert_eq!(summary.affected_consumer_count, 2);
    assert_eq!(summary.through_sequence_inclusive, 1);
    assert!(!summary.has_more);

    assert_completed_run_and_ack(&db, 1);
    assert_eq!(count_rows(&db, "narrative_dependency_edge_states"), 2);
    assert_eq!(count_rows(&db, "narrative_consumer_freshness"), 2);
    assert_eq!(
        count_rows(&db, "narrative_maintenance_finding_observations"),
        2
    );
}

#[test]
fn event_without_a_reverse_dependency_is_acknowledged_without_derived_state() {
    let db = fixture_db();
    seed_one_changed_scene(&db);

    let outcome = run_incremental_freshness_cycle(&db).expect("process irrelevant Feed range");
    let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
        panic!("pending Feed range must not report Idle");
    };
    assert_eq!(summary.project_id, PROJECT_ID);
    assert_eq!(summary.from_sequence_exclusive, 0);
    assert_eq!(summary.through_sequence_inclusive, 1);
    assert_eq!(summary.affected_edge_count, 0);
    assert_eq!(summary.affected_consumer_count, 0);
    assert!(!summary.has_more);

    db.with_conn(|conn| {
        let acknowledged: i64 = conn.query_row(
            "SELECT acknowledged_through_sequence
               FROM narrative_change_cursors
              WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(acknowledged, 1);
        Ok(())
    })
    .expect("irrelevant range is acknowledged");
    assert_eq!(count_rows(&db, "narrative_dependency_edge_states"), 0);
    assert_eq!(count_rows(&db, "narrative_consumer_freshness"), 0);
    assert_eq!(
        count_rows(&db, "narrative_maintenance_finding_observations"),
        0
    );
}

#[test]
fn replay_is_idle_without_duplicate_findings_or_freshness_regression() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed replay fixture");

    let first = run_incremental_freshness_cycle(&db).expect("first cycle");
    let IncrementalFreshnessCycleOutcome::Processed(summary) = first else {
        panic!("first cycle must process the pending range");
    };
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.affected_consumer_count, 1);
    assert_eq!(
        count_rows(&db, "narrative_maintenance_finding_observations"),
        1
    );

    let before = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT evidence_freshness, build_action, last_evaluated_run_id
                   FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_key = 'consumer-target'",
                [PROJECT_ID],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?)
        })
        .expect("read first Freshness publication");
    assert_eq!(before.0, "stale");
    assert_eq!(before.1, "rebuild-required");

    match run_incremental_freshness_cycle(&db).expect("replay cycle") {
        IncrementalFreshnessCycleOutcome::Idle => {}
        IncrementalFreshnessCycleOutcome::Processed(_) => {
            panic!("an acknowledged range must not be processed twice")
        }
    }

    let after = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT evidence_freshness, build_action, last_evaluated_run_id
                   FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_key = 'consumer-target'",
                [PROJECT_ID],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?)
        })
        .expect("read replay Freshness publication");
    assert_eq!(after, before, "replay must not move Freshness backward");
    assert_eq!(count_rows(&db, "narrative_extraction_runs"), 2);
    assert_eq!(
        count_rows(&db, "narrative_maintenance_finding_observations"),
        1
    );
}

#[test]
fn comparison_states_are_reached_through_the_public_runtime() {
    struct Case {
        name: &'static str,
        mutation_kind: &'static str,
        before_digest: &'static str,
        after_digest: &'static str,
        text_impact: Value,
        read_set_json: String,
        delete_source: bool,
        expected: (&'static str, Option<&'static str>, &'static str),
    }

    let cases = vec![
        Case {
            name: "source missing",
            mutation_kind: "delete",
            before_digest: "sha256:before",
            after_digest: "sha256:deleted",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/1"
            }),
            read_set_json: format!("[\"{STORED_REVISION_TOKEN}\"]"),
            delete_source: true,
            expected: ("source-missing", Some("source-missing"), "manual"),
        },
        Case {
            name: "exact relocation",
            mutation_kind: "update",
            before_digest: "sha256:unchanged",
            after_digest: "sha256:unchanged",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/1"
            }),
            read_set_json: format!("[\"{STORED_REVISION_TOKEN}\"]"),
            delete_source: false,
            expected: ("fresh", Some("exact-content-relocated"), "revalidate-exact"),
        },
        Case {
            name: "normalizer incompatible",
            mutation_kind: "update",
            before_digest: "sha256:before",
            after_digest: "sha256:after",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/0"
            }),
            read_set_json: format!("[\"{STORED_REVISION_TOKEN}\"]"),
            delete_source: false,
            expected: ("unknown", Some("normalizer-incompatible"), "recompile-only"),
        },
        Case {
            name: "read set drift",
            mutation_kind: "update",
            before_digest: "sha256:before",
            after_digest: "sha256:after",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/1",
                "mapping": {
                    "kind": "position-map",
                    "segments": [{
                        "oldRange": { "from": 0, "to": 5 },
                        "newRange": { "from": 0, "to": 0 },
                        "behavior": "deleted"
                    }]
                }
            }),
            read_set_json: serde_json::json!([
                STORED_REVISION_TOKEN,
                {
                    "kind": "text-range",
                    "from": 0,
                    "to": 5,
                    "normalizerVersion": "gdx-canonical-text/1"
                }
            ])
            .to_string(),
            delete_source: false,
            expected: (
                "read-set-drift",
                Some("read-set-drift"),
                "reanchor-candidate",
            ),
        },
        Case {
            name: "anchor mismatch",
            mutation_kind: "update",
            before_digest: "sha256:before",
            after_digest: "sha256:after",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/1",
                "mapping": {
                    "kind": "position-map",
                    "segments": [{
                        "oldRange": { "from": 0, "to": 5 },
                        "newRange": { "from": 0, "to": 5 },
                        "behavior": "replaced"
                    }]
                }
            }),
            read_set_json: serde_json::json!([
                STORED_REVISION_TOKEN,
                {
                    "kind": "text-range",
                    "from": 0,
                    "to": 5,
                    "anchorDigest": "sha256:quote",
                    "normalizerVersion": "gdx-canonical-text/1"
                }
            ])
            .to_string(),
            delete_source: false,
            expected: (
                "anchor-mismatch",
                Some("quote-not-found"),
                "reanchor-candidate",
            ),
        },
        Case {
            name: "whole document mapping remains ordinary stale",
            mutation_kind: "update",
            before_digest: "sha256:before",
            after_digest: "sha256:after",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/1",
                "mapping": {
                    "kind": "whole-document",
                    "reason": "canonical writer has no coordinate map"
                }
            }),
            read_set_json: serde_json::json!([
                STORED_REVISION_TOKEN,
                {
                    "kind": "text-range",
                    "from": 10,
                    "to": 20,
                    "anchorDigest": "sha256:quote",
                    "normalizerVersion": "gdx-canonical-text/1"
                }
            ])
            .to_string(),
            delete_source: false,
            expected: ("stale", Some("source-revision-changed"), "rebuild-required"),
        },
        Case {
            name: "canonical diff overlaps the persisted range",
            mutation_kind: "update",
            before_digest: "sha256:before",
            after_digest: "sha256:after",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/1",
                "mapping": {
                    "kind": "canonical-diff",
                    "changedOldRanges": [{ "from": 12, "to": 14 }],
                    "changedNewRanges": [{ "from": 12, "to": 15 }]
                }
            }),
            read_set_json: serde_json::json!([
                STORED_REVISION_TOKEN,
                {
                    "kind": "text-range",
                    "from": 10,
                    "to": 20,
                    "anchorDigest": "sha256:quote",
                    "normalizerVersion": "gdx-canonical-text/1"
                }
            ])
            .to_string(),
            delete_source: false,
            expected: ("stale", Some("source-revision-changed"), "rebuild-required"),
        },
        Case {
            name: "canonical diff proves the persisted range unaffected",
            mutation_kind: "update",
            before_digest: "sha256:before",
            after_digest: "sha256:after",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/1",
                "mapping": {
                    "kind": "canonical-diff",
                    "changedOldRanges": [{ "from": 30, "to": 40 }],
                    "changedNewRanges": [{ "from": 30, "to": 41 }]
                }
            }),
            read_set_json: serde_json::json!([
                STORED_REVISION_TOKEN,
                {
                    "kind": "text-range",
                    "from": 10,
                    "to": 20,
                    "anchorDigest": "sha256:quote",
                    "normalizerVersion": "gdx-canonical-text/1"
                }
            ])
            .to_string(),
            delete_source: false,
            expected: ("stale", Some("source-revision-changed"), "rebuild-required"),
        },
        Case {
            name: "event normalizer mismatch cannot be overwritten by edge metadata",
            mutation_kind: "update",
            before_digest: "sha256:before",
            after_digest: "sha256:after",
            text_impact: serde_json::json!({
                "normalizerVersion": "gdx-canonical-text/0",
                "mapping": { "kind": "whole-document", "reason": "fixture" }
            }),
            read_set_json: serde_json::json!([
                STORED_REVISION_TOKEN,
                {
                    "kind": "text-range",
                    "from": 0,
                    "to": 5,
                    "normalizerVersion": "gdx-canonical-text/1"
                }
            ])
            .to_string(),
            delete_source: false,
            expected: ("unknown", Some("normalizer-incompatible"), "recompile-only"),
        },
    ];

    for case in cases {
        let db = fixture_db();
        db.with_conn(|conn| {
            seed_scene(conn, "scene-target")?;
            seed_consumer_edge_with_read_set(
                conn,
                "consumer-target",
                "edge-target",
                "scene-target",
                &case.read_set_json,
            )?;
            seed_scene_change_with(
                conn,
                "scene-target",
                1,
                case.mutation_kind,
                case.before_digest,
                case.after_digest,
                &case.text_impact,
            )?;
            if case.delete_source {
                conn.execute(
                    "UPDATE change_events SET scene_id = NULL
                      WHERE event_uid = 'canonical-scene-scene-target-1'",
                    [],
                )?;
                conn.execute("DELETE FROM tree_nodes WHERE id = 'scene-target'", [])?;
            }
            Ok(())
        })
        .unwrap_or_else(|error| panic!("seed {}: {error:#}", case.name));

        let outcome = run_incremental_freshness_cycle(&db)
            .unwrap_or_else(|error| panic!("run {}: {error:#}", case.name));
        assert!(
            matches!(outcome, IncrementalFreshnessCycleOutcome::Processed(_)),
            "{} must process its Feed range",
            case.name
        );
        let actual = edge_state(&db, "edge-target");
        assert_eq!(actual.0, case.expected.0, "{} freshness", case.name);
        assert_eq!(actual.1.as_deref(), case.expected.1, "{} reason", case.name);
        assert_eq!(actual.2, case.expected.2, "{} action", case.name);
    }
}

#[test]
fn sealed_batch_incarnation_replacement_cannot_launder_a_colliding_scene_token_as_fresh() {
    for replacement_kind in ["create", "restore"] {
        let db = fixture_db();
        db.with_conn(|conn| {
            seed_scene(conn, "scene-target")?;
            seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;

            seed_scene_change_with(
                conn,
                "scene-target",
                1,
                "delete",
                "sha256:original",
                "sha256:deleted",
                &serde_json::json!({ "normalizerVersion": "gdx-canonical-text/1" }),
            )?;
            conn.execute(
                "UPDATE change_events SET scene_id = NULL
                  WHERE event_uid = 'canonical-scene-scene-target-1'",
                [],
            )?;
            conn.execute("DELETE FROM tree_nodes WHERE id = 'scene-target'", [])?;

            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, version, updated_at)
                 VALUES ('scene-target', ?1, 'scene', 'recreated', '{}', 1,
                         '2026-08-19T00:00:01.000Z')",
                [PROJECT_ID],
            )?;
            seed_scene_change_with(
                conn,
                "scene-target",
                2,
                replacement_kind,
                "sha256:deleted",
                "sha256:recreated",
                &serde_json::json!({ "normalizerVersion": "gdx-canonical-text/1" }),
            )?;

            seed_scene_change_with(
                conn,
                "scene-target",
                3,
                "update",
                "sha256:recreated",
                "sha256:recreated",
                &serde_json::json!({ "normalizerVersion": "gdx-canonical-text/1" }),
            )?;
            conn.execute(
                "UPDATE narrative_change_events
                    SET before_version = 1, after_version = 1
                  WHERE id = 'feed-event-scene-target-3'",
                [],
            )?;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("seed {replacement_kind} incarnation batch: {error:#}"));

        let outcome = run_incremental_freshness_cycle(&db).unwrap_or_else(|error| {
            panic!("process {replacement_kind} incarnation batch: {error:#}")
        });
        let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
            panic!("{replacement_kind} incarnation batch must process");
        };
        assert_eq!(summary.from_sequence_exclusive, 0);
        assert_eq!(summary.through_sequence_inclusive, 3);
        assert_eq!(summary.affected_edge_count, 1);
        assert_eq!(
            edge_state(&db, "edge-target"),
            (
                "stale".to_string(),
                Some("source-revision-changed".to_string()),
                "rebuild-required".to_string(),
            ),
            "{replacement_kind} must preserve the conservative incarnation boundary even when the live token collides with the old Edge token"
        );
        assert_completed_run_and_ack(&db, 3);
    }
}

#[test]
fn component_schema_change_fans_out_as_unknown_without_domain_writes() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-a")?;
        seed_scene(conn, "scene-b")?;
        seed_consumer_edge(conn, "consumer-a", "edge-a", "scene-a")?;
        seed_consumer_edge(conn, "consumer-b", "edge-b", "scene-b")?;
        seed_component_change(conn, 1)?;
        Ok(())
    })
    .expect("seed component change");

    let outcome = run_incremental_freshness_cycle(&db).expect("process component change");
    let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
        panic!("component change must process")
    };
    assert_eq!(summary.affected_edge_count, 2);
    assert_eq!(summary.affected_consumer_count, 2);
    for edge_id in ["edge-a", "edge-b"] {
        assert_eq!(
            edge_state(&db, edge_id),
            (
                "unknown".to_string(),
                Some("component-incompatible".to_string()),
                "resolve-only".to_string(),
            )
        );
    }
}

fn seed_component_change(conn: &Connection, sequence: i64) -> anyhow::Result<()> {
    let event_uid = format!("canonical-component-{sequence}");
    let transaction_id = format!("feed-component-{sequence}");
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES (?1, ?2, 'component', 'component.schema.change', 'component',
                 'extractor', '{}', 'c2-1-test', ?3, 1787078400000,
                 'fixture-prev', 'fixture-hash')",
        params![event_uid, PROJECT_ID, sequence],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, application_ids_json,
             payload_digest, created_at)
         VALUES (?1, ?2, ?3, 'component.schema.change', ?4, ?5, 'forward',
                 'migration', '[]', ?6, ?7)",
        params![
            transaction_id,
            PROJECT_ID,
            format!("request-component-{sequence}"),
            event_uid,
            sequence,
            format!("sha256:component-{sequence}"),
            OCCURRED_AT,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, changed_paths_json, structural_impact_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'schema', 'update', '[\"/\"]',
                 ?7, ?8)",
        params![
            format!("component-event-{sequence}"),
            PROJECT_ID,
            transaction_id,
            event_uid,
            sequence,
            r#"{"kind":"component","componentId":"extractor"}"#,
            r#"{"event":"schema-component-changed","requiresFullRebuild":true}"#,
            OCCURRED_AT,
        ],
    )?;
    Ok(())
}

fn seed_component_object_change(
    conn: &Connection,
    component_id: &str,
    sequence: i64,
    mutation_kind: &str,
) -> anyhow::Result<()> {
    let event_uid = format!("canonical-component-object-{sequence}");
    let transaction_id = format!("feed-component-object-{sequence}");
    let event_id = format!("component-object-event-{sequence}");
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES (?1, ?2, 'component', 'component.update', 'component', ?3,
                 '{}', 'c2-1-test', ?4, 1787078400000,
                 'fixture-prev', 'fixture-hash')",
        params![event_uid, PROJECT_ID, component_id, sequence],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, application_ids_json,
             payload_digest, created_at)
         VALUES (?1, ?2, ?3, 'component.update', ?4, ?5, 'forward',
                 'human', '[]', ?6, ?7)",
        params![
            transaction_id,
            PROJECT_ID,
            format!("request-component-object-{sequence}"),
            event_uid,
            sequence,
            format!("sha256:component-object-{sequence}"),
            OCCURRED_AT,
        ],
    )?;
    let after_version = (mutation_kind != "delete").then_some(2_i64);
    let after_digest = (mutation_kind != "delete").then(|| "sha256:after".to_string());
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, before_version, before_digest, after_version,
             after_digest, changed_paths_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'metadata', ?7,
                 1, 'sha256:before', ?8, ?9, '[\"/\"]', ?10)",
        params![
            event_id,
            PROJECT_ID,
            transaction_id,
            event_uid,
            sequence,
            serde_json::json!({ "kind": "component", "componentId": component_id }).to_string(),
            mutation_kind,
            after_version,
            after_digest,
            OCCURRED_AT,
        ],
    )?;
    Ok(())
}

fn seed_project_restore_marker(conn: &Connection, sequence: i64) -> anyhow::Result<()> {
    let event_uid = format!("canonical-project-restore-{sequence}");
    let transaction_id = format!("feed-project-restore-{sequence}");
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES (?1, ?2, 'project.restore', 'project.restore', 'project', ?2,
                 '{}', 'c2-1-test', ?3, 1787078400000,
                 'fixture-prev', 'fixture-hash')",
        params![event_uid, PROJECT_ID, sequence],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, application_ids_json,
             payload_digest, created_at)
         VALUES (?1, ?2, ?3, 'project.restore', ?4, ?5, 'forward',
                 'migration', '[]', ?6, ?7)",
        params![
            transaction_id,
            PROJECT_ID,
            format!("request-project-restore-{sequence}"),
            event_uid,
            sequence,
            format!("sha256:project-restore-{sequence}"),
            OCCURRED_AT,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, before_version, before_digest, after_version,
             after_digest, changed_paths_json, structural_impact_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'schema', 'update',
                 1, 'sha256:before', 2, 'sha256:after', '[\"/\"]', ?7, ?8)",
        params![
            format!("project-restore-event-{sequence}"),
            PROJECT_ID,
            transaction_id,
            event_uid,
            sequence,
            serde_json::json!({ "kind": "project", "projectId": PROJECT_ID }).to_string(),
            serde_json::json!({
                "event": "project-restored",
                "requiresFullRebuild": true
            })
            .to_string(),
            OCCURRED_AT,
        ],
    )?;
    Ok(())
}

fn seed_temporal_projection_change(conn: &Connection, sequence: i64) -> anyhow::Result<()> {
    let event_uid = format!("canonical-projection-{sequence}");
    let transaction_id = format!("feed-projection-{sequence}");
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES (?1, ?2, 'temporal-projection', 'temporal-projection.update',
                 'temporal-projection', 'projection-1', '{}', 'c2-1-test', ?3,
                 1787078400000, 'fixture-prev', 'fixture-hash')",
        params![event_uid, PROJECT_ID, sequence],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, application_ids_json,
             payload_digest, created_at)
         VALUES (?1, ?2, ?3, 'temporal-projection.update', ?4, ?5, 'forward',
                 'human', '[]', ?6, ?7)",
        params![
            transaction_id,
            PROJECT_ID,
            format!("request-projection-{sequence}"),
            event_uid,
            sequence,
            format!("sha256:projection-{sequence}"),
            OCCURRED_AT,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, before_version, before_digest, after_version,
             after_digest, changed_paths_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'metadata', 'update',
                 0, 'sha256:before', 1, 'sha256:after', '[\"/status\"]', ?7)",
        params![
            format!("projection-event-{sequence}"),
            PROJECT_ID,
            transaction_id,
            event_uid,
            sequence,
            r#"{"kind":"temporal-projection","projectionId":"projection-1"}"#,
            OCCURRED_AT,
        ],
    )?;
    Ok(())
}

#[test]
fn invalidated_projection_is_unknown_without_retrying_the_feed_forever() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_temporal_projections
                (id, project_id, target_kind, target_id, constraint_set_digest,
                 solver_version, projected_value_digest, target_result_version,
                 application_id, status, version, created_at, updated_at)
             VALUES ('projection-1', ?1, 'scene-time', 'scene-1', 'sha256:constraints',
                     'solver/1', 'sha256:value', 1, 'application-1', 'invalidated',
                     1, ?2, ?2)",
            params![PROJECT_ID, CURRENT_UPDATED_AT],
        )?;
        seed_consumer_edge_for_source(
            conn,
            "consumer-projection",
            "edge-projection",
            "projection:projection-1",
            r#"["v0@2026-08-19T00:00:01.000Z"]"#,
        )?;
        seed_temporal_projection_change(conn, 1)?;
        Ok(())
    })
    .expect("seed invalidated projection");

    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("classify invalidated projection"),
        IncrementalFreshnessCycleOutcome::Processed(_)
    ));
    assert_eq!(
        edge_state(&db, "edge-projection"),
        ("unknown".to_string(), None, "manual".to_string())
    );
    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("acknowledged range is idle"),
        IncrementalFreshnessCycleOutcome::Idle
    ));
}

#[test]
fn restore_marker_revalidates_the_full_graph_under_the_new_epoch() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-restored', ?1, 1, 'restore', ?2)",
            params![PROJECT_ID, CURRENT_UPDATED_AT],
        )?;
        seed_project_restore_marker(conn, 1)?;
        Ok(())
    })
    .expect("seed restore marker");

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("process restore marker")
    else {
        panic!("restore marker must process")
    };
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(
        edge_state(&db, "edge-target"),
        ("unknown".to_string(), None, "manual".to_string())
    );
    db.with_conn(|conn| {
        let epoch: String = conn.query_row(
            "SELECT semantic_epoch_id FROM narrative_consumer_freshness
              WHERE consumer_key = 'consumer-target'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(epoch, "epoch-restored");
        Ok(())
    })
    .expect("publication belongs to restored Epoch");
    assert_completed_cursor_without_reservation(&db, 1);
}

#[test]
fn codex_component_events_reverse_lookup_the_aggregate_catalog_source() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_types (id, project_id, slug, label)
             VALUES ('type-c2-1', ?1, 'c2-custom', 'C2 Custom')",
            [PROJECT_ID],
        )?;
        seed_consumer_edge_for_source(
            conn,
            "consumer-catalog",
            "edge-catalog",
            &format!("project:codex-catalog:{PROJECT_ID}"),
            r#"["sha256:catalog-before"]"#,
        )?;
        seed_component_object_change(conn, "codex-type:type-c2-1", 1, "update")?;
        Ok(())
    })
    .expect("seed Codex component change");

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("process Codex component")
    else {
        panic!("Codex component Feed range must process")
    };
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.affected_consumer_count, 1);
    assert_eq!(edge_state(&db, "edge-catalog").0, "stale");
    assert_completed_cursor_without_reservation(&db, 1);
}

#[test]
fn deleting_one_catalog_member_does_not_mark_the_aggregate_source_missing() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_types (id, project_id, slug, label)
             VALUES ('type-c2-1', ?1, 'c2-custom', 'C2 Custom')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO codex_tags (id, project_id, name)
             VALUES ('tag-1', ?1, 'Hero')",
            [PROJECT_ID],
        )?;
        seed_consumer_edge_for_source(
            conn,
            "consumer-catalog",
            "edge-catalog",
            &format!("project:codex-catalog:{PROJECT_ID}"),
            r#"["sha256:catalog-with-tag"]"#,
        )?;
        conn.execute("DELETE FROM codex_tags WHERE id = 'tag-1'", [])?;
        seed_component_object_change(conn, "codex-tag:tag-1", 1, "delete")?;
        Ok(())
    })
    .expect("seed catalog member deletion");

    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("process catalog deletion"),
        IncrementalFreshnessCycleOutcome::Processed(_)
    ));
    let state = edge_state(&db, "edge-catalog");
    assert_eq!(state.0, "stale");
    assert_ne!(state.1.as_deref(), Some("source-missing"));
}

#[test]
fn deleting_a_scene_revalidates_catalog_edges_affected_by_phase_anchor_nulling() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-anchor")?;
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, content)
             VALUES ('entry-phase', ?1, 'character', 'Character', '{}')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO codex_entry_phases
                (id, entry_id, anchor_node_id, label, created_at, updated_at)
             VALUES ('phase-1', 'entry-phase', 'scene-anchor', 'Phase', ?1, ?1)",
            [OCCURRED_AT],
        )?;
        seed_consumer_edge_for_source(
            conn,
            "consumer-catalog",
            "edge-catalog",
            &format!("project:codex-catalog:{PROJECT_ID}"),
            r#"["sha256:catalog-before-scene-delete"]"#,
        )?;
        seed_scene_change_with(
            conn,
            "scene-anchor",
            1,
            "delete",
            "sha256:before",
            "sha256:deleted",
            &serde_json::json!({ "normalizerVersion": "gdx-canonical-text/1" }),
        )?;
        conn.execute(
            "UPDATE change_events SET scene_id = NULL
              WHERE event_uid = 'canonical-scene-scene-anchor-1'",
            [],
        )?;
        conn.execute("DELETE FROM tree_nodes WHERE id = 'scene-anchor'", [])?;
        Ok(())
    })
    .expect("seed phase anchor FK side effect");

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("process scene deletion")
    else {
        panic!("scene deletion must process")
    };
    assert_eq!(summary.affected_edge_count, 1);
    let state = edge_state(&db, "edge-catalog");
    assert_eq!(state.0, "stale");
    assert_ne!(state.1.as_deref(), Some("source-missing"));
}

#[test]
fn batch_limit_is_canonical_sequence_bounded_and_reports_backlog() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        for sequence in 1..=33 {
            seed_scene_change(conn, "scene-target", sequence)?;
        }
        Ok(())
    })
    .expect("seed 33 canonical sequences");

    let first = run_incremental_freshness_cycle(&db).expect("first bounded batch");
    let IncrementalFreshnessCycleOutcome::Processed(first) = first else {
        panic!("first batch must process")
    };
    assert_eq!(first.through_sequence_inclusive, 32);
    assert!(first.has_more);

    let second = run_incremental_freshness_cycle(&db).expect("second bounded batch");
    let IncrementalFreshnessCycleOutcome::Processed(second) = second else {
        panic!("second batch must process")
    };
    assert_eq!(second.from_sequence_exclusive, 32);
    assert_eq!(second.through_sequence_inclusive, 33);
    assert!(!second.has_more);
    assert_completed_cursor_without_reservation(&db, 33);
}

fn assert_completed_cursor_without_reservation(db: &Database, acknowledged: i64) {
    db.with_conn(|conn| {
        let row: (
            i64,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
        ) = conn.query_row(
            "SELECT acknowledged_through_sequence, active_run_id,
                        reserved_through_sequence, lease_owner, lease_expires_at
                   FROM narrative_change_cursors
                  WHERE project_id = ?1",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(row, (acknowledged, None, None, None, None));
        Ok(())
    })
    .expect("cursor is acknowledged and released");
}

#[test]
fn expired_task_attempt_is_terminalized_and_resumed_once() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        seed_interrupted_freshness_run(conn, "interrupted-run", EPOCH_ID, 1)?;
        Ok(())
    })
    .expect("seed interrupted cycle");

    let outcome = run_incremental_freshness_cycle(&db).expect("resume interrupted cycle");
    assert!(matches!(
        outcome,
        IncrementalFreshnessCycleOutcome::Processed(_)
    ));
    assert_completed_cursor_without_reservation(&db, 1);
    db.with_conn(|conn| {
        let statuses = conn
            .prepare(
                "SELECT status FROM narrative_extraction_attempts
                  WHERE task_id = 'interrupted-task' ORDER BY attempt_number",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(statuses, vec!["failed", "completed"]);
        let running: i64 = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM narrative_extraction_runs WHERE status = 'running') +
               (SELECT COUNT(*) FROM narrative_extraction_tasks WHERE status = 'running') +
               (SELECT COUNT(*) FROM narrative_extraction_attempts WHERE status = 'running')",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(running, 0, "recovery must leave no durable running state");
        Ok(())
    })
    .expect("inspect recovered lifecycle");
}

#[test]
fn deterministic_failure_stops_after_three_attempts_with_a_lease_free_dead_letter() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge_with_read_set(
            conn,
            "consumer-target",
            "edge-target",
            "scene-target",
            r#"[{"not":"a-revision-token"}]"#,
        )?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed deterministic evaluation failure");

    for attempt in 1..=3 {
        let error = match run_incremental_freshness_cycle(&db) {
            Err(error) => error,
            Ok(outcome) => panic!("attempt {attempt} must fail closed, got {outcome:?}"),
        };
        assert!(
            error
                .to_string()
                .contains("NEX_DEPENDENCY_READ_SET_INVALID"),
            "attempt {attempt}: {error:#}"
        );
    }
    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("dead-letter cycle is idle"),
        IncrementalFreshnessCycleOutcome::Idle
    ));

    db.with_conn(|conn| {
        let run: (String, Option<String>) = conn.query_row(
            "SELECT status, terminal_reason_code
               FROM narrative_extraction_runs
              WHERE run_kind = 'freshness-evaluation'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            run,
            (
                "failed".to_string(),
                Some("NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED".to_string())
            )
        );
        let task: (String, i64, Option<String>, Option<String>) = conn.query_row(
            "SELECT status, attempt_count, lease_owner, lease_expires_at
               FROM narrative_extraction_tasks
              WHERE task_kind = 'incremental-freshness-batch'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(task, ("failed".to_string(), 3, None, None));
        let attempts: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_attempts",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(attempts, 3);
        let cursor: (i64, Option<String>, Option<String>, String) = conn.query_row(
            "SELECT acknowledged_through_sequence, lease_owner, lease_expires_at,
                    active_run_id
               FROM narrative_change_cursors WHERE project_id = ?1",
            [PROJECT_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(cursor.0, 0);
        assert_eq!(cursor.1, None);
        assert_eq!(cursor.2, None);
        assert!(!cursor.3.is_empty());
        Ok(())
    })
    .expect("inspect bounded dead-letter lifecycle");

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('project-other', 'Other')",
            [],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-other', 'project-other', 0, 'initial', ?1)",
            [OCCURRED_AT],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, version, updated_at)
             VALUES ('scene-other', 'project-other', 'scene', 'Other', '{}', 2, ?1)",
            [CURRENT_UPDATED_AT],
        )?;
        seed_scene_change_for_project(
            conn,
            "project-other",
            "scene-other",
            1,
            "update",
            "sha256:other-before",
            "sha256:other-after",
            &serde_json::json!({ "normalizerVersion": "gdx-canonical-text/1" }),
        )?;
        Ok(())
    })
    .expect("seed another project after dead-letter");
    let IncrementalFreshnessCycleOutcome::Processed(other) =
        run_incremental_freshness_cycle(&db).expect("other project remains runnable")
    else {
        panic!("dead-lettered project must not starve other projects")
    };
    assert_eq!(other.project_id, "project-other");
}

#[test]
fn invalid_minimum_object_key_is_terminally_held_without_starving_another_project() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-poison")?;
        seed_scene_change(conn, "scene-poison", 1)?;
        conn.execute(
            "UPDATE narrative_change_events
                SET object_key_json = '{\"kind\":\"outside-canonical-vocabulary\"}'
              WHERE project_id = ?1 AND canonical_sequence = 1",
            [PROJECT_ID],
        )?;

        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('project-other', 'Other')",
            [],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-other', 'project-other', 0, 'initial', ?1)",
            [OCCURRED_AT],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, version, updated_at)
             VALUES ('scene-other', 'project-other', 'scene', 'Other', '{}', 2, ?1)",
            [CURRENT_UPDATED_AT],
        )?;
        seed_scene_change_for_project(
            conn,
            "project-other",
            "scene-other",
            1,
            "update",
            "sha256:other-before",
            "sha256:other-after",
            &serde_json::json!({ "normalizerVersion": "gdx-canonical-text/1" }),
        )?;
        Ok(())
    })
    .expect("seed poison and healthy pending projects");

    for attempt in 1..=3 {
        let error = match run_incremental_freshness_cycle(&db) {
            Err(error) => error,
            Ok(outcome) => panic!("poison attempt {attempt} must fail closed, got {outcome:?}"),
        };
        assert!(
            error
                .to_string()
                .contains("NEX_CHANGE_FEED_OBJECT_KEY_UNSUPPORTED"),
            "poison attempt {attempt}: {error:#}"
        );
    }

    let IncrementalFreshnessCycleOutcome::Processed(other) =
        run_incremental_freshness_cycle(&db).expect("healthy project remains runnable")
    else {
        panic!("terminally held poison range must not starve the healthy project")
    };
    assert_eq!(other.project_id, "project-other");
    assert_eq!(other.through_sequence_inclusive, 1);

    db.with_conn(|conn| {
        let poison_run: (String, Option<String>) = conn.query_row(
            "SELECT status, terminal_reason_code
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'freshness-evaluation'",
            [PROJECT_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            poison_run,
            (
                "failed".to_string(),
                Some("NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED".to_string()),
            )
        );

        let poison_task: (String, i64, Option<String>, Option<String>) = conn.query_row(
            "SELECT task.status, task.attempt_count, task.lease_owner, task.lease_expires_at
               FROM narrative_extraction_tasks task
               JOIN narrative_extraction_runs run ON run.id = task.run_id
              WHERE run.project_id = ?1
                AND task.task_kind = 'incremental-freshness-batch'",
            [PROJECT_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(poison_task, ("failed".to_string(), 3, None, None));

        let poison_attempts: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_extraction_attempts attempt
               JOIN narrative_extraction_tasks task ON task.id = attempt.task_id
               JOIN narrative_extraction_runs run ON run.id = task.run_id
              WHERE run.project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(poison_attempts, 3);

        let poison_cursor: (
            i64,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = conn.query_row(
            "SELECT acknowledged_through_sequence, lease_owner, lease_expires_at,
                    reserved_through_sequence, active_run_id
               FROM narrative_change_cursors
              WHERE project_id = ?1
                AND consumer_id = 'narrative-incremental-freshness/v1'",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(
            poison_cursor.0, 0,
            "poison range must never be acknowledged"
        );
        assert_eq!(poison_cursor.1, None, "terminal hold must be lease-free");
        assert_eq!(poison_cursor.2, None, "terminal hold must be lease-free");
        assert_eq!(poison_cursor.3, Some(1));
        assert!(poison_cursor.4.is_some(), "terminal hold retains its Run");

        let healthy_cursor: (i64, Option<String>, Option<i64>) = conn.query_row(
            "SELECT acknowledged_through_sequence, active_run_id,
                    reserved_through_sequence
               FROM narrative_change_cursors
              WHERE project_id = 'project-other'
                AND consumer_id = 'narrative-incremental-freshness/v1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(healthy_cursor, (1, None, None));
        Ok(())
    })
    .expect("inspect poison hold and healthy acknowledgement");
}

#[test]
fn malformed_object_key_json_uses_the_bounded_terminal_hold_without_acknowledgement() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-poison")?;
        seed_scene_change(conn, "scene-poison", 1)?;
        // The production schema rejects new malformed JSON. Temporarily
        // bypass CHECKs to model an already-corrupt/legacy durable row that
        // the runtime must still bound instead of retrying before reservation.
        conn.execute_batch("PRAGMA ignore_check_constraints = ON")?;
        conn.execute(
            "UPDATE narrative_change_events
                SET object_key_json = ?1
              WHERE project_id = ?2 AND canonical_sequence = 1",
            params![r#"{"kind":"scene""#, PROJECT_ID],
        )?;
        conn.execute_batch("PRAGMA ignore_check_constraints = OFF")?;
        Ok(())
    })
    .expect("seed syntactically malformed object_key_json");

    for attempt in 1..=3 {
        let error = match run_incremental_freshness_cycle(&db) {
            Err(error) => error,
            Ok(outcome) => panic!("malformed attempt {attempt} must fail, got {outcome:?}"),
        };
        assert!(
            error.to_string().contains("invalid object_key_json"),
            "malformed attempt {attempt}: {error:#}"
        );
    }
    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("terminal hold makes the next cycle idle"),
        IncrementalFreshnessCycleOutcome::Idle
    ));

    db.with_conn(|conn| {
        let lifecycle: TerminalHoldLifecycle = conn.query_row(
            "SELECT run.status, run.terminal_reason_code,
                    task.status, task.attempt_count,
                    task.lease_owner, task.lease_expires_at,
                    cursor.acknowledged_through_sequence,
                    cursor.lease_owner, cursor.lease_expires_at,
                    cursor.reserved_through_sequence, cursor.active_run_id
               FROM narrative_extraction_runs run
               JOIN narrative_extraction_tasks task ON task.run_id = run.id
               JOIN narrative_change_cursors cursor
                 ON cursor.project_id = run.project_id
                AND cursor.active_run_id = run.id
              WHERE run.project_id = ?1
                AND run.run_kind = 'freshness-evaluation'
                AND task.task_kind = 'incremental-freshness-batch'",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                ))
            },
        )?;
        assert_eq!(lifecycle.0, "failed");
        assert_eq!(
            lifecycle.1.as_deref(),
            Some("NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED")
        );
        assert_eq!(lifecycle.2, "failed");
        assert_eq!(lifecycle.3, 3);
        assert_eq!((lifecycle.4, lifecycle.5), (None, None));
        assert_eq!(lifecycle.6, 0, "malformed range must remain unacknowledged");
        assert_eq!((lifecycle.7, lifecycle.8), (None, None));
        assert_eq!(lifecycle.9, Some(1));
        assert!(lifecycle.10.is_some(), "terminal hold retains its Run");

        let attempts: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_extraction_attempts attempt
               JOIN narrative_extraction_tasks task ON task.id = attempt.task_id
               JOIN narrative_extraction_runs run ON run.id = task.run_id
              WHERE run.project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(attempts, 3);
        Ok(())
    })
    .expect("inspect malformed Feed terminal hold");
}

#[test]
fn resumed_batch_rejects_a_missing_live_event_against_its_sealed_change_set() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-poison")?;
        seed_scene_change(conn, "scene-poison", 1)?;
        conn.execute(
            "UPDATE narrative_change_events
                SET object_key_json = '{\"kind\":\"outside-canonical-vocabulary\"}'
              WHERE project_id = ?1 AND canonical_sequence = 1",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed a deterministic first-attempt locator failure");

    let first = run_incremental_freshness_cycle(&db)
        .expect_err("the first Attempt must seal the range before locator failure");
    assert!(
        first
            .to_string()
            .contains("NEX_CHANGE_FEED_OBJECT_KEY_UNSUPPORTED"),
        "unexpected first failure: {first:#}"
    );

    db.with_conn(|conn| {
        let sealed_event_ids: String = conn.query_row(
            "SELECT event_ids_json
               FROM narrative_change_sets
              WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_ne!(sealed_event_ids, "[]");
        conn.execute(
            "DELETE FROM narrative_change_events
              WHERE project_id = ?1 AND canonical_sequence = 1",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("simulate a missing durable Feed row after reservation");

    for attempt in 2..=3 {
        let error = run_incremental_freshness_cycle(&db)
            .expect_err("resume must reject live Feed drift instead of acknowledging it");
        assert!(
            error
                .to_string()
                .contains("NEX_INCREMENTAL_FRESHNESS_CHANGE_FEED_PAGE_MISMATCH"),
            "resume attempt {attempt}: {error:#}"
        );
    }
    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("retry exhaustion holds the sealed range"),
        IncrementalFreshnessCycleOutcome::Idle
    ));

    db.with_conn(|conn| {
        let lifecycle: (String, i64, i64, Option<i64>, Option<String>) = conn.query_row(
            "SELECT task.status, task.attempt_count,
                    cursor.acknowledged_through_sequence,
                    cursor.reserved_through_sequence, cursor.active_run_id
               FROM narrative_extraction_tasks task
               JOIN narrative_extraction_runs run ON run.id = task.run_id
               JOIN narrative_change_cursors cursor
                 ON cursor.project_id = run.project_id
                AND cursor.active_run_id = run.id
              WHERE run.project_id = ?1
                AND task.task_kind = 'incremental-freshness-batch'",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(lifecycle.0, "failed");
        assert_eq!(lifecycle.1, 3);
        assert_eq!(lifecycle.2, 0, "a drifted range must never be acknowledged");
        assert_eq!(lifecycle.3, Some(1));
        assert!(lifecycle.4.is_some(), "terminal hold retains its Run");
        Ok(())
    })
    .expect("inspect the terminally held sealed range");
}

#[test]
fn resumed_batch_rejects_same_id_payload_replacement_against_its_sealed_change_set() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-poison")?;
        seed_scene_change(conn, "scene-poison", 1)?;
        conn.execute(
            "UPDATE narrative_change_events
                SET object_key_json = '{\"kind\":\"outside-canonical-vocabulary\"}'
              WHERE project_id = ?1 AND canonical_sequence = 1",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed a deterministic first-attempt locator failure");

    let first = run_incremental_freshness_cycle(&db)
        .expect_err("the first Attempt must seal the payload before locator failure");
    assert!(
        first
            .to_string()
            .contains("NEX_CHANGE_FEED_OBJECT_KEY_UNSUPPORTED"),
        "unexpected first failure: {first:#}"
    );

    db.with_conn(|conn| {
        let event_id_before: String = conn.query_row(
            "SELECT id FROM narrative_change_events
              WHERE project_id = ?1 AND canonical_sequence = 1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        conn.execute(
            "UPDATE narrative_change_events
                SET object_key_json = '{\"kind\":\"scene\",\"sceneId\":\"scene-poison\"}'
              WHERE project_id = ?1 AND canonical_sequence = 1",
            [PROJECT_ID],
        )?;
        let event_id_after: String = conn.query_row(
            "SELECT id FROM narrative_change_events
              WHERE project_id = ?1 AND canonical_sequence = 1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(event_id_after, event_id_before, "only the payload changed");
        Ok(())
    })
    .expect("replace the payload while retaining the sealed event ID");

    for attempt in 2..=3 {
        let error = run_incremental_freshness_cycle(&db)
            .expect_err("resume must reject payload drift instead of acknowledging it");
        assert!(
            error
                .to_string()
                .contains("NEX_INCREMENTAL_FRESHNESS_CHANGE_FEED_PAGE_MISMATCH"),
            "resume attempt {attempt}: {error:#}"
        );
    }
    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("retry exhaustion holds the sealed range"),
        IncrementalFreshnessCycleOutcome::Idle
    ));

    db.with_conn(|conn| {
        let lifecycle: (String, i64, i64, Option<i64>, Option<String>) = conn.query_row(
            "SELECT task.status, task.attempt_count,
                    cursor.acknowledged_through_sequence,
                    cursor.reserved_through_sequence, cursor.active_run_id
               FROM narrative_extraction_tasks task
               JOIN narrative_extraction_runs run ON run.id = task.run_id
               JOIN narrative_change_cursors cursor
                 ON cursor.project_id = run.project_id
                AND cursor.active_run_id = run.id
              WHERE run.project_id = ?1
                AND task.task_kind = 'incremental-freshness-batch'",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(lifecycle.0, "failed");
        assert_eq!(lifecycle.1, 3);
        assert_eq!(
            lifecycle.2, 0,
            "a drifted payload must never be acknowledged"
        );
        assert_eq!(lifecycle.3, Some(1));
        assert!(lifecycle.4.is_some(), "terminal hold retains its Run");
        Ok(())
    })
    .expect("inspect the terminally held payload-drift range");
}

#[test]
fn invalid_persisted_origin_enters_a_lease_free_retryable_hold_after_one_attempt() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-poison")?;
        seed_scene_change(conn, "scene-poison", 1)?;
        conn.execute_batch("PRAGMA ignore_check_constraints = ON")?;
        conn.execute(
            "UPDATE narrative_change_transactions
                SET origin = 'outside-origin-vocabulary'
              WHERE project_id = ?1",
            [PROJECT_ID],
        )?;
        conn.execute_batch("PRAGMA ignore_check_constraints = OFF")?;
        Ok(())
    })
    .expect("seed invalid persisted transaction origin");

    let error = run_incremental_freshness_cycle(&db)
        .expect_err("invalid persisted origin must fail its first Attempt");
    assert!(
        error
            .to_string()
            .contains("invalid persisted origin 'outside-origin-vocabulary'"),
        "unexpected transaction decode failure: {error:#}"
    );

    db.with_conn(|conn| {
        let lifecycle: RetryableHoldLifecycle = conn.query_row(
            "SELECT run.status,
                    task.status, task.attempt_count,
                    task.lease_owner, task.lease_expires_at,
                    attempt.status, attempt.failure_code, attempt.retry_disposition
               FROM narrative_extraction_runs run
               JOIN narrative_extraction_tasks task ON task.run_id = run.id
               JOIN narrative_extraction_attempts attempt ON attempt.task_id = task.id
              WHERE run.project_id = ?1
                AND run.run_kind = 'freshness-evaluation'
                AND task.task_kind = 'incremental-freshness-batch'",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )?;
        assert_eq!(lifecycle.0, "running");
        assert_eq!(lifecycle.1, "queued");
        assert_eq!(lifecycle.2, 1);
        assert_eq!((lifecycle.3, lifecycle.4), (None, None));
        assert_eq!(lifecycle.5, "failed");
        assert_eq!(
            lifecycle.6.as_deref(),
            Some("NEX_INCREMENTAL_FRESHNESS_RETRYABLE")
        );
        assert_eq!(lifecycle.7.as_deref(), Some("retryable"));

        let cursor: (
            i64,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = conn.query_row(
            "SELECT acknowledged_through_sequence, lease_owner, lease_expires_at,
                        reserved_through_sequence, active_run_id
                   FROM narrative_change_cursors
                  WHERE project_id = ?1
                    AND consumer_id = 'narrative-incremental-freshness/v1'",
            [PROJECT_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(
            cursor.0, 0,
            "invalid-origin range must remain unacknowledged"
        );
        assert_eq!((cursor.1, cursor.2), (None, None));
        assert_eq!(cursor.3, Some(1));
        assert!(cursor.4.is_some(), "retryable hold retains its active Run");
        Ok(())
    })
    .expect("inspect retryable transaction-decode lifecycle");
}

#[test]
fn cancelled_freshness_run_releases_its_range_for_a_new_run() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        seed_interrupted_freshness_run(conn, "cancelled-run", EPOCH_ID, 1)?;
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET status = 'cancelled', completed_at = datetime('now')
              WHERE id = 'cancelled-run'",
            [],
        )?;
        conn.execute(
            "UPDATE narrative_extraction_tasks
                SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                    heartbeat_at = NULL, completed_at = datetime('now')
              WHERE run_id = 'cancelled-run'",
            [],
        )?;
        Ok(())
    })
    .expect("seed cancelled Freshness reservation");

    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("reprocess cancelled range"),
        IncrementalFreshnessCycleOutcome::Processed(_)
    ));
    assert_completed_cursor_without_reservation(&db, 1);
    db.with_conn(|conn| {
        let old_run: String = conn.query_row(
            "SELECT status FROM narrative_extraction_runs WHERE id = 'cancelled-run'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_run, "cancelled");
        let old_attempt: (String, Option<String>) = conn.query_row(
            "SELECT status, failure_code FROM narrative_extraction_attempts
              WHERE id = 'interrupted-attempt'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            old_attempt,
            (
                "failed".to_string(),
                Some("NEX_INCREMENTAL_FRESHNESS_INTERRUPTED".to_string())
            )
        );
        Ok(())
    })
    .expect("cancelled lifecycle was closed before replay");
}

#[test]
fn generic_task_apis_cannot_take_over_the_system_owned_freshness_lifecycle() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        seed_interrupted_freshness_run(conn, "system-run", EPOCH_ID, 1)?;
        Ok(())
    })
    .expect("seed system-owned Freshness Run");

    let cancel = narrative_extraction_cancel_run(
        &db,
        RunRefPayload {
            run_id: "system-run".to_string(),
            project_id: PROJECT_ID.to_string(),
        },
    )
    .expect_err("generic cancel must be denied");
    assert!(cancel.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));

    let claim = narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "system-run".to_string(),
            project_id: PROJECT_ID.to_string(),
            lease_owner: "foreign-worker".to_string(),
            lease_duration_secs: Some(300),
            task_kinds: Some(vec!["incremental-freshness-batch".to_string()]),
        },
    )
    .expect_err("generic claim must be denied");
    assert!(claim.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));

    let finish = narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "system-run".to_string(),
            project_id: PROJECT_ID.to_string(),
            task_id: "interrupted-task".to_string(),
            attempt_id: "interrupted-attempt".to_string(),
            lease_owner: "dead-worker".to_string(),
            output_json: Some(serde_json::json!({ "forged": true })),
            artifacts: Vec::new(),
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: Vec::new(),
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .expect_err("generic finish must be denied");
    assert!(finish.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));

    let fail = narrative_extraction_fail_task(
        &db,
        FailTaskPayload {
            run_id: "system-run".to_string(),
            project_id: PROJECT_ID.to_string(),
            task_id: "interrupted-task".to_string(),
            attempt_id: "interrupted-attempt".to_string(),
            lease_owner: "dead-worker".to_string(),
            error_message: "forged".to_string(),
            output_json: None,
            requeue: Some(false),
        },
    )
    .expect_err("generic fail must be denied");
    assert!(fail.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));

    db.with_conn(|conn| {
        let run_status: String = conn.query_row(
            "SELECT status FROM narrative_extraction_runs WHERE id = 'system-run'",
            [],
            |row| row.get(0),
        )?;
        let attempt_status: String = conn.query_row(
            "SELECT status FROM narrative_extraction_attempts
              WHERE id = 'interrupted-attempt'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(run_status, "running");
        assert_eq!(attempt_status, "running");
        Ok(())
    })
    .expect("generic APIs left system lifecycle untouched");
}

fn seed_interrupted_freshness_run(
    conn: &Connection,
    run_id: &str,
    epoch_id: &str,
    through_sequence: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, started_at, run_kind, consumer_id,
             semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'freshness-evaluation', '{}', '{}', ?1, 'running', '{}',
                 ?3, ?3, 'freshness-evaluation',
                 'narrative-incremental-freshness/v1', ?4, ?1)",
        params![run_id, PROJECT_ID, OCCURRED_AT, epoch_id],
    )?;
    let event_ids = conn
        .prepare(
            "SELECT id FROM narrative_change_events
              WHERE project_id = ?1 AND canonical_sequence > 0
                AND canonical_sequence <= ?2
              ORDER BY canonical_sequence, event_ordinal, id",
        )?
        .query_map(params![PROJECT_ID, through_sequence], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        !event_ids.is_empty(),
        "interrupted fixture needs Feed events"
    );
    let affected_objects = Vec::<String>::new();
    let feed_page_digest = fixture_feed_page_digest(conn, 0, through_sequence)?;
    let sealed = serde_json::json!({
        "projectId": PROJECT_ID,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": through_sequence,
        "eventIds": event_ids,
        "affectedObjects": affected_objects,
        "feedPageDigest": feed_page_digest,
    });
    let digest = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&sealed)?))
    );
    conn.execute(
        "UPDATE narrative_extraction_runs
            SET spec_json = ?1, spec_digest = ?2
          WHERE id = ?3",
        params![serde_json::to_string(&sealed)?, digest, run_id],
    )?;
    let change_set_id = format!("{run_id}:change-set");
    conn.execute(
        "INSERT INTO narrative_change_sets
            (id, project_id, from_sequence_exclusive, through_sequence_inclusive,
             event_ids_json, affected_objects_json, digest, created_at)
         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7)",
        params![
            change_set_id,
            PROJECT_ID,
            through_sequence,
            serde_json::to_string(&event_ids)?,
            serde_json::to_string(&affected_objects)?,
            digest,
            OCCURRED_AT,
        ],
    )?;
    let task_input = serde_json::to_string(&serde_json::json!({
        "changeSetId": change_set_id,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": through_sequence,
    }))?;
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority, attempt_count,
             lease_owner, lease_expires_at, heartbeat_at, created_at, started_at, version)
         VALUES ('interrupted-task', ?1, 'incremental-freshness-batch', 'running', ?2,
                 100, 1, 'dead-worker', '2000-01-01T00:00:00.000Z',
                 '2000-01-01T00:00:00.000Z', ?3, ?3, 0)",
        params![run_id, task_input, OCCURRED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_attempts
            (id, task_id, attempt_number, status, started_at)
         VALUES ('interrupted-attempt', 'interrupted-task', 1, 'running', ?1)",
        [OCCURRED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_cursors
            (project_id, consumer_id, acknowledged_through_sequence, lease_owner,
             lease_expires_at, updated_at, semantic_epoch_id,
             reserved_through_sequence, active_run_id)
         VALUES (?1, 'narrative-incremental-freshness/v1', 0, 'dead-worker',
                 '2000-01-01T00:00:00.000Z', ?2, ?3, ?4, ?5)",
        params![PROJECT_ID, OCCURRED_AT, epoch_id, through_sequence, run_id],
    )?;
    Ok(())
}

fn fixture_feed_page_digest(
    conn: &Connection,
    after_sequence: i64,
    through_sequence_inclusive: i64,
) -> anyhow::Result<String> {
    let mut statement = conn.prepare(
        "SELECT json_array(
                  event.id, event.project_id, event.transaction_id,
                  event.canonical_change_event_uid, event.canonical_sequence,
                  event.event_ordinal, event.object_key_json, event.change_kind,
                  event.mutation_kind, event.before_version, event.before_digest,
                  event.after_version, event.after_digest,
                  event.changed_paths_json, event.text_impact_json,
                  event.structural_impact_json, event.occurred_at,
                  feed_transaction.id, feed_transaction.project_id,
                  feed_transaction.request_id, feed_transaction.source_domain,
                  feed_transaction.source_change_event_uid,
                  feed_transaction.source_change_event_sequence,
                  feed_transaction.cause_kind, feed_transaction.origin,
                  feed_transaction.original_transaction_id,
                  feed_transaction.commit_id, feed_transaction.journal_id,
                  feed_transaction.undo_journal_id,
                  feed_transaction.application_ids_json,
                  feed_transaction.payload_digest, feed_transaction.created_at
                )
           FROM narrative_change_events event
           LEFT JOIN narrative_change_transactions feed_transaction
             ON feed_transaction.project_id = event.project_id
            AND feed_transaction.id = event.transaction_id
          WHERE event.project_id = ?1
            AND event.canonical_sequence > ?2
            AND event.canonical_sequence <= ?3
          ORDER BY event.canonical_sequence, event.event_ordinal, event.id",
    )?;
    let raw_rows = statement
        .query_map(
            params![PROJECT_ID, after_sequence, through_sequence_inclusive],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|raw_row| serde_json::from_str::<Value>(&raw_row))
        .collect::<Result<Vec<_>, _>>()?;
    anyhow::ensure!(!raw_rows.is_empty(), "fixture Feed page must not be empty");
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&Value::Array(raw_rows))?))
    ))
}

#[test]
fn stale_epoch_reservation_is_superseded_without_skipping_the_range() {
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        seed_interrupted_freshness_run(conn, "stale-run", EPOCH_ID, 1)?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-new', ?1, 1, 'restore', ?2)",
            params![PROJECT_ID, CURRENT_UPDATED_AT],
        )?;
        Ok(())
    })
    .expect("seed stale Epoch reservation");

    let outcome = run_incremental_freshness_cycle(&db).expect("replace stale reservation");
    assert!(matches!(
        outcome,
        IncrementalFreshnessCycleOutcome::Processed(_)
    ));
    assert_completed_cursor_without_reservation(&db, 1);
    db.with_conn(|conn| {
        let stale_status: String = conn.query_row(
            "SELECT status FROM narrative_extraction_runs WHERE id = 'stale-run'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(stale_status, "superseded");
        let current_epoch: String = conn.query_row(
            "SELECT semantic_epoch_id FROM narrative_consumer_freshness
              WHERE consumer_key = 'consumer-target'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(current_epoch, "epoch-new");
        Ok(())
    })
    .expect("stale Run cannot publish into the new Epoch");
}

#[test]
fn concurrent_triggers_coalesce_to_one_publication() {
    let db = std::sync::Arc::new(fixture_db());
    db.with_conn(|conn| {
        seed_scene(conn, "scene-target")?;
        seed_consumer_edge(conn, "consumer-target", "edge-target", "scene-target")?;
        seed_scene_change(conn, "scene-target", 1)?;
        Ok(())
    })
    .expect("seed concurrent trigger fixture");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let handles = (0..2)
        .map(|_| {
            let db = std::sync::Arc::clone(&db);
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                run_incremental_freshness_cycle(&db)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().expect("worker thread").expect("cycle"))
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, IncrementalFreshnessCycleOutcome::Processed(_)))
            .count(),
        1
    );
    assert_eq!(
        count_rows(&db, "narrative_maintenance_finding_observations"),
        1
    );
    assert_completed_cursor_without_reservation(&db, 1);
}
