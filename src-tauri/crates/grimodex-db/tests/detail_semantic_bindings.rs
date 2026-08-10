use grimodex_db::project_snapshots::{
    apply_project_snapshot_restore, create_project_snapshot, ApplyProjectSnapshotRestorePayload,
    CreateProjectSnapshotPayload, RestoreScope, SnapshotInsertMode, SnapshotInsertPlan,
    SnapshotRestoreTable,
};
use grimodex_db::Database;
use rusqlite::{params, Connection, OptionalExtension};

const RELEASED_SCHEMA_VERSION: i32 = 3;
const DETAIL_BINDING_SCHEMA_VERSION: i32 = 4;
const BINDING_TABLE: &str = "codex_detail_semantic_bindings";

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(true),
    )
    .optional()
    .map(|value| value.unwrap_or(false))
}

fn migrated_database() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db
}

fn seed_projects_and_definitions(db: &Database) {
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES
                 ('binding-project-a', 'Project A'),
                 ('binding-project-b', 'Project B');
             INSERT INTO codex_types (id, project_id, slug, label) VALUES
                 ('binding-type-a', 'binding-project-a', 'binding-character', 'Character'),
                 ('binding-type-b', 'binding-project-b', 'binding-character', 'Character');
             INSERT INTO codex_detail_definitions
                 (id, project_id, type_slug, name, field_type)
             VALUES
                 ('binding-definition-a', 'binding-project-a', 'binding-character', 'Role', 'text'),
                 ('binding-definition-b', 'binding-project-b', 'binding-character', 'Role', 'text');",
        )?;
        Ok(())
    })
    .expect("seed semantic binding owners");
}

fn insert_binding(
    conn: &Connection,
    id: &str,
    project_id: &str,
    definition_id: &str,
    facet_key: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO codex_detail_semantic_bindings
             (id, project_id, definition_id, facet_key, projection_kind,
              temporal_policy, source, confirmed, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'scalar-text', 'base-only', 'preset', 1, 0,
                 '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')",
        params![id, project_id, definition_id, facet_key],
    )
}

#[test]
fn fresh_migration_retains_the_v4_detail_semantic_binding_contract() {
    assert!(
        grimodex_core::SCHEMA_VERSION >= DETAIL_BINDING_SCHEMA_VERSION,
        "semantic binding persistence must remain part of every schema after v4",
    );

    let db = migrated_database();
    db.with_conn(|conn| {
        assert!(table_exists(conn, BINDING_TABLE)?);
        let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(user_version, grimodex_core::SCHEMA_VERSION);

        let columns = conn
            .prepare("PRAGMA table_info(codex_detail_semantic_bindings)")?
            .query_map([], |row| row.get::<_, String>("name"))?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(
            columns,
            [
                "id",
                "project_id",
                "definition_id",
                "facet_key",
                "projection_kind",
                "temporal_policy",
                "source",
                "confirmed",
                "version",
                "created_at",
                "updated_at",
            ]
        );
        Ok(())
    })
    .expect("inspect fresh semantic binding schema");
}

#[test]
fn released_v3_workspace_is_upgraded_without_losing_detail_definitions() {
    let db = migrated_database();
    seed_projects_and_definitions(&db);
    db.with_conn(|conn| {
        conn.execute_batch("DROP TABLE IF EXISTS codex_detail_semantic_bindings")?;
        conn.pragma_update(None, "user_version", RELEASED_SCHEMA_VERSION)?;
        Ok(())
    })
    .expect("shape released v3 workspace");

    db.migrate().expect("upgrade released v3 workspace");

    db.with_conn(|conn| {
        assert!(table_exists(conn, BINDING_TABLE)?);
        let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(user_version, grimodex_core::SCHEMA_VERSION);
        let definition_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_detail_definitions
              WHERE id IN ('binding-definition-a', 'binding-definition-b')",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(definition_count, 2);
        Ok(())
    })
    .expect("verify released v3 upgrade");
}

