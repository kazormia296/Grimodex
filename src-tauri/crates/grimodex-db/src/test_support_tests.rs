use super::{current_schema_memory, fresh_migrated_memory};
use crate::{read_sqlite_source_revision, Database};

fn schema(db: &Database) -> anyhow::Result<Vec<(String, String, String, Option<String>)>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })
}

fn exercise_schema(db: &Database) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        let bootstrap: (i64, i64, i64) = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM projects WHERE id='default-project'),
               (SELECT COUNT(*) FROM codex_types WHERE project_id='default-project' AND is_builtin=1),
               (SELECT COUNT(*) FROM map_boards WHERE id='default-project-main-board')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(bootstrap, (1, 4, 1));

        conn.execute(
            "INSERT INTO projects(id,title,language) VALUES ('fixture-project','Fixture','en')",
            [],
        )?;
        conn.execute(
            "INSERT INTO codex_entries(id,project_id,type,name,summary)
             VALUES ('fixture-entry','fixture-project','character','Bramble Peak','cobalt meadow')",
            [],
        )?;
        for table in ["codex_fts", "codex_fts_en"] {
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH 'cobalt'"),
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 1, "{table} trigger must remain active");
        }
        conn.execute(
            "INSERT INTO codex_entries(id,project_id,type,name)
             VALUES ('invalid-owner','missing-project','character','Invalid')",
            [],
        )
        .expect_err("foreign keys must remain active");
        Ok(())
    })
}

#[test]
fn cloned_fixture_matches_real_schema_bootstrap_fts_and_foreign_keys() -> anyhow::Result<()> {
    let fresh = fresh_migrated_memory()?;
    let cloned = current_schema_memory()?;
    assert_eq!(schema(&fresh)?, schema(&cloned)?);
    exercise_schema(&fresh)?;
    exercise_schema(&cloned)?;
    Ok(())
}

#[test]
fn cloned_fixtures_keep_writes_and_temp_epochs_isolated() -> anyhow::Result<()> {
    let first = current_schema_memory()?;
    let second = current_schema_memory()?;
    let first_epoch = first
        .with_conn(read_sqlite_source_revision)?
        .connection_epoch;
    let second_epoch = second
        .with_conn(read_sqlite_source_revision)?
        .connection_epoch;
    assert!(!first_epoch.is_empty());
    assert_ne!(first_epoch, second_epoch);

    first.with_conn(|conn| {
        conn.execute(
            "INSERT INTO app_settings(key,value) VALUES ('fixture-owner','first')",
            [],
        )?;
        conn.execute("CREATE TEMP TABLE fixture_temp(value TEXT)", [])?;
        Ok(())
    })?;
    second.with_conn(|conn| {
        let settings: i64 = conn.query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key='fixture-owner'",
            [],
            |row| row.get(0),
        )?;
        let temp_tables: i64 = conn.query_row(
            "SELECT COUNT(*) FROM temp.sqlite_schema WHERE name='fixture_temp'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!((settings, temp_tables), (0, 0));
        Ok(())
    })
}
