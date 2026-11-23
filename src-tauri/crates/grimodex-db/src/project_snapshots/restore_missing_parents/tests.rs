//! Guards of the missing-parent step (DR-SRX-26..34).
//!
//! `MISSING_PARENT_EDGES` and `DEPENDENTS` are fixed, hand-classified lists so
//! that every statement is built from constants. These tests derive the foreign
//! keys again from the real schema (`PRAGMA foreign_key_list`) and who owns
//! which table, for every combination of scopes, and fail when a foreign key
//! that a restore can leave dangling has not been classified. They are what
//! keeps the list complete (the run-time safety net is the dangling check of
//! `restore_links`, over the tables listed here).

use std::collections::{BTreeSet, HashSet};

use super::super::restore_links::{Parent, KIND_ORDER};
use super::super::restore_test_support::{
    foreign_keys, replaced, schema_foreign_keys, table_owner, ALL_SCOPES,
};
use super::*;

/// Parents a restore replaces but whose snapshot does not hold every live row:
/// a live row of one of them can survive a restore that replaces the scope.
const PARTIAL_PARENTS: &[&str] = &["post_effect_annotations"];

/// Foreign keys the canonical plan (or `reshape_authorship_inserts`) already
/// deals with before this step runs. They are older, they do not tell the author
/// (DR-SRX-30, PR body "remaining limits"), and this step leaves them alone.
const CANONICAL_FILTERED: &[(&str, &str, &str)] = &[
    (
        "authorship_spans",
        "codex_entry_id",
        "reshape_authorship_inserts: the document must exist after the restore",
    ),
    (
        "authorship_spans",
        "detail_value_id",
        "reshape_authorship_inserts: the document must exist after the restore",
    ),
    (
        "authorship_spans",
        "phase_id",
        "reshape_authorship_inserts: the document must exist after the restore",
    ),
    (
        "authorship_spans",
        "snippet_id",
        "reshape_authorship_inserts: the document must exist after the restore",
    ),
    (
        "authorship_spans",
        "sticky_id",
        "reshape_authorship_inserts: the document must exist after the restore",
    ),
    (
        "codex_entries",
        "source_chat_message_id",
        "canonical plan: always inserted as NULL",
    ),
    (
        "editor_stickies",
        "chronicle_event_id",
        "canonical plan: a sticky whose unselected owner is gone is left out",
    ),
    (
        "editor_stickies",
        "codex_entry_id",
        "canonical plan: a sticky whose unselected owner is gone is left out",
    ),
    (
        "editor_stickies",
        "phase_id",
        "canonical plan: a sticky whose unselected owner is gone is left out",
    ),
    (
        "editor_stickies",
        "snippet_id",
        "canonical plan: a sticky whose unselected owner is gone is left out",
    ),
    (
        "editor_stickies",
        "tree_node_id",
        "canonical plan: a sticky whose unselected owner is gone is left out",
    ),
    (
        "event_participants",
        "codex_entry_id",
        "canonical plan: a participant whose entry is gone is left out",
    ),
    (
        "events",
        "location_codex_id",
        "canonical plan: set to NULL when the entry is gone",
    ),
    (
        "events",
        "primary_codex_id",
        "canonical plan: set to NULL when the entry is gone",
    ),
    (
        "foreshadow_codex_links",
        "codex_entry_id",
        "canonical plan: a link whose entry is gone is left out",
    ),
    (
        "foreshadow_payoffs",
        "scene_id",
        "canonical plan: a payoff whose scene is gone is left out",
    ),
    (
        "foreshadow_setups",
        "scene_id",
        "canonical plan: a setup whose scene is gone is left out",
    ),
    (
        "foreshadows",
        "payoff_scene_id",
        "canonical plan: set to NULL when the scene is gone",
    ),
    (
        "lint_ignored_diagnostics",
        "scene_id",
        "canonical plan: an ignore whose scene is gone is left out",
    ),
    (
        "scene_beat_pov_cache",
        "pov_character_id",
        "canonical plan: a cache row whose character is gone is left out",
    ),
    (
        "scene_codex_mentions",
        "codex_entry_id",
        "canonical plan: a mention whose entry is gone is left out",
    ),
    (
        "scene_codex_pins",
        "entry_id",
        "canonical plan: a pin whose entry is gone is left out",
    ),
    (
        "snippet_entry_tags",
        "tag_id",
        "canonical plan: a tag link whose tag is gone is left out",
    ),
    (
        "snippets",
        "scene_id",
        "canonical plan: set to NULL when the scene is gone (P10)",
    ),
    (
        "tree_node_labels",
        "node_id",
        "canonical plan: a label link whose scene is gone is left out",
    ),
    (
        "tree_nodes",
        "location_id",
        "canonical plan: set to NULL when the entry is gone",
    ),
    (
        "tree_nodes",
        "pov_character_id",
        "canonical plan: set to NULL when the entry is gone",
    ),
];