#[test]
fn current_v4_marker_does_not_skip_a_missing_binding_table() {
    let db = migrated_database();
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TABLE codex_detail_semantic_bindings;
             PRAGMA user_version = 4;",
        )?;
        let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(user_version, DETAIL_BINDING_SCHEMA_VERSION);
        Ok(())
    })
    .expect("shape an incomplete v4 workspace");

    db.migrate()
        .expect("repair the incomplete current-version workspace");

    db.with_conn(|conn| {
        assert!(table_exists(conn, BINDING_TABLE)?);
        let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(user_version, grimodex_core::SCHEMA_VERSION);
        Ok(())
    })
    .expect("verify the missing table was restored");
}

#[test]
fn v4_checkpoint_rejects_a_malformed_definition_owner_index() {
    let db = migrated_database();
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TABLE codex_detail_semantic_bindings;
             DROP INDEX uq_codex_detail_defs_project_id;
             CREATE INDEX uq_codex_detail_defs_project_id
                 ON codex_detail_definitions(id);
             PRAGMA user_version = 3;",
        )?;
        Ok(())
    })
    .expect("shape malformed prerelease schema");

    let error = db
        .migrate()
        .expect_err("malformed owner index must not be stamped as v4");
    assert!(error.to_string().contains("current invariants"));
    db.with_conn(|conn| {
        let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(user_version, 3);
        Ok(())
    })
    .expect("verify marker remains at v3");
}

