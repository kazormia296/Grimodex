use std::{io::Read, path::Path};

use flate2::read::GzDecoder;
use grimodex_db::Database;
use rusqlite::Connection;

fn columns(conn: &Connection, table: &str) -> Vec<String> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .expect("table metadata")
        .query_map([], |row| row.get(1))
        .expect("column rows")
        .collect::<rusqlite::Result<_>>()
        .expect("column names")
}

#[test]
fn nir1_schema_owns_only_rebuildable_vectors_and_explicit_producer_identity() {
    let db = Database::new(Path::new(":memory:")).expect("current schema");
    db.migrate().expect("create current schema");
    db.with_conn(|conn| {
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))?,
            35
        );
        let metadata = columns(conn, "narrative_semantic_index_metadata");
        assert!(metadata.contains(&"producer_id".into()));
        assert!(metadata.contains(&"producer_version".into()));
        assert_eq!(
            columns(conn, "narrative_nir1_chronicle_vectors"),
            [
                "project_id",
                "revision_id",
                "generation",
                "envelope_digest",
                "statement_digest",
                "serializer_ref",
                "model_id",
                "artifact_sha256",
                "tokenizer_sha256",
                "embedding_dim",
                "chunker_version",
                "audit_operation_id",
                "audit_execution_id",
                "embedding",
            ]
        );
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("schema assertions");
}

#[test]
fn nir1_upgrade_preserves_original_revision_and_decision_history() {
    let path = std::env::temp_dir().join(format!("nir1-upgrade-{}.db", uuid::Uuid::new_v4()));
    let mut bytes = Vec::new();
    GzDecoder::new(include_bytes!("support/nir1-reviewed-child-cold.db.gz").as_slice())
        .read_to_end(&mut bytes)
        .expect("normal cold bytes");
    std::fs::write(&path, bytes).expect("private upgrade copy");
    fn history(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT id || reconciliation_envelope_json FROM narrative_proposal_revisions UNION ALL SELECT id || decision_json FROM narrative_proposal_decisions ORDER BY 1")
            .expect("history query").query_map([],|r|r.get(0)).expect("history rows")
            .collect::<rusqlite::Result<_>>().expect("original history")
    }
    let before = history(&Connection::open(&path).expect("old schema"));
    let db = Database::new(&path).expect("schema upgrade");
    db.migrate().expect("upgrade old schema");
    db.migrate().expect("idempotent second migration");
    db.with_conn(|conn| {
        // A prerelease schema-35 marker can predate these physical indexes.
        // Exercise both missing and wrong-shaped indexes with real history.
        conn.execute_batch(
            "DROP INDEX idx_narrative_tasks_run_kind_status;
             DROP INDEX idx_narrative_attempts_task_number_status;
             CREATE INDEX idx_narrative_attempts_task_number_status
               ON narrative_extraction_attempts(task_id) WHERE status='completed';
             DROP INDEX idx_narrative_artifacts_run_task_attempt_kind;
             CREATE INDEX idx_narrative_artifacts_run_task_attempt_kind
               ON narrative_extraction_artifacts(artifact_kind,run_id);",
        )?;
        assert!(!grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("simulate interrupted prerelease index installation");
    db.migrate().expect("repair current-schema lookup indexes");
    let schema_cookie = db
        .with_conn(|conn| {
            assert!(
                grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?
            );
            Ok(conn.pragma_query_value(None, "schema_version", |r| r.get::<_, i64>(0))?)
        })
        .expect("repaired schema");
    db.migrate().expect("healthy current-schema open");
    db.with_conn(|conn| {
        assert_eq!(before,history(conn));
        assert_eq!(schema_cookie,conn.pragma_query_value(None,"schema_version",|r|r.get::<_,i64>(0))?);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM narrative_nir1_chronicle_vectors",[],|r|r.get::<_,i64>(0))?,0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM narrative_semantic_index_metadata WHERE producer_id IS NOT NULL",[],|r|r.get::<_,i64>(0))?,0);
        Ok(())
    }).expect("preserved original authorities");
    drop(db);
    let _ = std::fs::remove_file(path);
}
