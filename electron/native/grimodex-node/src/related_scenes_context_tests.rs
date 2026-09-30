use super::*;
use grimodex_db::narrative_extraction::{read_retrieval_scene_source, RetrievalSceneSourceRead};
use grimodex_db::Database;

fn database() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("database");
    db.migrate().expect("schema");
    db.with_conn(|conn| {
        conn.execute("INSERT INTO tree_nodes(id, project_id, node_type, title, sort_order, content) VALUES ('s2','default-project','scene','S2','a0','saved prose')", [])?;
        Ok(())
    }).expect("scene fixture");
    db
}

fn source(db: &Database) -> RetrievalSceneSource {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let value = read_retrieval_scene_source(&tx, "default-project", "s2")?;
        tx.commit()?;
        match value {
            RetrievalSceneSourceRead::Available(source) => Ok(source),
            _ => anyhow::bail!("expected fixture source"),
        }
    })
    .expect("read source")
}

#[test]
fn forged_query_cannot_bind_to_an_existing_saved_scene() {
    let db = database();
    assert!(RelatedScenesSourceContext::capture(source(&db), "different query").is_err());
    let bound = RelatedScenesSourceContext::capture(source(&db), "saved prose").expect("exact");
    assert_eq!(bound.query(), "saved prose");
    assert!(bound.matches(&source(&db)));
}

#[test]
fn unchanged_query_tail_does_not_hide_an_edited_source_version_or_storage_digest() {
    let db = database();
    let bound = RelatedScenesSourceContext::capture(source(&db), "saved prose").expect("exact");
    db.with_conn(|conn| {
        conn.execute("UPDATE tree_nodes SET version=version+1 WHERE id='s2'", [])?;
        Ok(())
    })
    .expect("new version");
    assert!(!bound.matches(&source(&db)));
    let bound =
        RelatedScenesSourceContext::capture(source(&db), "saved prose").expect("recaptured");
    // Raw trim leaves the same query; storage identity still changes.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET content=' saved prose ' WHERE id='s2'",
            [],
        )?;
        Ok(())
    })
    .expect("storage mutation");
    assert!(!bound.matches(&source(&db)));
}

#[test]
fn raw_source_does_not_depend_on_ir_mode_or_archive_eligibility() {
    let db = database();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE projects SET phase_resolution_mode='story' WHERE id='default-project'",
            [],
        )?;
        conn.execute(
            "UPDATE tree_nodes SET archived_at='2026-09-08T00:00:00Z' WHERE id='s2'",
            [],
        )?;
        Ok(())
    })
    .expect("unsupported IR scene");
    let raw = source(&db);
    assert_eq!(raw.phase_resolution_mode, "story");
    assert!(raw.archived);
    assert!(RelatedScenesSourceContext::capture(raw, "saved prose").is_ok());
}
