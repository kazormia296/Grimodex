use grimodex_db::narrative_extraction::{
    find_previous_approved_typed_revision_id, NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
    NIR1_ENTITY_RELATION_SET_KIND,
};
use rusqlite::{params, Connection};

fn setup_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE narrative_extraction_runs (
             id TEXT PRIMARY KEY, project_id TEXT NOT NULL, surface_path_id TEXT NOT NULL
         );
         CREATE TABLE narrative_proposal_sets (
             id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
             set_kind TEXT NOT NULL, created_at TEXT NOT NULL
         );
         CREATE TABLE narrative_proposals (
             id TEXT PRIMARY KEY, proposal_set_id TEXT NOT NULL,
             current_revision_id TEXT NOT NULL, status TEXT NOT NULL
         );
         CREATE TABLE narrative_proposal_revisions (
             id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL
         );",
    )
}

fn insert_revision(
    conn: &Connection,
    project_id: &str,
    set_id: &str,
    revision_id: &str,
    created_at: &str,
    status: &str,
    set_kind: &str,
    surface_path_id: &str,
) -> rusqlite::Result<()> {
    let run_id = format!("run-{set_id}");
    let proposal_id = format!("proposal-{set_id}");
    conn.execute(
        "INSERT INTO narrative_extraction_runs (id, project_id, surface_path_id)
         VALUES (?1, ?2, ?3)",
        params![run_id, project_id, surface_path_id],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_sets (id, run_id, project_id, set_kind, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![set_id, run_id, project_id, set_kind, created_at],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposals (id, proposal_set_id, current_revision_id, status)
         VALUES (?1, ?2, ?3, ?4)",
        params![proposal_id, set_id, revision_id, status],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_revisions (id, proposal_id) VALUES (?1, ?2)",
        params![revision_id, proposal_id],
    )?;
    Ok(())
}

fn row_counts(conn: &Connection) -> rusqlite::Result<(i64, i64, i64, i64)> {
    Ok((
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs",
            [],
            |row| row.get(0),
        )?,
        conn.query_row("SELECT COUNT(*) FROM narrative_proposal_sets", [], |row| {
            row.get(0)
        })?,
        conn.query_row("SELECT COUNT(*) FROM narrative_proposals", [], |row| {
            row.get(0)
        })?,
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_revisions",
            [],
            |row| row.get(0),
        )?,
    ))
}

#[test]
fn previous_revision_lookup_is_project_scoped_approved_and_deterministic() -> anyhow::Result<()> {
    let conn = Connection::open_in_memory()?;
    setup_schema(&conn)?;
    let typed_surface = NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH;
    let typed_set = NIR1_ENTITY_RELATION_SET_KIND;
    insert_revision(
        &conn,
        "project-a",
        "old",
        "revision-old",
        "2026-11-24T00:00:00.000Z",
        "approved",
        typed_set,
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-a",
        "tie-a",
        "revision-tie-a",
        "2026-11-25T00:00:00.000Z",
        "approved",
        typed_set,
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-a",
        "tie-b",
        "revision-tie-b",
        "2026-11-25T00:00:00.000Z",
        "approved",
        typed_set,
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-a",
        "unreviewed",
        "revision-tie-c",
        "2026-11-25T00:00:00.000Z",
        "unreviewed",
        typed_set,
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-a",
        "wrong-kind",
        "revision-wrong-kind",
        "2026-11-25T00:00:00.000Z",
        "approved",
        "another-set-kind",
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-a",
        "wrong-surface",
        "revision-wrong-surface",
        "2026-11-25T00:00:00.000Z",
        "approved",
        typed_set,
        "another-surface",
    )?;
    insert_revision(
        &conn,
        "project-a",
        "current",
        "revision-tie-z",
        "2026-11-25T00:00:00.000Z",
        "unreviewed",
        typed_set,
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-b",
        "foreign-old",
        "revision-foreign-old",
        "2026-11-24T00:00:00.000Z",
        "approved",
        typed_set,
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-b",
        "foreign-current",
        "revision-foreign-current",
        "2026-11-25T00:00:00.000Z",
        "unreviewed",
        typed_set,
        typed_surface,
    )?;
    insert_revision(
        &conn,
        "project-a",
        "first",
        "revision-first",
        "2026-11-23T00:00:00.000Z",
        "unreviewed",
        typed_set,
        typed_surface,
    )?;

    let before = row_counts(&conn)?;
    assert_eq!(
        find_previous_approved_typed_revision_id(&conn, "project-a", "revision-tie-z")?,
        Some("revision-tie-b".into())
    );
    assert_eq!(
        find_previous_approved_typed_revision_id(&conn, "project-a", "revision-first")?,
        None
    );
    assert_eq!(
        find_previous_approved_typed_revision_id(&conn, "project-a", "revision-foreign-current")?,
        None
    );
    assert_eq!(row_counts(&conn)?, before);
    Ok(())
}
