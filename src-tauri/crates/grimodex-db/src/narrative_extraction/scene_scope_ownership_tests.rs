//! DR-CQA-6: the Scope extension decides `sceneOwned` from the project's Scene
//! ids (the nodes the Scope authority has read) and no longer joins
//! `tree_nodes`. The join it replaced stays here as the oracle
//! (`SCOPE_EXTENSION_LEGACY_JOIN_SQL`, `SceneOwnership::LegacyJoin`): every
//! observable, the per-row entries (so each `rawDigest`), the collected
//! bindings, the extension digest and the authority's revision token, must be
//! the same on healthy and on damaged projects.

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::{params, Connection};
use serde_json::Value;

use super::super::project_scope_authority::{
    load_live_project_scope_authority_with_legacy_join,
    load_live_project_scope_authority_with_scene_bindings,
};
use super::*;
use crate::Database;

const NOW: &str = "2026-11-11T00:00:00.000Z";

fn add_scene(conn: &Connection, project: &str, id: &str, parent: Option<&str>) -> Result<()> {
    conn.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order)
         VALUES (?1, ?2, ?3, 'scene', 'Scene', ?1)",
        params![id, project, parent],
    )?;
    ensure_scene_scope_binding_in_tx(
        conn,
        project,
        id,
        NOW,
        crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
    )?;
    Ok(())
}

/// p1: a folder with scenes `a1`, `a10`, `A1` and `シーン` (ids that are a prefix
/// of one another, differ in case only, or are not ASCII), a scene that is
/// archived, a scene with a character principal's row to join, and a note.
/// p2: one scene.
fn fixture() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        for project in ["p1", "p2"] {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES (?1, 'Project')",
                [project],
            )?;
        }
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name)
             VALUES ('c1', 'p1', 'character', 'Character')",
            [],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
             VALUES ('f1', 'p1', 'folder', 'Folder', 'a0')",
            [],
        )?;
        for id in ["a1", "a10", "A1", "\u{30b7}\u{30fc}\u{30f3}", "arch", "a3"] {
            add_scene(conn, "p1", id, Some("f1"))?;
        }
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order)
             VALUES ('n1', 'p1', 'f1', 'note', 'Note', 'zz')",
            [],
        )?;
        add_scene(conn, "p2", "z1", None)?;
        Ok(())
    })
    .expect("seed projects");
    db
}

fn entries_of(
    conn: &Connection,
    ownership: SceneOwnership<'_>,
) -> Result<(Vec<Value>, ScopeExtensionParts)> {
    let mut entries = Vec::new();
    let parts = read_scope_extension_entries(conn, "p1", true, ownership, |entry| {
        entries.push(entry);
        Ok(())
    })?;
    Ok((entries, parts))
}

fn scene_ids_of(conn: &Connection, project: &str) -> Result<ProjectSceneIds> {
    let ids = conn
        .prepare("SELECT id FROM tree_nodes WHERE project_id = ?1 AND node_type = 'scene'")?
        .query_map([project], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ProjectSceneIds::from_unsorted(ids.iter().map(String::as_str)))
}

/// The set and the join agree on everything the extension produces and the
/// authority derives from it. Returns how many entries are `unavailable`.
fn assert_set_equals_join(db: &Database, step: &str) -> usize {
    db.with_read_transaction(|conn| {
        let ids = scene_ids_of(conn, "p1")?;
        let (set_entries, set_parts) = entries_of(conn, SceneOwnership::Set(&ids))?;
        let (join_entries, join_parts) = entries_of(conn, SceneOwnership::LegacyJoin)?;
        assert_eq!(set_entries, join_entries, "{step}: entries (rawDigest too)");
        assert_eq!(
            set_parts.scene_bindings, join_parts.scene_bindings,
            "{step}"
        );
        assert_eq!(set_parts.registry, join_parts.registry, "{step}");
        assert_eq!(
            read_scope_extension(conn, "p1", true, SceneOwnership::Set(&ids))?.digest,
            read_scope_extension(conn, "p1", true, SceneOwnership::LegacyJoin)?.digest,
            "{step}: extension digest"
        );

        let key = "project:scope-authority:p1";
        let new = load_live_project_scope_authority_with_scene_bindings(conn, "p1", key)?;
        let old = load_live_project_scope_authority_with_legacy_join(conn, "p1", key, true)?;
        assert_eq!(
            new.authority.source.revision_token, old.authority.source.revision_token,
            "{step}: authority revision token"
        );
        assert_eq!(new.scene_bindings, old.scene_bindings, "{step}");
        Ok(set_entries
            .iter()
            .filter(|entry| entry["status"] == "unavailable")
            .count())
    })
    .unwrap_or_else(|error| panic!("{step}: {error:#}"))
}