/// Foreign keys that need no edge, with the reason.
const EXEMPT: &[(&str, &str, &str)] = &[(
    "post_effect_annotation_relations",
    "annotation_a_id",
    "a relation is captured by its annotation A (a scene's annotation, which is \
     in the snapshot), so A is in the plan; if A is left out, `DEPENDENTS` takes the relation",
)];

/// Foreign keys whose `ON DELETE` is `RESTRICT`, made `SET NULL` by a trigger
/// (DR-SRX-29), with the trigger the guard looks for.
const TRIGGER_BACKED: &[(&str, &str, &str)] = &[(
    "snippets",
    "source_chat_message_id",
    "chat_message_source_provenance_delete",
)];

fn parent_table(parent: ParentRef) -> &'static str {
    match parent {
        ParentRef::TreeNodes => "tree_nodes",
        ParentRef::CodexEntries => "codex_entries",
        ParentRef::Snippets => "snippets",
        ParentRef::ChatMessages => "chat_messages",
        ParentRef::ChatSessions => "chat_sessions",
        ParentRef::PostEffectRuns => "post_effect_runs",
        ParentRef::PostEffectAnnotations => "post_effect_annotations",
    }
}

fn all_scope_sets() -> Vec<HashSet<RestoreScope>> {
    (1u32..(1 << ALL_SCOPES.len()))
        .map(|mask| {
            ALL_SCOPES
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, scope)| *scope)
                .collect()
        })
        .collect()
}

/// The foreign keys a restore can leave dangling: the table is inserted again
/// from the snapshot, and the parent is not given back in full by the same
/// restore (its scope is not selected, no scope owns it, or the snapshot does
/// not hold all of its rows). Derived from the schema alone, for every
/// combination of scopes, with and without the Chronicle in the snapshot.
fn derived_edges() -> BTreeSet<(String, String, String, String)> {
    let fks = schema_foreign_keys();
    assert!(
        fks.iter().any(|fk| fk.table == "map_node_positions"),
        "the schema copy has the foreign keys"
    );
    let mut needs = BTreeSet::new();
    for events_aux in [true, false] {
        for scopes in all_scope_sets() {
            for fk in &fks {
                // `validate_insert_project` pins `project_id` (and the rows a
                // table reaches through its board or entry are of that project).
                if fk.parent == "projects" || !replaced(&fk.table, &scopes, events_aux) {
                    continue;
                }
                let given = replaced(&fk.parent, &scopes, events_aux)
                    && !PARTIAL_PARENTS.contains(&fk.parent.as_str());
                if !given {
                    needs.insert((
                        fk.table.clone(),
                        fk.column.clone(),
                        fk.parent.clone(),
                        fk.on_delete.clone(),
                    ));
                }
            }
        }
    }
    needs
}

fn key(table: &str, column: &str) -> (String, String) {
    (table.to_string(), column.to_string())
}

