use grimodex_db::Database;
use rusqlite::params;

#[test]
fn fresh_schema_exposes_the_calendar_occ_token() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");

    db.with_conn(|conn| {
        let column: (String, bool, Option<String>) = conn.query_row(
            "SELECT type, \"notnull\", dflt_value
               FROM pragma_table_info('project_calendar')
              WHERE name = 'version'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(column, ("INTEGER".to_string(), true, Some("0".to_string())));
        assert!(grimodex_core::SCHEMA_VERSION >= 5);
        Ok(())
    })
    .expect("inspect calendar schema");
}

#[test]
fn v4_calendar_rows_migrate_without_losing_data() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("create current schema");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p1', 'Project')",
            [],
        )?;
        conn.execute(
            "INSERT INTO project_calendar
                (project_id, days_per_year, season_boundaries)
             VALUES ('p1', 400, ?1)",
            params![r#"[{"name":"Winter","startDayOfYear":300}]"#],
        )?;
        conn.execute_batch(
            "ALTER TABLE project_calendar DROP COLUMN version;
             PRAGMA user_version = 4;",
        )?;
        Ok(())
    })
    .expect("create v4 fixture");

    db.migrate().expect("migrate v4 calendar");

    db.with_conn(|conn| {
        let row: (i64, String, i64) = conn.query_row(
            "SELECT days_per_year, season_boundaries, version
               FROM project_calendar WHERE project_id = 'p1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(row.0, 400);
        assert!(row.1.contains("Winter"));
        assert_eq!(row.2, 0);
        let schema_version: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(schema_version, grimodex_core::SCHEMA_VERSION);
        Ok(())
    })
    .expect("verify migrated calendar");
}
