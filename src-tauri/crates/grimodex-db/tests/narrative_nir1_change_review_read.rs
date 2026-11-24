use std::path::Path;

use grimodex_db::domain_writes::{tree_node_create, TreeNodeCreatePayload};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    find_previous_approved_typed_revision_id, narrative_extraction_append_human_decision,
    prepare_nir1_entity_relation_revision, read_nir1_change_review,
    read_nir1_entity_relation_revision, AppendDecisionPayload,
    Nir1EntityRelationRevisionPrepareRequest, Nir1EntityRelationRevisionRead,
    C2_ZC_CUTOVER_CONTRACT_VERSION, C2_ZC_CUTOVER_MIGRATION_ID,
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};
use serde_json::Value;

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

fn review_row_counts(conn: &Connection) -> rusqlite::Result<(i64, i64, i64, i64, i64)> {
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
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_decisions",
            [],
            |row| row.get(0),
        )?,
    ))
}

fn change_review_db() -> anyhow::Result<Database> {
    let db = Database::new(Path::new(":memory:"))?;
    db.migrate()?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('change-review-epoch', 'default-project', 0, 'initial',
                     '2026-09-15T00:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, '2026-09-15T00:00:00.000Z')",
            params![C2_ZC_CUTOVER_MIGRATION_ID, C2_ZC_CUTOVER_CONTRACT_VERSION],
        )?;
        Ok(())
    })?;
    tree_node_create(
        &db,
        TreeNodeCreatePayload {
            id: "nir1-change-review".into(),
            project_id: "default-project".into(),
            request_id: "change-review-scene-request".into(),
            session_id: "change-review-test".into(),
            event_uid: "change-review-scene-event".into(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".into(),
            title: "Change review".into(),
            sort_order: "a0".into(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some("{}".into()),
            canonical_payload: None,
        },
    )?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
             VALUES ('change-review-alice', 'default-project', 'character', 'Alice',
                     'Alice before', '2026-09-12T00:00:00Z')",
            [],
        )?;
        let head: i64 = conn.query_row(
            "SELECT COALESCE(MAX(source_change_event_sequence), 0)
               FROM narrative_change_transactions
              WHERE project_id = 'default-project'",
            [],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence,
                 last_error, updated_at)
             VALUES ('default-project', 'narrative-incremental-freshness/v1', ?1,
                     NULL, '2026-09-15T00:00:00.000Z')",
            [head],
        )?;
        Ok(())
    })?;
    Ok(db)
}

fn prepare_change_review_revision(db: &Database, proposal_key: &str) -> anyhow::Result<Value> {
    Ok(prepare_nir1_entity_relation_revision(
        db,
        Nir1EntityRelationRevisionPrepareRequest {
            project_id: "default-project".into(),
            scene_id: "nir1-change-review".into(),
            proposal_key: Some(proposal_key.into()),
            entity_ids: vec!["change-review-alice".into()],
            relation_ids: vec![],
        },
    )?)
}

fn approve_change_review_revision(db: &Database, prepared: &Value) -> anyhow::Result<()> {
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: prepared["runId"].as_str().unwrap().into(),
            project_id: "default-project".into(),
            proposal_id: prepared["result"]["proposalId"].as_str().unwrap().into(),
            revision_id: prepared["result"]["revisionId"].as_str().unwrap().into(),
            decision: "approved".into(),
            decision_json: None,
            created_by: Some("change-review-test".into()),
        },
    )?;
    Ok(())
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

#[test]
fn change_review_reads_approved_history_after_live_codex_change() -> anyhow::Result<()> {
    let db = change_review_db()?;
    let first = prepare_change_review_revision(&db, "change-review:first")?;
    let first_id = first["result"]["revisionId"].as_str().unwrap().to_owned();
    approve_change_review_revision(&db, &first)?;

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entries
                SET summary = 'Alice after', updated_at = '2026-09-13T00:00:00Z'
              WHERE id = 'change-review-alice' AND project_id = 'default-project'",
            [],
        )?;
        Ok(())
    })?;
    let live_reader = db.with_read_transaction(|conn| {
        read_nir1_entity_relation_revision(conn, "default-project", &first_id)
    })?;
    assert!(matches!(
        live_reader,
        Nir1EntityRelationRevisionRead::Unavailable { reason }
            if reason == "source-revision-changed"
    ));

    let current = prepare_change_review_revision(&db, "change-review:current")?;
    let current_id = current["result"]["revisionId"].as_str().unwrap();
    let before = db.with_conn(|conn| Ok(review_row_counts(conn)?))?;
    let review = db
        .with_read_transaction(|conn| read_nir1_change_review(conn, "default-project", current_id))?
        .expect("current typed revision and approved history are available");
    let after = db.with_conn(|conn| Ok(review_row_counts(conn)?))?;
    assert_eq!(
        after, before,
        "change review read changed revision table rows"
    );
    assert_eq!(
        review.previous_revision_id.as_deref(),
        Some(first_id.as_str())
    );
    assert!(review.objects.iter().any(|object| {
        object.identity == "codex:change-review-alice" && object.change == "content-changed"
    }));
    Ok(())
}