#[test]
fn every_foreign_key_a_restore_can_leave_dangling_is_classified_exactly_once() {
    let derived = derived_edges();
    let derived_keys: BTreeSet<(String, String)> = derived
        .iter()
        .map(|(table, column, _, _)| key(table, column))
        .collect();
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    let mut classify = |category: &str, table: &str, column: &str| {
        let k = key(table, column);
        assert!(
            derived_keys.contains(&k),
            "{category} lists {table}.{column}, which no restore can leave dangling \
             (a stale entry): remove it"
        );
        assert!(
            seen.insert(k),
            "{table}.{column} is classified twice: it must be in exactly one of \
             MISSING_PARENT_EDGES, CANONICAL_FILTERED, EXEMPT"
        );
    };
    for edge in MISSING_PARENT_EDGES {
        classify("MISSING_PARENT_EDGES", edge.table.as_str(), edge.column);
    }
    for (table, column, reason) in CANONICAL_FILTERED {
        assert!(!reason.is_empty());
        classify("CANONICAL_FILTERED", table, column);
    }
    for (table, column, reason) in EXEMPT {
        assert!(!reason.is_empty());
        classify("EXEMPT", table, column);
    }
    let unclassified: Vec<_> = derived_keys.difference(&seen).collect();
    assert!(
        unclassified.is_empty(),
        "classify it: a restore can leave these foreign keys dangling (a snapshot row names a \
         parent the restore does not give back), and none of MISSING_PARENT_EDGES, \
         CANONICAL_FILTERED or EXEMPT covers them: {unclassified:?}\n\
         A new foreign key into a scene, Codex entry, Snippet, chat or analysis row needs this \
         once (DR-SRX-32). Pick one: (1) the restore must give the row back in the form the \
         database has after the parent is deleted: add an edge to MISSING_PARENT_EDGES in \
         restore_missing_parents.rs (SetNull for ON DELETE SET NULL; DropRow for CASCADE, and \
         put the tables that cascade to it in DEPENDENTS), with a kind from \
         restore_links::KIND_ORDER (a new kind goes there, and it is what the author is told); \
         (2) the canonical plan already filters it (build_canonical_restore_plan, same as the \
         renderer's plan): list it in CANONICAL_FILTERED in this file with the reason; \
         (3) it cannot dangle: EXEMPT, with the reason. A restore-links column of a scope that \
         is NOT selected is a different list: PARK_COLUMNS in restore_links.rs."
    );
}

