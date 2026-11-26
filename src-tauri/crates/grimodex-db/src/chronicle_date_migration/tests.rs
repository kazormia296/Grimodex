use super::*;
use rusqlite::types::Value;

fn snapshot(conn: &Connection, sql: &str) -> Result<Vec<Vec<Value>>> {
    let mut stmt = conn.prepare(sql)?;
    let width = stmt.column_count();
    let rows = stmt.query_map([], |r| (0..width).map(|i| r.get(i)).collect())?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn counters(conn: &Connection) -> Result<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT total_changes(), seq FROM grimodex_write_clock WHERE name = '*'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

fn day(conn: &Connection, id: &str) -> Result<i64> {
    Ok(
        conn.query_row("SELECT start_time FROM events WHERE id = ?", [id], |r| {
            r.get(0)
        })?,
    )
}

#[test]
fn orders_per_project_and_only_writes_dates_and_write_clock() -> Result<()> {
    let db = crate::test_support::current_schema_memory()?;
    let conn = db.lock()?;
    conn.execute_batch(
        "SAVEPOINT migration;
         INSERT INTO projects(id,title) VALUES ('z','Z'),('a','A');
         INSERT INTO tree_nodes(id, project_id, parent_id, node_type, archived_at,
                                chronicle_start_time, chronicle_start_granularity) VALUES
             ('live','a',NULL,'scene',NULL,40,'month'),
             ('bad-scene','a',NULL,'scene',NULL,'damaged','day'),
             ('old','a',NULL,'scene','2020-01-01',60,'day'),
             ('folder','a',NULL,'folder','2020-01-01',NULL,'none'),
             ('child','a','folder','scene',NULL,80,'day');
         INSERT INTO events(id,project_id,ordinal,created_at) VALUES
             ('z0','z','a','bad'), ('first','a','a','bad'),
             ('newer','a','b','2025-01-02 00:00:00'),
             ('b','a','b','2025-01-01 00:00:00'), ('a','a','b','2025-01-01T00:00:00Z');
         INSERT INTO events(id,project_id,start_time,start_minute,end_time,precision) VALUES
             ('dated','a',20,NULL,120,'approx'), ('minute','a',3,15,NULL,'exact');
         INSERT INTO events(id,project_id,start_time,start_granularity,end_time) VALUES
             ('legacy-end','a',25,'day',400);
         UPDATE events SET start_minute=1,end_time=666,end_minute=2,end_granularity='time' WHERE id='first';
         UPDATE events SET version=7,updated_at='unchanged';
         INSERT INTO scene_events(scene_id,event_id,incarnation_token) VALUES ('live','first','test');
         INSERT INTO event_relations(project_id,cause_event_id,effect_event_id) VALUES ('a','first','newer');"
    )?;
    let metadata = "SELECT id,version,updated_at,ordinal FROM events ORDER BY id";
    let legacy_end = "SELECT * FROM events WHERE id='legacy-end'";
    let original_end = snapshot(&conn, legacy_end)?;
    let original = snapshot(&conn, metadata)?;
    let before = counters(&conn)?;
    let report = fill_missing_chronicle_dates(&conn)?;
    assert!(report.skipped_event_ids.is_empty());
    assert_eq!(report.changed.len(), 7);
    assert_eq!(
        report.changed.last().map(|r| r.project_id.as_str()),
        Some("z")
    );
    for (id, expected) in [
        ("first", 41),
        ("a", 42),
        ("b", 43),
        ("newer", 44),
        ("z0", 0),
    ] {
        assert_eq!(day(&conn, id)?, expected);
    }
    let change = report
        .changed
        .iter()
        .find(|c| c.event_id == "first")
        .ok_or_else(|| anyhow::anyhow!("missing report for first event"))?;
    assert_eq!(
        change.actions,
        [
            ChronicleDateAction::ClearedEnd,
            ChronicleDateAction::AssignedProvisionalDate
        ]
    );
    assert_eq!(
        change.changed_columns,
        [
            "end_time",
            "end_minute",
            "end_granularity",
            "start_time",
            "start_minute",
            "start_granularity",
            "precision"
        ]
    );
    assert_eq!(conn.query_row(
        "SELECT count(*) FROM events WHERE
             (id='dated' AND start_granularity='day' AND precision='approx' AND end_time=120 AND end_granularity='none')
          OR (id='minute' AND start_granularity='time' AND start_minute=15 AND precision='exact')
          OR (id='first' AND start_granularity='day' AND start_minute IS NULL AND precision='unknown'
                    AND end_time IS NULL AND end_minute IS NULL AND end_granularity='none')",
        [], |r|r.get::<_,i64>(0))?,3);
    assert_eq!(original, snapshot(&conn, metadata)?);
    assert_eq!(original_end, snapshot(&conn, legacy_end)?);
    let after = counters(&conn)?;
    // Every changed row and its clock increment account for all SQLite writes, including triggers.
    assert_eq!(after.0 - before.0, 14);
    assert_eq!(after.1 - before.1, 7);
    assert_eq!(
        fill_missing_chronicle_dates(&conn)?,
        ChronicleDateMigrationReport::default()
    );
    assert_eq!(counters(&conn)?, after);
    Ok(())
}

#[test]
fn skips_unexpected_rows_and_leaves_them_unchanged() -> Result<()> {
    let db = crate::test_support::current_schema_memory()?;
    let conn = db.lock()?;
    conn.execute_batch(
        "SAVEPOINT migration;
         INSERT INTO projects(id,title) VALUES ('a','A'),('z','Z');
         PRAGMA ignore_check_constraints=ON;
         INSERT INTO events(id,project_id,start_time,end_time,start_minute,end_minute,start_granularity,end_granularity)
         VALUES ('bad-grain','a',90,NULL,NULL,NULL,'future','none'),
                ('bad-end','a',NULL,NULL,NULL,NULL,'none','future'),
                ('bad-day','a','broken',NULL,NULL,NULL,'none','none'),
                ('bad-real','a',NULL,1.5,NULL,NULL,'none','none'),
                ('bad-big','a',1e30,NULL,NULL,NULL,'none','none'),
                ('bad-blob','a',NULL,NULL,x'01',NULL,'none','none'),
                ('bad-low','a',NULL,NULL,-1,NULL,'none','none'),
                ('bad-high','a',NULL,NULL,NULL,1440,'none','none'),
                ('dated','a',1,75,NULL,NULL,'day','day'),
                ('ok','a',NULL,NULL,NULL,NULL,'day','none'),
                ('anchor','z',1,10,NULL,NULL,'day','day'),
                ('huge','z',9223372036854775806,NULL,NULL,NULL,'day','none'),
                ('x','z',NULL,NULL,NULL,NULL,'none','none'),
                ('y','z',NULL,12,NULL,14,'none','time');
         UPDATE events SET precision='unknown' WHERE id='ok';
         PRAGMA ignore_check_constraints=OFF;"
    )?;
    let skipped = "SELECT * FROM events WHERE id LIKE 'bad-%' OR id='huge' ORDER BY id";
    let original = snapshot(&conn, skipped)?;
    let report = fill_missing_chronicle_dates(&conn)?;
    assert_eq!(
        report.skipped_event_ids,
        [
            "bad-big",
            "bad-blob",
            "bad-day",
            "bad-end",
            "bad-grain",
            "bad-high",
            "bad-low",
            "bad-real",
            "huge"
        ]
    );
    assert_eq!(report.changed.len(), 3);
    assert_eq!(report.changed[0].changed_columns, ["start_time"]);
    assert_eq!(day(&conn, "ok")?, 91);
    // The out-of-range day of `huge` is not counted as the latest day.
    assert_eq!(day(&conn, "x")?, 11);
    assert_eq!(day(&conn, "y")?, 12);
    assert_eq!(snapshot(&conn, skipped)?, original);
    let before = counters(&conn)?;
    let again = fill_missing_chronicle_dates(&conn)?;
    assert!(again.changed.is_empty());
    assert_eq!(again.skipped_event_ids, report.skipped_event_ids);
    assert_eq!(counters(&conn)?, before);
    Ok(())
}
