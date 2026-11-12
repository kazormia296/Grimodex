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

/// [`read_scope_extension_entries`] before DR-CQA-9, verbatim: the raw observation of every row built up front, the
/// registry validated and serialized for every binding. The oracle the loop is checked against.
fn read_scope_extension_entries_before_dr_cqa_9(
    conn: &Connection,
    project_id: &str,
    collect_scene_bindings: bool,
    ownership: SceneOwnership<'_>,
    mut on_entry: impl FnMut(Value) -> Result<()>,
) -> Result<ScopeExtensionParts> {
    anyhow::ensure!(
        table_exists(conn, "narrative_scope_registries")?
            && table_exists(conn, "narrative_scene_scope_bindings")?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
    );
    #[cfg(test)]
    project_read_probe::record(project_read_probe::Read::ScopeExtension);
    let registry = read_registry_in_tx(conn, project_id)?;
    let (registry_revision, registry_source_token, _) = read_registry_row(conn, project_id)?;
    let mut scene_bindings = BTreeMap::new();
    let (sql, scene_ids) = match ownership {
        SceneOwnership::Set(ids) => (SCOPE_EXTENSION_SQL, Some(ids)),
        #[cfg(test)]
        SceneOwnership::LegacyJoin => (SCOPE_EXTENSION_LEGACY_JOIN_SQL, None),
    };
    let mut statement = conn.prepare(sql)?;
    let rows = statement
        .query_map(params![project_id], |row| {
            let mut values = Vec::with_capacity(13);
            match scene_ids {
                // The statement does not read `tree_nodes`: it returns the 12
                // other columns, and `sceneOwned` goes in as the eleventh
                // with the same value (a 0/1 integer) the join gave it.
                Some(scene_ids) => {
                    for index in 0..10 {
                        values.push(row.get::<_, SqlValue>(index)?);
                    }
                    let scene_owned = match &values[0] {
                        SqlValue::Text(scene_id) => scene_ids.contains(scene_id),
                        _ => false,
                    };
                    values.push(SqlValue::Integer(i64::from(scene_owned)));
                    values.push(row.get::<_, SqlValue>(10)?);
                    values.push(row.get::<_, SqlValue>(11)?);
                }
                None => {
                    for index in 0..13 {
                        values.push(row.get::<_, SqlValue>(index)?);
                    }
                }
            }
            Ok(values)
        })?
        .collect::<rusqlite::Result<Vec<Vec<_>>>>()?;
    for raw_values in rows {
        let scene_id_hint = raw_values
            .first()
            .and_then(|value| match value {
                SqlValue::Text(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "<invalid-scene-id>".to_owned());
        let raw = scene_scope_digest_raw_row(&raw_values);
        let binding = (|| -> Result<Option<NarrativeSceneScopeBindingV1>> {
            let [scene_id, incarnation, marker, query_identity, material_constraint, knowledge_holder, version, audience, source_token, updated_at, scene_owned, knowledge_holder_owned, audience_owned] =
                raw_values
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("scene scope row has an invalid column count"))?;
            let scene_id = material_scope_text(scene_id)?;
            let incarnation = material_scope_text(incarnation)?;
            let marker = material_scope_text(marker)?;
            let query_identity = material_scope_text(query_identity)?;
            let material_constraint = material_scope_text(material_constraint)?;
            let knowledge_holder = material_scope_text(knowledge_holder)?;
            let version = material_scope_integer(version)?;
            let audience = material_scope_text(audience)?;
            let source_token = material_scope_text(source_token)?;
            let updated_at = material_scope_text(updated_at)?;
            let scene_owned = material_scope_integer(scene_owned)?;
            let knowledge_holder_owned = material_scope_integer(knowledge_holder_owned)?;
            let audience_owned = material_scope_integer(audience_owned)?;
            anyhow::ensure!(
                scene_owned == 1,
                "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope binding scene '{scene_id}' is missing or belongs to another project"
            );
            let mut binding = parse_binding_row(
                project_id,
                &scene_id,
                (
                    incarnation,
                    marker,
                    query_identity,
                    material_constraint,
                    knowledge_holder,
                    version,
                    audience,
                    source_token,
                ),
            )?;
            binding.updated_at = updated_at;
            narrative_scene_scope::validate_binding(&binding, &registry)?;
            if matches!(
                binding.knowledge_holder,
                NarrativeScopePrincipalV1::Character { .. }
            ) {
                anyhow::ensure!(
                    knowledge_holder_owned == 1,
                    "knowledgeHolder character is not in project '{project_id}'"
                );
            }
            if matches!(
                binding.audience,
                NarrativeScopePrincipalV1::Character { .. }
            ) {
                anyhow::ensure!(
                    audience_owned == 1,
                    "audience character is not in project '{project_id}'"
                );
            }
            let expected_token = narrative_scene_scope::source_token(&registry, &binding)?;
            anyhow::ensure!(
                binding.source_token == expected_token,
                "NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID: scene scope source token does not match its state"
            );
            Ok(Some(binding))
        })();
        match binding {
            Ok(Some(binding)) => {
                if collect_scene_bindings {
                    scene_bindings.insert(binding.scene_id.clone(), binding.clone());
                }
                on_entry(serde_json::to_value(binding)?)?;
            }
            Ok(None) => {}
            Err(_) => on_entry(json!({
                "sceneId": scene_id_hint,
                "status": "unavailable",
                "rawDigest": grimodex_core::canonical_json_digest(&raw)?,
            }))?,
        }
    }
    Ok(ScopeExtensionParts {
        registry,
        registry_revision,
        registry_source_token,
        scene_bindings,
    })
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

fn legacy_entries_of(
    conn: &Connection,
    ownership: SceneOwnership<'_>,
) -> Result<(Vec<Value>, ScopeExtensionParts)> {
    let mut entries = Vec::new();
    let parts =
        read_scope_extension_entries_before_dr_cqa_9(conn, "p1", true, ownership, |entry| {
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
        // DR-CQA-9: the loop itself, against the loop before it (the raw
        // observation made up front, the registry prepared per binding).
        let (old_entries, old_parts) = legacy_entries_of(conn, SceneOwnership::Set(&ids))?;
        assert_eq!(
            set_entries, old_entries,
            "{step}: entries against the old loop"
        );
        assert_eq!(set_parts.scene_bindings, old_parts.scene_bindings, "{step}");
        assert_eq!(set_parts.registry, old_parts.registry, "{step}");
        assert_eq!(
            set_parts.registry_revision, old_parts.registry_revision,
            "{step}"
        );
        assert_eq!(
            set_parts.registry_source_token, old_parts.registry_source_token,
            "{step}"
        );
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

#[test]
fn a_damaged_row_of_each_kind_gives_the_old_loops_entry_and_digest() {
    // Each damage on its own row of a fresh project: the loop that builds the
    // raw observation only for an unavailable row, and the prepared registry,
    // answer what the old loop answered (entries with their rawDigest, the
    // collected bindings, the registry parts).
    let damages: [(&str, &str); 10] = [
        ("holder is not JSON", "UPDATE narrative_scene_scope_bindings SET knowledge_holder_json = 'not json' WHERE scene_id = 'a1'"),
        ("holder names no character", "UPDATE narrative_scene_scope_bindings SET knowledge_holder_json = '{\"kind\":\"character\",\"ref\":\"nobody\"}' WHERE scene_id = 'a1'"),
        ("audience names a character", "UPDATE narrative_scene_scope_bindings SET audience_json = '{\"kind\":\"character\",\"ref\":\"c1\"}' WHERE scene_id = 'a1'"),
        ("token is wrong", "UPDATE narrative_scene_scope_bindings SET source_token = 'sha256:wrong' WHERE scene_id = 'a1'"),
        ("marker is unknown", "UPDATE narrative_scene_scope_bindings SET compatibility_marker = 'weird' WHERE scene_id = 'a1'"),
        ("version is text", "UPDATE narrative_scene_scope_bindings SET version = 'abc' WHERE scene_id = 'a1'"),
        ("version is zero", "UPDATE narrative_scene_scope_bindings SET version = 0 WHERE scene_id = 'a1'"),
        ("incarnation is a blob", "UPDATE narrative_scene_scope_bindings SET scene_incarnation_id = x'00' WHERE scene_id = 'a1'"),
        ("query identity is empty", "UPDATE narrative_scene_scope_bindings SET query_identity_json = '{}' WHERE scene_id = 'a1'"),
        ("updated_at is blank", "UPDATE narrative_scene_scope_bindings SET updated_at = '' WHERE scene_id = 'a1'"),
    ];
    for (name, damage) in damages {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute("PRAGMA foreign_keys = OFF", [])?;
            conn.execute("PRAGMA ignore_check_constraints = ON", [])?;
            conn.execute(damage, [])?;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("{name}: {error:#}"));
        assert!(assert_set_equals_join(&db, name) >= 1, "{name}");
    }
}

// `read_registry_in_tx` refuses a registry that fails `validate_registry`
// before the loop starts, so the whole read fails with the same error in the
// new and the old loop. The loop's own fallback (a registry that cannot be
// prepared) is a defence and is not reached by any stored registry.
#[test]
fn a_registry_that_read_registry_refuses_fails_the_whole_read_as_before() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute("PRAGMA ignore_check_constraints = ON", [])?;
        conn.execute(
            "UPDATE narrative_scope_registries SET timeline_refs_json = '[\"x\",\"x\"]' WHERE project_id = 'p1'",
            [],
        )?;
        Ok(())
    })
    .expect("damage the registry");
    db.with_read_transaction(|conn| {
        let ids = scene_ids_of(conn, "p1")?;
        let new = entries_of(conn, SceneOwnership::Set(&ids));
        let old = legacy_entries_of(conn, SceneOwnership::Set(&ids));
        match (new, old) {
            (Ok((new, _)), Ok((old, _))) => assert_eq!(new, old),
            (Err(new), Err(old)) => assert_eq!(format!("{new:#}"), format!("{old:#}")),
            (new, old) => panic!(
                "different outcomes: {:?} against {:?}",
                new.map(|value| value.0.len()).map_err(|e| e.to_string()),
                old.map(|value| value.0.len()).map_err(|e| e.to_string()),
            ),
        }
        Ok(())
    })
    .expect("compare");
}