fn column_is_nullable(conn: &Connection, table: &str, column: &str) -> bool {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .unwrap();
    let rows: Vec<(String, i64)> = statement
        .query_map([], |row| Ok((row.get(1)?, row.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let (_, notnull) = rows
        .into_iter()
        .find(|(name, _)| name == column)
        .unwrap_or_else(|| panic!("{table}.{column} is not a column"));
    notnull == 0
}

#[test]
fn every_edge_is_a_real_foreign_key_with_the_parent_owner_and_on_delete_it_says() {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| {
        let fks = foreign_keys(conn);
        for edge in MISSING_PARENT_EDGES {
            let table = edge.table.as_str();
            let fk = fks
                .iter()
                .find(|fk| fk.table == table && fk.column == edge.column)
                .unwrap_or_else(|| panic!("{table}.{} is not a foreign key", edge.column));
            assert_eq!(
                fk.parent,
                parent_table(edge.parent),
                "{table}.{}: parent",
                edge.column
            );
            // How `existing_ids` finds the parent after the restore follows from
            // these two; they are written by hand next to the schema's truth.
            assert_eq!(
                edge.parent.replaced_by(),
                table_owner(&fk.parent),
                "{table}.{}: `ParentRef::replaced_by` must be the scope that replaces `{}`",
                edge.column,
                fk.parent
            );
            assert_eq!(
                edge.parent.partial(),
                PARTIAL_PARENTS.contains(&fk.parent.as_str()),
                "{table}.{}: `ParentRef::partial` and PARTIAL_PARENTS must agree about `{}`",
                edge.column,
                fk.parent
            );
            assert_eq!(
                table_owner(table),
                Some(edge.owner),
                "{table}.{}: the scope that replaces the table",
                edge.column
            );
            match edge.action {
                Action::DropRow => assert_eq!(
                    fk.on_delete, "CASCADE",
                    "{table}.{}: a row that is left out must CASCADE",
                    edge.column
                ),
                Action::SetNull => {
                    let trigger = TRIGGER_BACKED
                        .iter()
                        .find(|(t, c, _)| *t == table && *c == edge.column);
                    match trigger {
                        None => assert_eq!(
                            fk.on_delete, "SET NULL",
                            "{table}.{}: a column that is cleared must be SET NULL \
                             (or listed in TRIGGER_BACKED with its trigger)",
                            edge.column
                        ),
                        Some((_, _, name)) => {
                            assert_eq!(fk.on_delete, "RESTRICT", "{table}.{}", edge.column);
                            // The trigger is what makes deleting the parent clear the
                            // column, so "the same as deleting it" is NULL (DR-SRX-29).
                            let sql: String = conn
                                .query_row(
                                    "SELECT sql FROM sqlite_master
                                      WHERE type = 'trigger' AND name = ?1",
                                    [name],
                                    |row| row.get(0),
                                )
                                .unwrap_or_else(|_| panic!("trigger {name} is gone"));
                            assert!(
                                sql.contains(&format!("UPDATE {table} SET {} = NULL", edge.column)),
                                "trigger {name} no longer clears {table}.{}",
                                edge.column
                            );
                        }
                    }
                    assert!(
                        column_is_nullable(conn, table, edge.column),
                        "{table}.{} must be nullable to be cleared",
                        edge.column
                    );
                }
            }
            assert!(
                KIND_ORDER.contains(&edge.kind),
                "{table}.{}: `{}` is not a reported kind",
                edge.column,
                edge.kind
            );
            assert_ne!(edge.kind, table, "a kind is a fixed id, never a table name");
        }
        // Every edge names a distinct column.
        let names: BTreeSet<_> = MISSING_PARENT_EDGES
            .iter()
            .map(|edge| (edge.table.as_str(), edge.column))
            .collect();
        assert_eq!(names.len(), MISSING_PARENT_EDGES.len(), "no column twice");
        for dependent in DEPENDENTS {
            let table = dependent.table.as_str();
            let fk = fks
                .iter()
                .find(|fk| fk.table == table && fk.column == dependent.column)
                .unwrap_or_else(|| panic!("{table}.{} is not a foreign key", dependent.column));
            assert_eq!(fk.parent, dependent.parent.as_str(), "{table}: parent");
            assert_eq!(fk.on_delete, "CASCADE", "{table}.{}", dependent.column);
            assert_eq!(table_owner(table), Some(dependent.owner));
            assert!(KIND_ORDER.contains(&dependent.kind));
        }
        Ok(())
    })
    .expect("guard");
}

/// The tables whose rows this step can leave out, then the tables whose rows
/// cascade from those, until nothing is added.
fn droppable_tables() -> BTreeSet<&'static str> {
    let mut tables: BTreeSet<&'static str> = MISSING_PARENT_EDGES
        .iter()
        .filter(|edge| edge.action == Action::DropRow)
        .map(|edge| edge.table.as_str())
        .collect();
    loop {
        let before = tables.len();
        for dependent in DEPENDENTS {
            if tables.contains(dependent.parent.as_str()) {
                tables.insert(dependent.table.as_str());
            }
        }
        if tables.len() == before {
            return tables;
        }
    }
}

#[test]
fn every_foreign_key_into_a_row_that_can_be_left_out_is_a_dependent() {
    let fks = schema_foreign_keys();
    let droppable = droppable_tables();
    assert!(droppable.contains("map_edges"));
    assert!(droppable.contains("post_effect_annotation_relations"));
    for fk in fks
        .iter()
        .filter(|fk| droppable.contains(fk.parent.as_str()))
    {
        let listed = DEPENDENTS
            .iter()
            .any(|d| d.table.as_str() == fk.table && d.column == fk.column);
        assert!(
            listed,
            "{}.{} -> {} points at a row this step can leave out: add it to DEPENDENTS \
             (or, if it is not a CASCADE, decide what the author should be told)",
            fk.table, fk.column, fk.parent
        );
        assert_eq!(
            fk.on_delete, "CASCADE",
            "{}.{} -> {}: only CASCADE is followed (a SET NULL child needs its own rule)",
            fk.table, fk.column, fk.parent
        );
        // A child the restore does not replace would be left naming the row.
        assert!(
            table_owner(&fk.table).is_some(),
            "{}.{} -> {}: no scope replaces this table, so nothing would take its row",
            fk.table,
            fk.column,
            fk.parent
        );
        // `DEPENDENTS` only works when the child's scope is selected. A child of
        // another scope than its parent would stay in the live database, naming
        // a row this step left out, and the parent's CASCADE would delete it
        // without a word.
        assert_eq!(
            table_owner(&fk.table),
            table_owner(&fk.parent),
            "{}.{} -> {}: the child is replaced by a different scope than the parent, so a \
             restore of the parent's scope alone would leave the child behind: this step \
             cannot follow it (decide what the author should be told)",
            fk.table,
            fk.column,
            fk.parent
        );
    }
}

/// `plan_facts` treats the plan's rows of a `Parent` table as the rows that
/// survive the restore, so this step must never leave one out.
#[test]
fn rows_left_out_are_never_a_parent_the_restore_counts_on() {
    let droppable = droppable_tables();
    for parent in Parent::ALL {
        assert!(
            !droppable.contains(parent.table()),
            "{} is a Parent of restore_links: a row of it cannot be left out here",
            parent.table()
        );
    }
}

#[test]
fn the_kinds_are_fixed_ids_in_the_reported_order() {
    let unique: BTreeSet<_> = KIND_ORDER.iter().collect();
    assert_eq!(unique.len(), KIND_ORDER.len(), "no kind twice");
    let position = |kind: &str| KIND_ORDER.iter().position(|k| *k == kind).unwrap();
    for new in [
        "map_edges",
        "map_source_links",
        "snippet_source_message",
        "analysis_run_links",
        "analysis_annotations",
    ] {
        assert!(
            position(new) < position("scene_scope_bindings_reset"),
            "{new} is reported before the scene-scope reset"
        );
    }
}

/// The trigger really does what DR-SRX-29 says, on the real schema: every
/// snippet that names the deleted message loses its source (not only one), and
/// a snippet that names another message keeps it. (The guard above only reads
/// the trigger's SQL for the statement; this is what pins its meaning.)
#[test]
fn deleting_a_message_clears_a_snippets_source() {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'One');
             INSERT INTO chat_sessions (id, project_id, title) VALUES ('s1', 'p1', 'S');
             INSERT INTO chat_messages (id, session_id, role, content) VALUES ('m1', 's1', 'user', 'hi');
             INSERT INTO chat_messages (id, session_id, role, content) VALUES ('m2', 's1', 'user', 'hello');
             INSERT INTO snippets (id, project_id, title, content, source_chat_message_id)
               VALUES ('sn1', 'p1', 'T', '{}', 'm1'),
                      ('sn2', 'p1', 'T2', '{}', 'm1'),
                      ('sn3', 'p1', 'T3', '{}', 'm2');
             DELETE FROM chat_messages WHERE id = 'm1';",
        )?;
        let source_of = |id: &str| -> rusqlite::Result<Option<String>> {
            conn.query_row(
                "SELECT source_chat_message_id FROM snippets WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
        };
        assert_eq!(source_of("sn1")?, None);
        assert_eq!(source_of("sn2")?, None, "every snippet of the message");
        assert_eq!(
            source_of("sn3")?.as_deref(),
            Some("m2"),
            "a snippet of another message keeps its source"
        );
        Ok(())
    })
    .expect("trigger");
}

