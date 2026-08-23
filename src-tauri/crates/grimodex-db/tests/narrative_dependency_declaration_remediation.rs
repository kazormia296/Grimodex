//! Regression contract for D1 transaction and head-integrity boundaries.
//!
//! This target is intentionally separate from the original D1 RED contract:
//! it specifies the remediation required after the first implementation was
//! rejected for trusting a corrupt head, accepting autocommit `_in_tx` calls,
//! and leaving a transaction open when COMMIT itself failed.

use std::path::Path;

use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_db::narrative_extraction::{
    read_active_dependency_declaration_set, write_dependency_declaration_set,
    write_dependency_declaration_set_in_tx, DependencyDeclaration, DependencyDeclarationSetRequest,
};
use grimodex_db::Database;
use rusqlite::params;

const PROJECT_ID: &str = "d1-remediation-project";
const CONSUMER_KIND: &str = "proposal-revision";
const CONSUMER_KEY: &str = "revision-remediation";
const CREATED_AT: &str = "2026-08-24T00:00:00.000Z";

fn migrated_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'D1 remediation fixture')",
            [PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed project");
    db
}

fn declaration(source: &str) -> DependencyDeclaration {
    DependencyDeclaration {
        source_object_identity: source.to_owned(),
        role: DependencyRole::DirectEvidence,
        selector: DependencySelector::WholeSource,
    }
}

fn request(
    project_id: &str,
    producer_id: &str,
    producer_generation: i64,
    expected_head_version: i64,
) -> DependencyDeclarationSetRequest {
    DependencyDeclarationSetRequest {
        project_id: project_id.to_owned(),
        consumer_kind: CONSUMER_KIND.to_owned(),
        consumer_key: CONSUMER_KEY.to_owned(),
        producer_id: producer_id.to_owned(),
        producer_generation,
        expected_head_version,
        declarations: vec![declaration("project:scene:remediation")],
        created_at: CREATED_AT.to_owned(),
    }
}

fn row_counts(db: &Database) -> (i64, i64, i64) {
    db.with_conn(|conn| {
        Ok::<_, anyhow::Error>((
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_declaration_sets",
                [],
                |row| row.get(0),
            )?,
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_declaration_entries",
                [],
                |row| row.get(0),
            )?,
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_declaration_heads",
                [],
                |row| row.get(0),
            )?,
        ))
    })
    .expect("count D1 rows")
}

#[test]
fn corrupt_head_coherence_disables_v2_read_and_exact_replay() {
    for (label, head_update, replay_request) in [
        (
            "producer-id",
            "UPDATE narrative_dependency_declaration_heads
                SET producer_id = 'producer-corrupt'",
            request(PROJECT_ID, "producer-corrupt", 1, 0),
        ),
        (
            "producer-generation",
            "UPDATE narrative_dependency_declaration_heads
                SET producer_generation = 2",
            request(PROJECT_ID, "producer-a", 2, 0),
        ),
        (
            "version",
            "UPDATE narrative_dependency_declaration_heads
                SET version = 0",
            request(PROJECT_ID, "producer-a", 1, 0),
        ),
    ] {
        let db = migrated_db();
        let initial =
            write_dependency_declaration_set(&db, request(PROJECT_ID, "producer-a", 1, 0))
                .expect("write initial sealed set");
        db.with_conn(|conn| {
            // SCHEMA33 correctly rejects version < 1.  Temporarily bypass
            // CHECK enforcement only to model an on-disk corruption fixture.
            conn.execute_batch("PRAGMA ignore_check_constraints = ON")?;
            conn.execute(head_update, [])?;
            conn.execute_batch("PRAGMA ignore_check_constraints = OFF")?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at)
                 VALUES ('v1-remediation-edge', ?1, ?2, ?3, 'project:scene:v1', '[]', ?4)",
                params![PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY, CREATED_AT],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt head and retain V1 fixture");

        assert!(
            read_active_dependency_declaration_set(&db, PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY)
                .expect("read corrupt head")
                .is_none(),
            "{label} corruption must disable V2 active reads"
        );
        let error = write_dependency_declaration_set(&db, replay_request)
            .expect_err("corrupt head must not forge an exact replay receipt");
        assert!(
            error
                .to_string()
                .contains("NEX_DECLARATION_HEAD_INCOHERENT"),
            "{label} replay error must identify head incoherence: {error}"
        );
        assert_eq!(
            row_counts(&db),
            (1, 1, 1),
            "{label} replay must not append rows"
        );
        let v1_count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_edges
                      WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
                    params![PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY],
                    |row| row.get(0),
                )?)
            })
            .expect("count V1 fallback edge");
        assert_eq!(v1_count, 1, "{label} corruption must leave V1 available");
        assert_eq!(initial.head_version, 1);
    }
}