#[test]
fn the_scene_id_set_gives_the_joins_result_on_healthy_and_damaged_projects() {
    let db = fixture();
    assert_eq!(assert_set_equals_join(&db, "healthy"), 0);

    // An archived Scene is still the project's Scene: the join never looked at
    // `archived_at`.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET archived_at = ?1 WHERE id = 'arch'",
            [NOW],
        )?;
        Ok(())
    })
    .expect("archive a Scene");
    assert_eq!(assert_set_equals_join(&db, "archived scene"), 0);

    // Damage a healthy database cannot hold: foreign keys and CHECKs off.
    db.with_conn(|conn| {
        conn.execute("PRAGMA foreign_keys = OFF", [])?;
        conn.execute("PRAGMA ignore_check_constraints = ON", [])?;
        Ok(())
    })
    .expect("allow damage");

    // The node a binding names is a note, then a folder.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET node_type = 'note' WHERE id = 'a3'",
            [],
        )?;
        Ok(())
    })
    .expect("scene becomes a note");
    assert_eq!(assert_set_equals_join(&db, "binding of a note"), 1);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET node_type = 'folder' WHERE id = 'a3'",
            [],
        )?;
        // A binding that names a note that was never a Scene.
        conn.execute(
            "INSERT INTO narrative_scene_scope_bindings
                 (project_id, scene_id, scene_incarnation_id, compatibility_marker,
                  query_identity_json, material_constraint_json, knowledge_holder_json,
                  audience_json, version, source_token, updated_at)
             SELECT project_id, 'n1', scene_incarnation_id, compatibility_marker,
                    query_identity_json, material_constraint_json, knowledge_holder_json,
                    audience_json, version, source_token, updated_at
               FROM narrative_scene_scope_bindings WHERE scene_id = 'a1'",
            [],
        )?;
        Ok(())
    })
    .expect("folder and note bindings");
    assert_eq!(
        assert_set_equals_join(&db, "binding of a folder and a note"),
        2
    );

    // A binding of project p1 that names a Scene of project p2.
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_scene_scope_bindings
                 (project_id, scene_id, scene_incarnation_id, compatibility_marker,
                  query_identity_json, material_constraint_json, knowledge_holder_json,
                  audience_json, version, source_token, updated_at)
             SELECT 'p1', scene_id, scene_incarnation_id, compatibility_marker,
                    query_identity_json, material_constraint_json, knowledge_holder_json,
                    audience_json, version, source_token, updated_at
               FROM narrative_scene_scope_bindings WHERE project_id = 'p2'",
            [],
        )?;
        Ok(())
    })
    .expect("another project's scene");
    assert_eq!(assert_set_equals_join(&db, "scene of another project"), 3);

    // A Scene that does not exist.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET scene_id = 'ghost'
              WHERE project_id = 'p1' AND scene_id = '\u{30b7}\u{30fc}\u{30f3}'",
            [],
        )?;
        Ok(())
    })
    .expect("scene is missing");
    assert_eq!(assert_set_equals_join(&db, "missing scene"), 4);

    // A scene id that is not text: a BLOB, never equal to a node's TEXT id.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET scene_id = x'6131'
              WHERE project_id = 'p1' AND scene_id = 'a1'",
            [],
        )?;
        Ok(())
    })
    .expect("blob scene id");
    assert_eq!(assert_set_equals_join(&db, "blob scene id"), 5);

    // Ids that differ from a Scene's only by case or by a suffix are not it.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET scene_id = 'a2'
              WHERE project_id = 'p1' AND scene_id = 'a10'",
            [],
        )?;
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET scene_id = 'a'
              WHERE project_id = 'p1' AND scene_id = 'A1'",
            [],
        )?;
        Ok(())
    })
    .expect("near-miss scene ids");
    assert_eq!(assert_set_equals_join(&db, "near-miss ids"), 7);
}

