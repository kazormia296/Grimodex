//! Gate A2 release-shaped migration fixtures.
//!
//! These tests stamp the last *public* Release marker (v2.0.10 / Schema 2) on
//! the published seed SQL — not the rolling PREVIOUS_COMPATIBLE_* bookkeeping
//! constant — so the shadow migration path proves the real user upgrade route.

#[path = "support/release_schema_fixture.rs"]
mod release_schema_fixture;

use std::fs;

use grimodex_core::{LAST_PUBLIC_RELEASE_SCHEMA_VERSION, SCHEMA_VERSION};
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};
use grimodex_db::Database;
use serde_json::Value;

use release_schema_fixture::{
    assert_previous_release_fixture_shape, assert_previous_release_snapshot_rows,
    assert_release_fixture_rows, latest_migration_snapshot, seed_previous_release_workspace,
    temp_workspace,
};

fn rebuild_table_for_v40(
    conn: &rusqlite::Connection,
    table: &str,
    fk_replacements: &[(&str, &str)],
) -> anyhow::Result<()> {
    let original_sql: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    let columns_start = original_sql
        .find('(')
        .ok_or_else(|| anyhow::anyhow!("table DDL for {table} has no columns"))?;
    let legacy_table = format!("{table}_v40_fixture");
    let mut legacy_sql = format!(
        "CREATE TABLE \"{legacy_table}\"{}",
        &original_sql[columns_start..]
    );
    for (current_fk, legacy_fk) in fk_replacements {
        anyhow::ensure!(original_sql.matches(current_fk).count() == 1);
        legacy_sql = legacy_sql.replacen(current_fk, legacy_fk, 1);
    }

    let indexes = {
        let mut statement = conn.prepare(
            "SELECT sql FROM sqlite_master
              WHERE type='index' AND tbl_name=?1 AND sql IS NOT NULL ORDER BY name",
        )?;
        let indexes = statement
            .query_map([table], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        indexes
    };
    let columns = {
        let mut statement = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        columns
    };
    let column_list = columns
        .iter()
        .map(|column| format!("\"{}\"", column.replace('\"', "\"\"")))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&legacy_sql)?;
    conn.execute_batch(&format!(
        "INSERT INTO \"{legacy_table}\" (rowid, {column_list})
         SELECT rowid, {column_list} FROM \"{table}\";
         DROP TABLE \"{table}\";
         ALTER TABLE \"{legacy_table}\" RENAME TO \"{table}\";"
    ))?;
    for index in indexes {
        conn.execute_batch(&index)?;
    }
    Ok(())
}