#[test]
fn semantic_binding_migration_is_idempotent_and_preserves_rows() {
    let db = migrated_database();
    seed_projects_and_definitions(&db);
    db.with_conn(|conn| {
        insert_binding(
            conn,
            "binding-idempotent",
            "binding-project-a",
            "binding-definition-a",
            "character.role",
        )?;
        Ok(())
    })
    .expect("insert binding before repeated migration");

    db.migrate().expect("repeat migration");
    db.migrate().expect("repeat migration again");

    db.with_conn(|conn| {
        let stored: (String, i64) = conn.query_row(
            "SELECT facet_key, version
               FROM codex_detail_semantic_bindings
              WHERE id = 'binding-idempotent'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(stored, ("character.role".to_string(), 0));
        Ok(())
    })
    .expect("verify idempotent semantic binding migration");
}

#[test]
fn semantic_bindings_reject_cross_project_definitions_and_cascade_with_owners() {
    let db = migrated_database();
    seed_projects_and_definitions(&db);

    db.with_conn(|conn| {
        let cross_project = insert_binding(
            conn,
            "binding-cross-project",
            "binding-project-a",
            "binding-definition-b",
            "character.role",
        );
        assert!(
            cross_project.is_err(),
            "project_id must identify the same Project as definition_id",
        );

        insert_binding(
            conn,
            "binding-delete-definition",
            "binding-project-a",
            "binding-definition-a",
            "character.role",
        )?;
        insert_binding(
            conn,
            "binding-delete-project",
            "binding-project-b",
            "binding-definition-b",
            "character.role",
        )?;

        conn.execute(
            "DELETE FROM codex_detail_definitions WHERE id = 'binding-definition-a'",
            [],
        )?;
        let after_definition_delete: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_detail_semantic_bindings
              WHERE id = 'binding-delete-definition'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(after_definition_delete, 0);

        conn.execute("DELETE FROM projects WHERE id = 'binding-project-b'", [])?;
        let after_project_delete: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_detail_semantic_bindings
              WHERE id = 'binding-delete-project'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(after_project_delete, 0);
        Ok(())
    })
    .expect("verify semantic binding ownership constraints");
}

#[test]
fn project_snapshot_declares_and_captures_semantic_bindings_as_codex_state() {
    let _restore_table: SnapshotRestoreTable =
        serde_json::from_str("\"codex_detail_semantic_bindings\"")
            .expect("semantic bindings must be a native restore table");

    let db = migrated_database();
    seed_projects_and_definitions(&db);
    db.with_conn(|conn| {
        insert_binding(
            conn,
            "binding-snapshot",
            "binding-project-a",
            "binding-definition-a",
            "character.role",
        )?;
        Ok(())
    })
    .expect("seed snapshot binding");

    create_project_snapshot(
        &db,
        CreateProjectSnapshotPayload {
            project_id: "binding-project-a".to_string(),
            snapshot_id: "binding-snapshot-id".to_string(),
            name: "Semantic binding snapshot".to_string(),
            description: None,
            created_at: "2026-08-10T00:00:00.000Z".to_string(),
            tree_rows: Vec::new(),
            codex_rows: Vec::new(),
            snippet_rows: Vec::new(),
            version_ids: Vec::new(),
        },
    )
    .expect("capture semantic binding snapshot");

    db.with_conn(|conn| {
        let payload: String = conn.query_row(
            "SELECT payload_json FROM project_snapshot_aux
              WHERE snapshot_id = 'binding-snapshot-id'
                AND scope = 'codex_detail_semantic_bindings'",
            [],
            |row| row.get(0),
        )?;
        let payload: serde_json::Value = serde_json::from_str(&payload)?;
        assert_eq!(payload["rows"][0]["id"], "binding-snapshot");
        Ok(())
    })
    .expect("verify semantic binding snapshot capture");
}

#[test]
fn codex_snapshot_restore_round_trips_bindings_without_touching_another_project() {
    let db = migrated_database();
    seed_projects_and_definitions(&db);
    db.with_conn(|conn| {
        insert_binding(
            conn,
            "binding-roundtrip-a",
            "binding-project-a",
            "binding-definition-a",
            "character.role",
        )?;
        insert_binding(
            conn,
            "binding-roundtrip-b",
            "binding-project-b",
            "binding-definition-b",
            "character.role",
        )?;
        Ok(())
    })
    .expect("seed roundtrip bindings");

    create_project_snapshot(
        &db,
        CreateProjectSnapshotPayload {
            project_id: "binding-project-a".to_string(),
            snapshot_id: "binding-roundtrip-snapshot".to_string(),
            name: "Binding roundtrip".to_string(),
            description: None,
            created_at: "2026-08-10T00:00:00.000Z".to_string(),
            tree_rows: Vec::new(),
            codex_rows: Vec::new(),
            snippet_rows: Vec::new(),
            version_ids: Vec::new(),
        },
    )
    .expect("capture roundtrip snapshot");

    let inserts = db
        .with_conn(|conn| {
            let mut plans = Vec::new();
            for (scope, table) in [
                ("codex_types", SnapshotRestoreTable::CodexTypes),
                (
                    "codex_detail_definitions",
                    SnapshotRestoreTable::CodexDetailDefinitions,
                ),
                (
                    "codex_detail_semantic_bindings",
                    SnapshotRestoreTable::CodexDetailSemanticBindings,
                ),
            ] {
                let payload: String = conn.query_row(
                    "SELECT payload_json FROM project_snapshot_aux
                      WHERE snapshot_id = 'binding-roundtrip-snapshot' AND scope = ?1",
                    [scope],
                    |row| row.get(0),
                )?;
                let payload: serde_json::Value = serde_json::from_str(&payload)?;
                let rows = payload["rows"]
                    .as_array()
                    .ok_or_else(|| rusqlite::Error::InvalidQuery)?;
                for row in rows {
                    plans.push(SnapshotInsertPlan {
                        table,
                        row: row
                            .as_object()
                            .cloned()
                            .ok_or_else(|| rusqlite::Error::InvalidQuery)?,
                        mode: SnapshotInsertMode::Insert,
                    });
                }
            }
            conn.execute(
                "DELETE FROM codex_detail_semantic_bindings
                  WHERE id = 'binding-roundtrip-a'",
                [],
            )?;
            Ok(plans)
        })
        .expect("prepare restore plans");

    apply_project_snapshot_restore(
        &db,
        ApplyProjectSnapshotRestorePayload {
            project_id: "binding-project-a".to_string(),
            snapshot_id: "binding-roundtrip-snapshot".to_string(),
            scopes: vec![RestoreScope::Codex],
            inserts,
        },
    )
    .expect("restore Codex scope");

    db.with_conn(|conn| {
        let restored_a: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_detail_semantic_bindings
              WHERE id = 'binding-roundtrip-a'",
            [],
            |row| row.get(0),
        )?;
        let preserved_b: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_detail_semantic_bindings
              WHERE id = 'binding-roundtrip-b'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!((restored_a, preserved_b), (1, 1));
        Ok(())
    })
    .expect("verify binding roundtrip and project isolation");
}