// ---------------------------------------------------------------------
// resolve on plain plans
// ---------------------------------------------------------------------

fn row(pairs: &[(&str, &str)]) -> serde_json::Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
        .collect()
}

fn insert(table: SnapshotRestoreTable, pairs: &[(&str, &str)]) -> SnapshotInsertPlan {
    SnapshotInsertPlan {
        table,
        row: row(pairs),
        mode: super::super::SnapshotInsertMode::Insert,
    }
}

fn body_shape(scopes: &HashSet<RestoreScope>) -> RestoreShape<'_> {
    RestoreShape {
        project_id: "p1",
        snapshot_id: "s",
        scopes,
        events_aux: true,
    }
}

/// An annotation chain whose root is missing is left out to the last leaf
/// (a fixed point), and a relation to any of them goes too. The post-effect
/// product never writes a scene-ful reply to a scene-less parent, so this edge
/// is exercised here on a constructed plan.
#[test]
fn a_chain_of_replies_and_their_relations_fall_away_to_a_fixed_point() {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| {
        conn.execute_batch("INSERT INTO projects (id, title) VALUES ('p1', 'One');")?;
        let scopes: HashSet<RestoreScope> = [RestoreScope::Body].into_iter().collect();
        use SnapshotRestoreTable as Tb;
        let plan = vec![
            insert(Tb::PostEffectAnnotations, &[("id", "ok")]),
            // Replies: c -> b -> a -> (missing root), and d -> ok.
            insert(
                Tb::PostEffectAnnotations,
                &[("id", "a"), ("parent_id", "root")],
            ),
            insert(
                Tb::PostEffectAnnotations,
                &[("id", "b"), ("parent_id", "a")],
            ),
            insert(
                Tb::PostEffectAnnotations,
                &[("id", "c"), ("parent_id", "b")],
            ),
            insert(
                Tb::PostEffectAnnotations,
                &[("id", "d"), ("parent_id", "ok")],
            ),
            insert(
                Tb::PostEffectAnnotationRelations,
                &[
                    ("id", "r1"),
                    ("annotation_a_id", "ok"),
                    ("annotation_b_id", "c"),
                ],
            ),
            insert(
                Tb::PostEffectAnnotationRelations,
                &[
                    ("id", "r2"),
                    ("annotation_a_id", "a"),
                    ("annotation_b_id", "ok"),
                ],
            ),
            insert(
                Tb::PostEffectAnnotationRelations,
                &[
                    ("id", "r3"),
                    ("annotation_a_id", "ok"),
                    ("annotation_b_id", "d"),
                ],
            ),
        ];
        let resolved = resolve(conn, &body_shape(&scopes), plan)?;
        let kept: Vec<&str> = resolved
            .plan
            .iter()
            .filter_map(|insert| insert.row.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(kept, vec!["ok", "d", "r3"]);
        assert_eq!(
            resolved.dropped.get("analysis_annotations").copied(),
            Some(5),
            "a, b, c, r1, r2"
        );
        assert_eq!(resolved.dropped.len(), 1);
        Ok(())
    })
    .expect("resolve");
}