fn shape_populated_v40_workspace(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    let triggers = {
        let mut statement = conn.prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE type='trigger' AND sql IS NOT NULL ORDER BY name",
        )?;
        let triggers = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        triggers
    };
    conn.execute_batch("PRAGMA foreign_keys=OFF;")?;
    for (name, _) in &triggers {
        conn.execute_batch(&format!("DROP TRIGGER \"{}\";", name.replace('\"', "\"\"")))?;
    }

    rebuild_table_for_v40(
        conn,
        "codex_entries",
        &[(
            "REFERENCES chat_messages(id) ON DELETE RESTRICT",
            "REFERENCES chat_messages(id) ON DELETE SET NULL",
        )],
    )?;
    rebuild_table_for_v40(
        conn,
        "snippets",
        &[(
            "REFERENCES chat_messages(id) ON DELETE RESTRICT",
            "REFERENCES chat_messages(id) ON DELETE SET NULL",
        )],
    )?;
    rebuild_table_for_v40(
        conn,
        "nir1_chat_input_captures",
        &[
            (
                "REFERENCES projects(id) ON DELETE RESTRICT",
                "REFERENCES projects(id) ON DELETE CASCADE",
            ),
            (
                "REFERENCES chat_sessions(id) ON DELETE RESTRICT",
                "REFERENCES chat_sessions(id) ON DELETE CASCADE",
            ),
            (
                "REFERENCES chat_messages(id) ON DELETE RESTRICT",
                "REFERENCES chat_messages(id) ON DELETE CASCADE",
            ),
        ],
    )?;

    for (name, sql) in triggers {
        if !matches!(
            name.as_str(),
            "nir1_chat_input_capture_project_delete"
                | "nir1_chat_input_capture_session_delete"
                | "nir1_chat_input_capture_message_delete"
                | "chat_message_source_provenance_delete"
        ) {
            conn.execute_batch(&sql)?;
        }
    }
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA user_version=40;")?;
    let schema_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let (capture_cascades, source_set_nulls, legacy_triggers): (i64, i64, i64) = conn.query_row(
        "SELECT
            (SELECT count(*) FROM pragma_foreign_key_list('nir1_chat_input_captures')
              WHERE on_delete='CASCADE'
                AND (\"from\" IN ('project_id','chat_session_id','message_id'))),
            (SELECT count(*) FROM pragma_foreign_key_list('codex_entries')
              WHERE \"from\"='source_chat_message_id' AND on_delete='SET NULL')
            +
            (SELECT count(*) FROM pragma_foreign_key_list('snippets')
              WHERE \"from\"='source_chat_message_id' AND on_delete='SET NULL'),
            (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
                'nir1_chat_input_capture_project_delete',
                'nir1_chat_input_capture_session_delete',
                'nir1_chat_input_capture_message_delete',
                'chat_message_source_provenance_delete'))",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    anyhow::ensure!(schema_version == 40);
    anyhow::ensure!(capture_cascades == 3);
    anyhow::ensure!(source_set_nulls == 2);
    anyhow::ensure!(legacy_triggers == 0);
    Ok(())
}

#[test]
fn previous_release_shaped_database_migrates_and_preserves_rows() {
    assert_eq!(
        LAST_PUBLIC_RELEASE_SCHEMA_VERSION, 2,
        "the published v2.0.10 fixture must remain the public migration floor"
    );
    assert_eq!(
        SCHEMA_VERSION, 41,
        "Gate C1 migration target was SCHEMA 22; SCHEMA 23-41 (Gate C2/D1/C2A/NIR-1/NIR-1 current Human capture/retirement) \
         migrate further on top -- this guard exists so the next schema bump \
         revisits this fixture too"
    );
    let workspace = temp_workspace("release-shaped");
    let db_path = seed_previous_release_workspace(&workspace);
    assert_previous_release_fixture_shape(&db_path);

    let outcome =
        migration_supervisor::open_or_migrate_workspace_db(&workspace).expect("shadow migrate");

    match outcome {
        WorkspaceOpenDbOutcome::Migrated {
            from_schema,
            to_schema,
            opened,
            receipt_path,
        } => {
            assert_eq!(from_schema, LAST_PUBLIC_RELEASE_SCHEMA_VERSION);
            assert_eq!(to_schema, SCHEMA_VERSION);
            assert!(receipt_path.exists(), "receipt should be written");
            let receipt: Value = serde_json::from_str(
                &fs::read_to_string(&receipt_path).expect("read migration receipt"),
            )
            .expect("parse migration receipt");
            assert_eq!(
                receipt["fromSchema"],
                Value::from(LAST_PUBLIC_RELEASE_SCHEMA_VERSION)
            );
            assert_eq!(receipt["toSchema"], Value::from(SCHEMA_VERSION));
            drop(opened);
        }
        other => panic!("expected Migrated for previous-release fixture, got {other:?}"),
    }

    let snapshot_path = latest_migration_snapshot(&workspace);
    let manifest_path = snapshot_path.with_extension("json");
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path).expect("read migration snapshot manifest"),
    )
    .expect("parse migration snapshot manifest");
    assert_eq!(
        manifest["sourceSchemaVersion"],
        Value::from(LAST_PUBLIC_RELEASE_SCHEMA_VERSION)
    );
    assert_eq!(manifest["targetSchemaVersion"], Value::from(SCHEMA_VERSION));

    assert_release_fixture_rows(&db_path);
}

#[test]
fn populated_v40_capture_rows_survive_public_shadow_migration() -> anyhow::Result<()> {
    let workspace = temp_workspace("v40-capture-shadow");
    let db_path = workspace.join("grimodex.db");
    let db = Database::new(&db_path)?;
    db.migrate()?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO chat_sessions(id,project_id,title)
             VALUES ('shadow-v40-session','default-project','v40 fixture')",
            [],
        )?;
        conn.execute(
            "INSERT INTO chat_messages(id,session_id,role,content,created_at)
             VALUES ('shadow-v40-message','shadow-v40-session','user','captured body',
                     '2026-09-26T10:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO codex_entries(id,project_id,type,name,source_chat_message_id)
             VALUES ('shadow-v40-codex','default-project','character','v40 source',
                     'shadow-v40-message')",
            [],
        )?;
        conn.execute(
            "INSERT INTO snippets(id,project_id,title,content,source_chat_message_id)
             VALUES ('shadow-v40-snippet','default-project','v40 source','{}',
                     'shadow-v40-message')",
            [],
        )?;
        Ok(())
    })?;
    let version = grimodex_db::nir1_generation::bind_human_message(
        &db,
        "default-project",
        "shadow-v40-session",
        "shadow-v40-message",
        1_790_000_000_000,
    )?;
    let digest = format!("sha256:{}", "a".repeat(64));
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO nir1_chat_input_captures
                (capture_id,project_id,chat_session_id,scene_id,submission_id,
                 submission_digest,message_id,message_version_id,owner_json,state,created_at_ms)
             VALUES ('shadow-v40-capture','default-project','shadow-v40-session',
                     'shadow-v40-scene','shadow-v40-submission',?1,
                     'shadow-v40-message',?2,'{}','current',?3)",
            rusqlite::params![digest, version.id, version.created_at_ms],
        )?;
        conn.execute(
            "INSERT INTO nir1_chat_input_submission_keys
                (submission_id,capture_id,submission_digest,created_at_ms)
             VALUES ('shadow-v40-submission','shadow-v40-capture',?1,?2)",
            rusqlite::params![digest, version.created_at_ms],
        )?;
        shape_populated_v40_workspace(conn)
    })?;
    drop(db);

    let opened = match migration_supervisor::open_or_migrate_workspace_db(&workspace)? {
        WorkspaceOpenDbOutcome::Migrated {
            from_schema,
            to_schema,
            opened,
            receipt_path,
        } => {
            assert_eq!(from_schema, 40);
            assert_eq!(to_schema, SCHEMA_VERSION);
            assert!(receipt_path.exists());
            opened
        }
        other => panic!("expected v40 shadow migration, got {other:?}"),
    };
    opened.database.with_conn(|conn| {
        let schema_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        assert_eq!(schema_version, SCHEMA_VERSION);
        let capture: (String, String, String, String, String) = conn.query_row(
            "SELECT capture_id,submission_id,submission_digest,message_id,message_version_id
               FROM nir1_chat_input_captures WHERE capture_id='shadow-v40-capture'",
            [],
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
            capture,
            (
                "shadow-v40-capture".to_string(),
                "shadow-v40-submission".to_string(),
                digest.clone(),
                "shadow-v40-message".to_string(),
                version.id.clone(),
            )
        );
        let tombstone: (String, String, String, i64) = conn.query_row(
            "SELECT submission_id,capture_id,submission_digest,created_at_ms
               FROM nir1_chat_input_submission_keys
              WHERE submission_id='shadow-v40-submission'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(
            tombstone,
            (
                "shadow-v40-submission".to_string(),
                "shadow-v40-capture".to_string(),
                digest,
                version.created_at_ms,
            )
        );
        let source_refs: (Option<String>, Option<String>) = conn.query_row(
            "SELECT
                (SELECT source_chat_message_id FROM codex_entries WHERE id='shadow-v40-codex'),
                (SELECT source_chat_message_id FROM snippets WHERE id='shadow-v40-snippet')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            source_refs,
            (
                Some("shadow-v40-message".to_string()),
                Some("shadow-v40-message".to_string()),
            )
        );
        let fk_violations: i64 =
            conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        assert_eq!(fk_violations, 0);
        Ok(())
    })?;
    Ok(())
}

#[test]
fn committed_wal_frames_are_materialized_into_migration_snapshot() {
    let workspace = temp_workspace("wal-snapshot");
    let db_path = seed_previous_release_workspace(&workspace);
    assert_previous_release_fixture_shape(&db_path);
    assert!(
        db_path.with_extension("db-wal").exists(),
        "fixture setup should leave committed frames in the WAL sidecar"
    );

    let outcome =
        migration_supervisor::open_or_migrate_workspace_db(&workspace).expect("shadow migrate");
    match outcome {
        WorkspaceOpenDbOutcome::Migrated { opened, .. } => drop(opened),
        other => panic!("expected Migrated for dirty-WAL fixture, got {other:?}"),
    }

    let snapshot_path = latest_migration_snapshot(&workspace);
    assert_previous_release_snapshot_rows(&snapshot_path);
    assert_release_fixture_rows(&db_path);
}