#[test]
fn in_tx_writer_requires_a_caller_owned_transaction() {
    let db = migrated_db();
    let error = db
        .with_conn(|conn| {
            write_dependency_declaration_set_in_tx(conn, request(PROJECT_ID, "producer-a", 1, 0))
        })
        .expect_err("_in_tx must reject autocommit connections");
    assert!(error
        .to_string()
        .contains("NEX_DECLARATION_TRANSACTION_REQUIRED"));
    db.with_conn(|conn| {
        assert!(conn.is_autocommit());
        Ok::<_, anyhow::Error>(())
    })
    .expect("inspect autocommit rejection");
    assert_eq!(row_counts(&db), (0, 0, 0));
}

#[test]
fn overflow_and_post_insert_cas_failure_leave_no_partial_rows() {
    let db = migrated_db();
    let initial = write_dependency_declaration_set(&db, request(PROJECT_ID, "producer-a", 1, 0))
        .expect("write initial set for overflow");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_dependency_declaration_heads
                SET version = ?1
              WHERE project_id = ?2 AND consumer_kind = ?3 AND consumer_key = ?4",
            params![i64::MAX, PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("force head version overflow");
    let overflow =
        write_dependency_declaration_set(&db, request(PROJECT_ID, "producer-b", 2, i64::MAX))
            .expect_err("head version overflow must fail");
    assert!(overflow
        .to_string()
        .contains("NEX_DECLARATION_HEAD_VERSION_OVERFLOW"));
    assert_eq!(row_counts(&db), (1, 1, 1));

    let db = migrated_db();
    let initial = write_dependency_declaration_set(&db, request(PROJECT_ID, "producer-a", 1, 0))
        .expect("write initial set for CAS");
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER d1_remediation_head_race
                AFTER INSERT ON narrative_dependency_declaration_sets
                BEGIN
                    UPDATE narrative_dependency_declaration_heads
                       SET producer_generation = NEW.producer_generation
                     WHERE project_id = NEW.project_id
                       AND consumer_kind = NEW.consumer_kind
                       AND consumer_key = NEW.consumer_key;
                END;",
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("install CAS race trigger");
    let cas = write_dependency_declaration_set(
        &db,
        request(PROJECT_ID, "producer-b", 2, initial.head_version),
    )
    .expect_err("post-insert CAS failure must fail");
    assert!(cas.to_string().contains("NEX_DECLARATION_HEAD_CAS_FAILED"));
    assert_eq!(row_counts(&db), (1, 1, 1));
}

#[test]
fn deferred_commit_failure_rolls_back_and_restores_autocommit() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("defer foreign-key checks for commit failure fixture");

    let error =
        write_dependency_declaration_set(&db, request("missing-project", "producer-a", 1, 0))
            .expect_err("deferred project FK must fail at COMMIT");
    assert!(error.to_string().contains("FOREIGN KEY"));
    db.with_conn(|conn| {
        assert!(
            conn.is_autocommit(),
            "failed COMMIT must not leave a zombie transaction"
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("inspect post-COMMIT connection state");
    assert_eq!(row_counts(&db), (0, 0, 0));
}
