//! Guards of the restore's parking (DR-SRX-3, DR-SRX-9).
//!
//! `PARK_COLUMNS` is a fixed, hand-classified list so that every statement the
//! restore runs is built from constants. These tests derive the same list from
//! the real schema (`PRAGMA foreign_key_list`) and from who owns which table,
//! for every combination of scopes, and fail when the two disagree. A new
//! foreign key into a row a restore deletes, a renamed column or a changed
//! `ON DELETE` therefore stops here until a person has classified it.

use std::collections::{BTreeSet, HashSet};

use rusqlite::Connection;

use super::*;
use crate::project_snapshots::AUX_SPECS;

/// Foreign keys a restore never parks, with the reason. Everything else that
/// points at a row the restore deletes, from a table the restore does not
/// replace, is in `PARK_COLUMNS`.
const NOT_PARKED: &[(&str, &str, &str)] = &[
    (
        "change_events",
        "scene_id",
        "a protected table: parked by RestoreSceneIdParking (DR-SRX-9)",
    ),
    (
        "prose_staging",
        "scene_id",
        "parked per scene, not per parent (DR-SRX-8)",
    ),
    (
        "scene_chunks",
        "scene_id",
        "derived search index, rebuilt from the restored text (DR-SRX-5)",
    ),
    (
        "codex_chunks",
        "entry_id",
        "derived search index, rebuilt from the restored text (DR-SRX-5)",
    ),
    (
        "event_chunks",
        "event_id",
        "derived search index, rebuilt from the restored text (DR-SRX-5)",
    ),
    (
        "narrative_scene_scope_bindings",
        "scene_id",
        "made again by every Body restore, by contract (DR-SRX-5, 確認 117)",
    ),
];

/// The rows a restore deletes for each scope, as `apply_project_snapshot_restore`
/// does (the `events` and `project_calendar` ones when the snapshot has them).
fn roots(scope: RestoreScope) -> &'static [&'static str] {
    match scope {
        RestoreScope::Body => &["tree_nodes", "plot_threads", "events", "project_calendar"],
        RestoreScope::Codex => &[
            "codex_entries",
            "codex_types",
            "codex_tags",
            "codex_detail_definitions",
        ],
        RestoreScope::Snippet => &["snippets"],
        RestoreScope::Map => &["map_boards", "editor_stickies"],
        RestoreScope::Foreshadow => &["foreshadows"],
        RestoreScope::Labels => &["labels"],
        RestoreScope::Lint => &["lint_ignored_diagnostics", "lint_term_dictionary"],
    }
}

const ALL_SCOPES: [RestoreScope; 7] = [
    RestoreScope::Body,
    RestoreScope::Codex,
    RestoreScope::Snippet,
    RestoreScope::Map,
    RestoreScope::Foreshadow,
    RestoreScope::Labels,
    RestoreScope::Lint,
];

/// The scope whose restore replaces the table's rows; `None` when no scope
/// does (chat, trash, AI records, the Change Feed, ...).
fn table_owner(table: &str) -> Option<RestoreScope> {
    match table {
        "tree_nodes" => Some(RestoreScope::Body),
        "codex_entries" => Some(RestoreScope::Codex),
        "snippets" => Some(RestoreScope::Snippet),
        other => AUX_SPECS
            .iter()
            .find(|spec| spec.table == other)
            .map(|spec| spec.owner),
    }
}

#[derive(Debug)]
struct Fk {
    table: String,
    column: String,
    parent: String,
    on_delete: String,
}

fn foreign_keys(conn: &Connection) -> Vec<Fk> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut out = Vec::new();
    for table in tables {
        let mut statement = conn
            .prepare(&format!("PRAGMA foreign_key_list(\"{table}\")"))
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok(Fk {
                    table: table.clone(),
                    parent: row.get(2)?,
                    column: row.get(3)?,
                    on_delete: row.get(6)?,
                })
            })
            .unwrap();
        for row in rows {
            out.push(row.unwrap());
        }
    }
    out
}

fn schema_foreign_keys() -> Vec<Fk> {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| Ok(foreign_keys(conn)))
        .expect("foreign keys")
}