/// A row that is left out is not also counted for the column that would have
/// been cleared, and a column cleared on two rows of one kind counts rows.
#[test]
fn a_row_is_counted_once() {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| {
        conn.execute_batch("INSERT INTO projects (id, title) VALUES ('p1', 'One');")?;
        let scopes: HashSet<RestoreScope> = [RestoreScope::Body].into_iter().collect();
        use SnapshotRestoreTable as Tb;
        let plan = vec![
            // Both its parent and its run are gone: left out, not also cleared.
            insert(
                Tb::PostEffectAnnotationRelations,
                &[
                    ("id", "r1"),
                    ("annotation_a_id", "x"),
                    ("annotation_b_id", "gone"),
                    ("run_id", "no-run"),
                ],
            ),
            insert(
                Tb::PostEffectAnnotations,
                &[("id", "x"), ("run_id", "no-run")],
            ),
            insert(
                Tb::PostEffectAnnotations,
                &[("id", "y"), ("run_id", "no-run")],
            ),
        ];
        let resolved = resolve(conn, &body_shape(&scopes), plan)?;
        assert_eq!(resolved.dropped.get("analysis_run_links").copied(), Some(2));
        assert_eq!(
            resolved.dropped.get("analysis_annotations").copied(),
            Some(1)
        );
        let nulled = resolved
            .plan
            .iter()
            .filter(|insert| insert.row.get("run_id") == Some(&Value::Null))
            .count();
        assert_eq!(nulled, 2);
        Ok(())
    })
    .expect("resolve");
}

/// A plan with none of the tables of an edge is returned as it is.
#[test]
fn a_plan_without_edge_tables_is_untouched() {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| {
        let scopes: HashSet<RestoreScope> = ALL_SCOPES.into_iter().collect();
        let plan = vec![
            insert(SnapshotRestoreTable::Labels, &[("id", "l1")]),
            insert(SnapshotRestoreTable::TreeNodes, &[("id", "s1")]),
        ];
        let resolved = resolve(conn, &body_shape(&scopes), plan.clone())?;
        assert!(resolved.dropped.is_empty());
        assert_eq!(resolved.plan.len(), plan.len());
        Ok(())
    })
    .expect("resolve");
}