#[test]
fn an_integer_scene_id_is_stored_as_the_text_the_join_compared() {
    let db = fixture();
    db.with_conn(|conn| {
        add_scene(conn, "p1", "7", Some("f1"))?;
        // The column has TEXT affinity: the integer is stored as '7'.
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET scene_id = 7
              WHERE project_id = 'p1' AND scene_id = '7'",
            [],
        )?;
        let kind: String = conn.query_row(
            "SELECT typeof(scene_id) FROM narrative_scene_scope_bindings WHERE scene_id = '7'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(kind, "text");
        Ok(())
    })
    .expect("integer scene id");
    assert_eq!(assert_set_equals_join(&db, "integer scene id"), 0);
}

#[test]
fn a_binding_whose_scene_is_not_the_projects_is_unavailable_with_the_same_digest() {
    // The `rawDigest` of an unavailable row carries `sceneOwned`: the set must
    // put the same 0 there the join did, not merely reject the row.
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute("PRAGMA foreign_keys = OFF", [])?;
        conn.execute("DELETE FROM tree_nodes WHERE id = 'a3'", [])?;
        Ok(())
    })
    .expect("delete the node of a binding");
    db.with_read_transaction(|conn| {
        let ids = scene_ids_of(conn, "p1")?;
        let (set_entries, _) = entries_of(conn, SceneOwnership::Set(&ids))?;
        let (join_entries, _) = entries_of(conn, SceneOwnership::LegacyJoin)?;
        let missing: Vec<&Value> = set_entries
            .iter()
            .filter(|entry| entry["sceneId"] == "a3")
            .collect();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0]["status"], "unavailable");
        assert!(set_entries == join_entries);
        Ok(())
    })
    .expect("compare");
}

#[test]
fn the_extension_statement_does_not_read_tree_nodes() {
    let db = fixture();
    db.with_read_transaction(|conn| {
        let ids = scene_ids_of(conn, "p1")?;
        let tables = |sql: &str| -> Result<String> {
            let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement
                .query_map(params!["p1"], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join("\n"))
        };
        assert!(!tables(SCOPE_EXTENSION_SQL)?.contains("tree_nodes"));
        assert!(tables(SCOPE_EXTENSION_LEGACY_JOIN_SQL)?.contains("tree_nodes"));

        // The whole read, by the tables SQLite is asked to authorize reads of.
        let read = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&read);
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if let AuthAction::Read { table_name, .. } = context.action {
                sink.lock().unwrap().push(table_name.to_owned());
            }
            Authorization::Allow
        }))?;
        let result = read_scope_extension(conn, "p1", true, SceneOwnership::Set(&ids));
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        result?;
        let read = read.lock().unwrap();
        assert!(read
            .iter()
            .any(|table| table == "narrative_scene_scope_bindings"));
        assert!(
            read.iter().all(|table| table != "tree_nodes"),
            "the extension read tree_nodes: {read:?}"
        );
        Ok(())
    })
    .expect("authorized reads");
}

#[test]
fn the_scene_id_set_is_sorted_deduplicated_and_compared_by_bytes() {
    let ids = ProjectSceneIds::from_unsorted(["b", "a10", "A1", "a1", "a1", "\u{30b7}"]);
    assert_eq!(ids.ids(), ["A1", "a1", "a10", "b", "\u{30b7}"]);
    for member in ["A1", "a1", "a10", "b", "\u{30b7}"] {
        assert!(ids.contains(member), "{member}");
    }
    for stranger in ["", "a", "a2", "B", "a1 ", "\u{30b8}"] {
        assert!(!ids.contains(stranger), "{stranger}");
    }
}
