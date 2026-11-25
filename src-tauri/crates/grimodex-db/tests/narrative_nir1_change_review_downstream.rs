use grimodex_db::narrative_extraction::{
    read_all_downstream_consumers, read_downstream_consumers_page, DownstreamConsumer,
    DownstreamCursor, DOWNSTREAM_PAGE_MAX,
};
use rusqlite::{params, Connection, Transaction};

fn read_in_transaction<T>(
    conn: &mut Connection,
    read: impl FnOnce(&Transaction<'_>) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let transaction = conn.transaction()?;
    let result = read(&transaction)?;
    transaction.commit()?;
    Ok(result)
}

fn connection() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "CREATE TABLE narrative_dependency_edges (
             id TEXT NOT NULL PRIMARY KEY,
             project_id TEXT NOT NULL,
             consumer_kind TEXT NOT NULL,
             consumer_key TEXT NOT NULL,
             source_object_identity TEXT NOT NULL,
             UNIQUE(project_id, consumer_kind, consumer_key, source_object_identity)
         );
         CREATE INDEX idx_narrative_dependency_edges_source
             ON narrative_dependency_edges(project_id, source_object_identity);",
    )?;
    Ok(conn)
}

fn insert_edge(
    conn: &Connection,
    id: &str,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    source_object_identity: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            id,
            project_id,
            consumer_kind,
            consumer_key,
            source_object_identity
        ],
    )?;
    Ok(())
}

fn edge_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_edges",
        [],
        |row| row.get(0),
    )
}

#[test]
fn downstream_page_handles_empty_exact_limit_and_invalid_limits() -> anyhow::Result<()> {
    let mut conn = connection()?;
    assert!(read_in_transaction(&mut conn, |tx| {
        Ok(
            read_downstream_consumers_page(tx, "project-a", "codex:entity-1", None, 2)?
                .items
                .is_empty(),
        )
    })?);

    insert_edge(
        &conn,
        "edge-1",
        "project-a",
        "application",
        "alpha",
        "codex:entity-1",
    )?;
    insert_edge(
        &conn,
        "edge-2",
        "project-a",
        "run",
        "beta",
        "codex:entity-1",
    )?;
    read_in_transaction(&mut conn, |tx| {
        let page = read_downstream_consumers_page(tx, "project-a", "codex:entity-1", None, 2)?;
        assert_eq!(
            page.items,
            vec![
                DownstreamConsumer {
                    consumer_kind: "application".into(),
                    consumer_key: "alpha".into(),
                },
                DownstreamConsumer {
                    consumer_kind: "run".into(),
                    consumer_key: "beta".into(),
                },
            ]
        );
        assert_eq!(page.next_cursor, None);
        assert!(
            read_downstream_consumers_page(tx, "project-a", "codex:entity-1", None, 0).is_err()
        );
        assert!(read_downstream_consumers_page(
            tx,
            "project-a",
            "codex:entity-1",
            None,
            DOWNSTREAM_PAGE_MAX + 1
        )
        .is_err());
        assert!(read_downstream_consumers_page(tx, "", "codex:entity-1", None, 1).is_err());
        assert!(read_downstream_consumers_page(tx, "project-a", "", None, 1).is_err());
        Ok(())
    })?;
    Ok(())
}

#[test]
fn downstream_pages_are_ordered_scoped_and_cursor_complete() -> anyhow::Result<()> {
    let mut conn = connection()?;
    let source = "codex-relation:edge-1";
    for (id, kind, key) in [
        ("edge-1", "run", "beta"),
        ("edge-2", "application", "zeta"),
        ("edge-3", "run", "alpha"),
        ("edge-4", "application", "alpha"),
    ] {
        insert_edge(&conn, id, "project-a", kind, key, source)?;
    }
    insert_edge(&conn, "edge-other-project", "project-b", "a", "a", source)?;
    insert_edge(
        &conn,
        "edge-other-source",
        "project-a",
        "a",
        "a",
        "codex:entity-other",
    )?;

    let before = edge_count(&conn)?;
    read_in_transaction(&mut conn, |tx| {
        let first = read_downstream_consumers_page(tx, "project-a", source, None, 3)?;
        assert_eq!(
            first.items,
            vec![
                DownstreamConsumer {
                    consumer_kind: "application".into(),
                    consumer_key: "alpha".into(),
                },
                DownstreamConsumer {
                    consumer_kind: "application".into(),
                    consumer_key: "zeta".into(),
                },
                DownstreamConsumer {
                    consumer_kind: "run".into(),
                    consumer_key: "alpha".into(),
                },
            ]
        );
        assert_eq!(
            first.next_cursor,
            Some(DownstreamCursor {
                consumer_kind: "run".into(),
                consumer_key: "alpha".into(),
            })
        );
        let second =
            read_downstream_consumers_page(tx, "project-a", source, first.next_cursor.as_ref(), 3)?;
        assert_eq!(
            second.items,
            vec![DownstreamConsumer {
                consumer_kind: "run".into(),
                consumer_key: "beta".into(),
            }]
        );
        assert_eq!(second.next_cursor, None);
        Ok(())
    })?;
    assert_eq!(edge_count(&conn)?, before);
    Ok(())
}

#[test]
fn read_all_downstream_consumers_fails_on_page_budget() -> anyhow::Result<()> {
    let mut conn = connection()?;
    for index in 0..=DOWNSTREAM_PAGE_MAX {
        let key = format!("consumer-{index:03}");
        let id = format!("edge-{index:03}");
        insert_edge(&conn, &id, "project-a", "run", &key, "codex:entity-1")?;
    }

    let before = edge_count(&conn)?;
    read_in_transaction(&mut conn, |tx| {
        assert!(read_all_downstream_consumers(tx, "project-a", "codex:entity-1", 1).is_err());
        assert_eq!(
            read_all_downstream_consumers(tx, "project-a", "codex:entity-1", 2)?.len(),
            DOWNSTREAM_PAGE_MAX + 1
        );
        Ok(())
    })?;
    assert_eq!(edge_count(&conn)?, before);
    Ok(())
}

#[test]
fn downstream_readers_reject_autocommit_connections() -> anyhow::Result<()> {
    let conn = connection()?;
    let page_error = read_downstream_consumers_page(&conn, "project-a", "codex:entity-1", None, 1)
        .expect_err("page reads require a transaction");
    let all_error = read_all_downstream_consumers(&conn, "project-a", "codex:entity-1", 1)
        .expect_err("all-consumer reads require a transaction");
    assert!(page_error
        .to_string()
        .contains("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION"));
    assert!(all_error
        .to_string()
        .contains("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION"));
    Ok(())
}
