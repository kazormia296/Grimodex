use grimodex_core::{
    workspace_schema::has_current_schema_checkpoint_invariants,
    write_clock::{clock_target_tables, expected_clock_trigger_names},
    PREVIOUS_COMPATIBLE_SCHEMA_VERSION, SCHEMA_VERSION,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};
use std::path::Path;

fn count(conn: &Connection, sql: &str, value: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [value], |row| row.get(0))
}

#[test]
fn schema_46_upgrade_adds_closed_mastra_tables_with_cascades_and_clock_triggers() {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("create current schema");

    // Turn the current database into the exact pre-MP-7 shape: the old marker
    // and clock remain, while all six MP-7 tables and their triggers are gone.
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TABLE mastra_memory_vectors;
             DROP TABLE mastra_memory_vector_indexes;
             DROP TABLE mastra_observational_memory;
             DROP TABLE mastra_resources;
             DROP TABLE mastra_thread_metadata;
             DROP TABLE mastra_message_parts;",
        )?;
        conn.pragma_update(None, "user_version", PREVIOUS_COMPATIBLE_SCHEMA_VERSION)?;
        Ok(())
    })
    .expect("prepare schema 46 fixture");
    db.migrate().expect("upgrade schema 46");

    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, SCHEMA_VERSION);
        assert!(has_current_schema_checkpoint_invariants(conn)?);
        conn.execute(
            "INSERT INTO mastra_memory_vector_indexes (index_name, dimension) VALUES ('memory', 384)",
            [],
        )?;
        assert!(conn
            .execute(
                "INSERT INTO mastra_memory_vector_indexes (index_name, dimension) VALUES ('invalid', 0)",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO mastra_memory_vector_indexes (index_name, dimension) VALUES ('memory', 768)",
                [],
            )
            .is_err());

        conn.execute_batch(
            "INSERT INTO projects (id, title, language) VALUES
                ('p-en', 'English', 'en'), ('p-ja', '日本語', 'ja');
             INSERT INTO chat_sessions (id, project_id, title) VALUES
                ('s-en', 'p-en', 'English'), ('s-ja', 'p-ja', '日本語');
             INSERT INTO chat_messages (id, session_id, role, content) VALUES
                ('m-en-delete', 's-en', 'assistant', 'delete'),
                ('m-en-project', 's-en', 'assistant', 'project cascade'),
                ('m-ja', 's-ja', 'assistant', 'cascade');",
        )?;
        for (project_id, session_id, message_id, resource_id) in [
            ("p-en", "s-en", "m-en-delete", "r-en"),
            ("p-ja", "s-ja", "m-ja", "r-ja"),
        ] {
            conn.execute(
                "INSERT INTO mastra_resources (id, project_id, working_memory) VALUES (?1, ?2, ?3)",
                params![resource_id, project_id, "{}"],
            )?;
            conn.execute(
                "INSERT INTO mastra_thread_metadata (session_id, metadata_json) VALUES (?1, '{}')",
                [session_id],
            )?;
            conn.execute(
                "INSERT INTO mastra_message_parts (message_id, parts_json) VALUES (?1, '[{\"type\":\"text\"}]')",
                [message_id],
            )?;
            conn.execute(
                "INSERT INTO mastra_observational_memory
                    (id, scope, thread_id, resource_id, created_at, updated_at, origin_type,
                     generation_count, active_observations, config_json)
                 VALUES (?1, 'thread', ?2, ?3, 'now', 'now', 'initial', 0, '', '{}')",
                params![format!("om-thread-{session_id}"), session_id, resource_id],
            )?;
            conn.execute(
                "INSERT INTO mastra_observational_memory
                    (id, scope, project_id, resource_id, created_at, updated_at, origin_type,
                     generation_count, active_observations, config_json)
                 VALUES (?1, 'resource', ?2, ?3, 'now', 'now', 'initial', 0, '', '{}')",
                params![format!("om-resource-{project_id}"), project_id, resource_id],
            )?;
            conn.execute(
                "INSERT INTO mastra_memory_vectors (index_name, id, vector, message_id)
                 VALUES ('memory', ?1, x'00000000', ?2)",
                params![format!("v-{message_id}"), message_id],
            )?;
        }
        conn.execute(
            "INSERT INTO mastra_message_parts (message_id, parts_json) VALUES ('m-en-project', '[{\"type\":\"text\"}]')",
            [],
        )?;
        conn.execute(
            "INSERT INTO mastra_memory_vectors (index_name, id, vector, message_id)
             VALUES ('memory', 'v-m-en-project', x'00000000', 'm-en-project')",
            [],
        )?;

        assert!(conn
            .execute(
                "INSERT INTO mastra_message_parts (message_id, parts_json) VALUES ('missing', '[]')",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO mastra_message_parts (message_id, parts_json) VALUES ('m-en-delete', 'not-json')",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO mastra_observational_memory
                    (id, scope, project_id, resource_id, created_at, updated_at, origin_type,
                     generation_count, active_observations, config_json)
                 VALUES ('om-invalid', 'thread', 'p-en', 'r-en', 'now', 'now', 'initial', 0, '', '{}')",
                [],
            )
            .is_err());
        let foreign_key_violations: i64 =
            conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        assert_eq!(foreign_key_violations, 0);

        conn.execute("DELETE FROM chat_messages WHERE id = 'm-en-delete'", [])?;
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_message_parts WHERE message_id = ?1", "m-en-delete")?,
            0
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_memory_vectors WHERE message_id = ?1", "m-en-delete")?,
            0
        );

        conn.execute("DELETE FROM chat_sessions WHERE id = 's-ja'", [])?;
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_thread_metadata WHERE session_id = ?1", "s-ja")?,
            0
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_observational_memory WHERE thread_id = ?1", "s-ja")?,
            0
        );

        conn.execute("DELETE FROM projects WHERE id = 'p-en'", [])?;
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_resources WHERE project_id = ?1", "p-en")?,
            0
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_observational_memory WHERE project_id = ?1", "p-en")?,
            0
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_message_parts WHERE message_id = ?1", "m-en-project")?,
            0
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_memory_vectors WHERE message_id = ?1", "m-en-project")?,
            0
        );
        conn.execute("DELETE FROM projects WHERE id = 'p-ja'", [])?;
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_resources WHERE project_id = ?1", "p-ja")?,
            0
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM mastra_observational_memory WHERE project_id = ?1", "p-ja")?,
            0
        );

        let clock_tables = clock_target_tables(conn)?;
        for table in [
            "mastra_message_parts",
            "mastra_thread_metadata",
            "mastra_resources",
            "mastra_observational_memory",
            "mastra_memory_vectors",
        ] {
            assert!(clock_tables.iter().any(|name| name == table));
        }
        let expected_clock_triggers = expected_clock_trigger_names(&clock_tables);
        let actual_clock_triggers: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'trigger'
               AND name LIKE 'grimodex_clock_%'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(actual_clock_triggers as usize, expected_clock_triggers.len());
        Ok(())
    })
    .expect("verify schema 47 storage, cascade behavior and clock coverage");
}

#[test]
fn schema_47_checkpoint_rejects_missing_mastra_indexes_and_vector_dimensions() {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("create current schema");

    db.with_conn(|conn| {
        conn.execute_batch("DROP INDEX idx_mastra_observational_memory_thread")?;
        assert!(!has_current_schema_checkpoint_invariants(conn)?);
        conn.execute_batch(
            "CREATE INDEX idx_mastra_observational_memory_thread
                ON mastra_observational_memory(thread_id, updated_at);
             DROP INDEX idx_mastra_observational_memory_project;",
        )?;
        assert!(!has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("partial schema 47 is rejected");

    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TABLE mastra_memory_vector_indexes;
             CREATE TABLE mastra_memory_vector_indexes (
                 index_name TEXT PRIMARY KEY,
                 dimension INTEGER NOT NULL
             );",
        )?;
        assert!(!has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("schema 47 rejects missing vector dimension constraint");
}