/// What a restore of `scopes` must park, derived from the schema alone.
fn derived(fks: &[Fk], scopes: &HashSet<RestoreScope>) -> BTreeSet<String> {
    let mut vanishing: HashSet<String> = scopes
        .iter()
        .flat_map(|scope| roots(*scope).iter().map(|table| table.to_string()))
        .collect();
    // A child the selected scopes own is deleted with its parent and inserted
    // again, so it is a vanishing parent in its turn.
    loop {
        let mut grew = false;
        for fk in fks {
            if fk.table == "authorship_spans" || fk.on_delete != "CASCADE" {
                continue;
            }
            let replaced = table_owner(&fk.table).is_some_and(|owner| scopes.contains(&owner));
            if vanishing.contains(&fk.parent) && replaced && vanishing.insert(fk.table.clone()) {
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    let mut parked = BTreeSet::new();
    for fk in fks {
        // `authorship_spans` is decided per row by the document it points at
        // (DR-SRX-7), not by column.
        if fk.table == "authorship_spans" || !vanishing.contains(&fk.parent) {
            continue;
        }
        let replaced = table_owner(&fk.table).is_some_and(|owner| scopes.contains(&owner));
        if replaced {
            continue;
        }
        if NOT_PARKED
            .iter()
            .any(|(table, column, _)| *table == fk.table && *column == fk.column)
        {
            continue;
        }
        match fk.on_delete.as_str() {
            "CASCADE" | "SET NULL" => {
                parked.insert(format!("{}.{} -> {}", fk.table, fk.column, fk.parent));
            }
            other => panic!(
                "{}.{} -> {} is {other}: a restore of {scopes:?} would be stopped (or \
                 left dangling) by a table it does not replace; classify it",
                fk.table, fk.column, fk.parent
            ),
        }
    }
    parked
}

fn fixed(scopes: &HashSet<RestoreScope>) -> BTreeSet<String> {
    let shape = RestoreShape {
        project_id: "p",
        snapshot_id: "s",
        scopes,
        events_aux: true,
    };
    shape
        .active_columns()
        .map(|column| {
            format!(
                "{}.{} -> {}",
                column.table,
                column.column,
                column.parent.table()
            )
        })
        .collect()
}

#[test]
fn the_fixed_list_is_what_the_schema_says_for_every_combination_of_scopes() {
    let fks = schema_foreign_keys();
    assert!(
        fks.iter().any(|fk| fk.table == "event_participants"),
        "the schema copy has the foreign keys"
    );
    for mask in 1u32..(1 << ALL_SCOPES.len()) {
        let scopes: HashSet<RestoreScope> = ALL_SCOPES
            .iter()
            .enumerate()
            .filter(|(i, _)| mask & (1 << i) != 0)
            .map(|(_, scope)| *scope)
            .collect();
        let want = derived(&fks, &scopes);
        let have = fixed(&scopes);
        assert_eq!(
            have,
            want,
            "PARK_COLUMNS disagrees with the schema for {scopes:?}\n  only in the list: {:?}\n  only in the schema: {:?}",
            have.difference(&want).collect::<Vec<_>>(),
            want.difference(&have).collect::<Vec<_>>(),
        );
    }
}

#[test]
fn every_entry_of_the_fixed_list_is_a_real_foreign_key_with_the_right_owner() {
    let fks = schema_foreign_keys();
    for column in PARK_COLUMNS {
        let fk = fks
            .iter()
            .find(|fk| fk.table == column.table && fk.column == column.column)
            .unwrap_or_else(|| panic!("{}.{} is not a foreign key", column.table, column.column));
        assert_eq!(
            fk.parent,
            column.parent.table(),
            "{}.{}: parent",
            column.table,
            column.column
        );
        let on_delete = match column.on_delete {
            OnDelete::Cascade => "CASCADE",
            OnDelete::SetNull => "SET NULL",
        };
        assert_eq!(
            fk.on_delete, on_delete,
            "{}.{}: ON DELETE",
            column.table, column.column
        );
        assert_eq!(
            table_owner(column.table),
            column.owner,
            "{}.{}: the scope that replaces the table",
            column.table,
            column.column
        );
    }
    // Every entry names a distinct column.
    let names: BTreeSet<_> = PARK_COLUMNS
        .iter()
        .map(|column| (column.table, column.column))
        .collect();
    assert_eq!(names.len(), PARK_COLUMNS.len(), "no column twice");
    // The one column parked per scene instead of per parent is not in the list.
    assert!(!names.contains(&("prose_staging", "scene_id")));
    assert!(!names.contains(&("change_events", "scene_id")));
}

#[test]
fn the_fixed_list_reports_each_kind_by_a_fixed_id_never_a_table_name() {
    for column in PARK_COLUMNS {
        if let Some(kind) = column.kind {
            assert!(
                KIND_ORDER.contains(&kind),
                "{}.{}: `{kind}` is not a reported kind",
                column.table,
                column.column
            );
        }
    }
    let unique: BTreeSet<_> = KIND_ORDER.iter().collect();
    assert_eq!(unique.len(), KIND_ORDER.len(), "no kind twice");
}

// ---------------------------------------------------------------------
// DR-SRX-9: the only write of `change_events` outside the append
// ---------------------------------------------------------------------

/// The part of a source file before its `#[cfg(test)]` module (declarations
/// `mod name;` do not count).
fn production_source(source: &str) -> &str {
    const MARKER: &str = "\n#[cfg(test)]\n";
    let mut from = 0;
    while let Some(offset) = source[from..].find(MARKER) {
        let at = from + offset;
        let line = source[at + MARKER.len()..].lines().next().unwrap_or("");
        if line.trim_start().starts_with("mod ") && line.trim_end().ends_with('{') {
            return &source[..at];
        }
        from = at + 1;
    }
    source
}

fn production_files() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).expect("read dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let relative = path
                    .strip_prefix(root)
                    .expect("relative")
                    .to_string_lossy()
                    .replace('\\', "/");
                let name = relative.rsplit('/').next().unwrap_or(&relative);
                if name.ends_with("_tests.rs")
                    || name == "tests.rs"
                    || name.starts_with("test_support")
                {
                    continue;
                }
                let source = std::fs::read_to_string(&path).expect("source");
                out.push((relative, production_source(&source).to_string()));
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out
}

#[test]
fn only_the_restore_calls_the_scene_id_parking_and_it_writes_nothing_else() {
    let files = production_files();
    // The type is named only by its own file and by the one file that calls it.
    let naming: BTreeSet<&str> = files
        .iter()
        .filter(|(_, source)| source.contains("RestoreSceneIdParking"))
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        naming,
        BTreeSet::from(["change_events.rs", "project_snapshots/restore_links.rs"]),
        "a new caller of the change_events parking needs the user's confirmation (DR-SRX-9)"
    );
    let calls: usize = files
        .iter()
        .map(|(_, source)| {
            source
                .matches("RestoreSceneIdParking::for_snapshot(")
                .count()
        })
        .sum();
    assert_eq!(calls, 1, "one place builds the parking: the restore");
    // The restore itself writes no `change_events` SQL.
    for (name, source) in &files {
        if name.starts_with("project_snapshots") {
            for needle in [
                "UPDATE change_events",
                "DELETE FROM change_events",
                "INSERT INTO change_events",
                "INSERT OR REPLACE INTO change_events",
            ] {
                assert!(
                    !source.contains(needle),
                    "{name} must not write change_events itself (`{needle}`)"
                );
            }
        }
    }
    // `change_events.rs` has exactly the three UPDATEs of the parking: park,
    // put back, and NULL when the scene is gone. Each one touches `scene_id`
    // and nothing else.
    let (_, change_events) = files
        .iter()
        .find(|(name, _)| name == "change_events.rs")
        .expect("change_events.rs");
    let updates: Vec<&str> = change_events
        .match_indices("UPDATE change_events")
        .map(|(at, _)| &change_events[at..])
        .collect();
    assert_eq!(
        updates.len(),
        3,
        "three UPDATEs of change_events, all of the parking"
    );
    for update in updates {
        let statement = update.split('"').next().unwrap_or(update);
        let assigned: Vec<&str> = statement
            .split("SET ")
            .skip(1)
            .map(|rest| rest.split('=').next().unwrap_or("").trim())
            .collect();
        assert_eq!(
            assigned,
            vec!["scene_id"],
            "only scene_id is assigned: {statement}"
        );
    }
}
