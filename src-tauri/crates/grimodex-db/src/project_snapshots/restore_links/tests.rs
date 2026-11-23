//! Guards of the restore's parking (DR-SRX-3, DR-SRX-9).
//!
//! `PARK_COLUMNS` is a fixed, hand-classified list so that every statement the
//! restore runs is built from constants. These tests derive the same list from
//! the real schema (`PRAGMA foreign_key_list`) and from who owns which table,
//! for every combination of scopes, and fail when the two disagree. A new
//! foreign key into a row a restore deletes, a renamed column or a changed
//! `ON DELETE` therefore stops here until a person has classified it.

use std::collections::{BTreeSet, HashMap, HashSet};

use super::super::restore_test_support::{
    replaced, roots, schema_foreign_keys, table_owner, Fk, ALL_SCOPES,
};
use super::*;

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

/// What a restore of `scopes` must park, derived from the schema alone.
/// `events_aux` is whether the snapshot carries the Chronicle's rows.
fn derived(fks: &[Fk], scopes: &HashSet<RestoreScope>, events_aux: bool) -> BTreeSet<String> {
    let mut vanishing: HashSet<String> = scopes
        .iter()
        .flat_map(|scope| roots(*scope).iter().map(|table| table.to_string()))
        .filter(|table| events_aux || table != "events")
        .collect();
    // A child the selected scopes own is deleted with its parent and inserted
    // again, so it is a vanishing parent in its turn.
    loop {
        let mut grew = false;
        for fk in fks {
            if fk.table == "authorship_spans" || fk.on_delete != "CASCADE" {
                continue;
            }
            if vanishing.contains(&fk.parent)
                && replaced(&fk.table, scopes, events_aux)
                && vanishing.insert(fk.table.clone())
            {
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
        if replaced(&fk.table, scopes, events_aux) {
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

fn fixed(scopes: &HashSet<RestoreScope>, events_aux: bool) -> BTreeSet<String> {
    let shape = RestoreShape {
        project_id: "p",
        snapshot_id: "s",
        scopes,
        events_aux,
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
    // Both for a snapshot that carries the Chronicle and one made before it
    // existed (a Body restore of that one leaves the event tables alone).
    for events_aux in [true, false] {
        for mask in 1u32..(1 << ALL_SCOPES.len()) {
            let scopes: HashSet<RestoreScope> = ALL_SCOPES
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, scope)| *scope)
                .collect();
            let want = derived(&fks, &scopes, events_aux);
            let have = fixed(&scopes, events_aux);
            assert_eq!(
                have,
                want,
                "PARK_COLUMNS disagrees with the schema for {scopes:?} (snapshot has events: {events_aux})\n  only in the list: {:?}\n  only in the schema: {:?}",
                have.difference(&want).collect::<Vec<_>>(),
                want.difference(&have).collect::<Vec<_>>(),
            );
        }
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

/// The part of a source file before its `#[cfg(test)]` module: the first
/// `#[cfg(test)]`, then any further attribute lines, then `mod name {`
/// (declarations `mod name;` and `#[cfg(test)]` items that are not a module do
/// not count). The module is the last item of these files; the scan reads
/// nothing after it.
fn production_source(source: &str) -> &str {
    const MARKER: &str = "\n#[cfg(test)]\n";
    let mut from = 0;
    while let Some(offset) = source[from..].find(MARKER) {
        let at = from + offset;
        let item = source[at + MARKER.len()..]
            .lines()
            .find(|line| !line.trim_start().starts_with("#["))
            .unwrap_or("");
        if item.trim_start().starts_with("mod ") && item.trim_end().ends_with('{') {
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

/// Source text as the scan compares it: lower case, every run of whitespace
/// one space, and no space around `::`, before `(` or after a quote. The scan
/// then does not depend on how a statement is laid out.
fn normalized(source: &str) -> String {
    source
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .replace(" ::", "::")
        .replace(":: ", "::")
        .replace(" (", "(")
}

/// Every `UPDATE` of `change_events` in the (normalized) source, from `update`
/// to the quote that ends the string it is written in. Also finds
/// `UPDATE OR <conflict> change_events` and a quoted table name; an `UPDATE` it
/// cannot read to the end of is returned as it stands, so it fails the exact
/// comparison instead of being passed over.
fn update_statements_on_change_events(normalized: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (at, _) in normalized.match_indices("update ") {
        // A word that merely ends in "update" (`on update`, `before update`)
        // is not a statement.
        if normalized[..at]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        {
            continue;
        }
        let mut rest = &normalized[at + "update ".len()..];
        if let Some(after) = rest.strip_prefix("or ") {
            rest = after.split_once(' ').map_or("", |(_, tail)| tail);
        }
        let rest = rest.trim_start_matches(['"', '\\', '`', '[']);
        if !rest.starts_with("change_events") {
            continue;
        }
        let tail = &normalized[at..];
        let after_name = tail
            .find("change_events")
            .map_or(0, |i| i + "change_events".len());
        let end = tail[after_name..]
            .find('"')
            .map_or(tail.len(), |i| after_name + i);
        found.push(tail[..end].trim().to_string());
    }
    found
}

/// The three statements the parking may run on `change_events`, exactly. Each
/// assigns `scene_id` and nothing else, so a column added to a `SET` (a hash,
/// a payload) or a fourth statement fails the comparison.
const EXPECTED_UPDATES: [&str; 3] = [
    "update change_events set scene_id = ?1 || scene_id where project_id = ?2 \
     and scene_id in (select id from tree_nodes where project_id = ?2)",
    "update change_events set scene_id = substr(scene_id, ?3) \
     where scene_id >= ?1 and scene_id < ?2 and exists ( select 1 from tree_nodes \
     where tree_nodes.id = substr(change_events.scene_id, ?3) )",
    "update change_events set scene_id = null where scene_id >= ?1 and scene_id < ?2",
];

#[test]
fn only_the_restore_calls_the_scene_id_parking_and_it_writes_nothing_else() {
    let files = production_files();
    // The type is named only by its own file and by the one file that calls it.
    let naming: BTreeSet<&str> = files
        .iter()
        .filter(|(_, source)| normalized(source).contains("restoresceneidparking"))
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        naming,
        BTreeSet::from(["change_events.rs", "project_snapshots/restore_links.rs"]),
        "a new caller of the change_events parking needs the user's confirmation (DR-SRX-9)"
    );
    // One place builds the parking, and `for_snapshot` is called exactly twice
    // in the restore's file (the window, and the parking that holds one), so an
    // alias or a second parking cannot hide among them.
    let restore_links = files
        .iter()
        .find(|(name, _)| name == "project_snapshots/restore_links.rs")
        .map(|(_, source)| normalized(source))
        .expect("restore_links.rs");
    assert_eq!(
        restore_links
            .matches("restoresceneidparking::for_snapshot(")
            .count(),
        1,
        "one place builds the parking: the restore"
    );
    assert_eq!(
        restore_links.matches("for_snapshot(").count(),
        2,
        "ParkWindow::for_snapshot and RestoreSceneIdParking::for_snapshot, nothing else"
    );
    // The restore itself writes no `change_events` SQL (a quoted name, any
    // case, any layout, REPLACE and OR forms included).
    for (name, source) in &files {
        if !name.starts_with("project_snapshots") {
            continue;
        }
        let text = normalized(source);
        assert!(
            update_statements_on_change_events(&text).is_empty(),
            "{name} must not UPDATE change_events itself"
        );
        let flat = text.replace(['"', '\\', '`'], "");
        for needle in [
            "delete from change_events",
            "insert into change_events",
            "insert or replace into change_events",
            "replace into change_events",
            "insert or ignore into change_events",
        ] {
            assert!(
                !flat.contains(needle),
                "{name} must not write change_events itself (`{needle}`)"
            );
        }
    }
    // Nowhere else is `change_events` updated either, except the parking's
    // own three statements, which are compared whole.
    let mut all: Vec<(String, String)> = Vec::new();
    for (name, source) in &files {
        for statement in update_statements_on_change_events(&normalized(source)) {
            all.push((name.clone(), statement));
        }
    }
    let expected: Vec<(String, String)> = EXPECTED_UPDATES
        .iter()
        .map(|statement| ("change_events.rs".to_string(), normalized(statement)))
        .collect();
    assert_eq!(
        all, expected,
        "the only UPDATEs of change_events are the three of the parking, each assigning \
         scene_id and nothing else (DR-SRX-9)"
    );
}

#[test]
fn the_scan_reads_updates_however_they_are_written() {
    // The scan is only as good as its reader: layouts a review found it to
    // miss are statements it must find.
    for (source, count) in [
        ("UPDATE change_events SET scene_id = 'x'", 1),
        ("update change_events set scene_id = 'x', hash = 'y'", 1),
        ("UPDATE   change_events\n   SET scene_id = NULL", 1),
        ("UPDATE \"change_events\" SET scene_id = NULL", 1),
        ("UPDATE OR REPLACE change_events SET hash = 'y'", 1),
        ("UPDATE tree_nodes SET title = 'x'", 0),
        ("ON UPDATE CASCADE REFERENCES change_events (id)", 0),
        ("before_update_change_events_trigger", 0),
    ] {
        assert_eq!(
            update_statements_on_change_events(&normalized(source)).len(),
            count,
            "{source:?}"
        );
    }
    // A statement that assigns another column is not the expected one.
    let found = update_statements_on_change_events(&normalized(
        "UPDATE change_events SET scene_id = ?1 || scene_id, hash = 'x' WHERE project_id = ?2",
    ));
    assert!(!EXPECTED_UPDATES
        .iter()
        .any(|statement| normalized(statement) == found[0]));
}

#[test]
fn a_violation_mended_while_another_is_made_is_caught_as_a_set() {
    let db = crate::test_support::current_schema_memory().expect("schema");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p', 'P');
             PRAGMA foreign_keys = OFF;
             INSERT INTO chat_sessions (id, project_id, title, node_id)
               VALUES ('a', 'p', 'A', 'ghost-a');
             PRAGMA foreign_keys = ON;",
        )?;
        let mut before = HashMap::new();
        before.insert("chat_sessions", dangling_set(conn, "chat_sessions")?);
        assert_eq!(before["chat_sessions"].len(), 1, "precondition");
        // Unchanged: fine.
        ensure_no_new_dangling(conn, &before)?;
        // The old violation mended: fine (fewer).
        conn.execute("UPDATE chat_sessions SET node_id = NULL WHERE id = 'a'", [])?;
        ensure_no_new_dangling(conn, &before)?;
        // Mended, and another made in the same table: the same count, and a
        // new violation. A count cannot see it; the set does.
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO chat_sessions (id, project_id, title, node_id)
               VALUES ('b', 'p', 'B', 'ghost-b');
             PRAGMA foreign_keys = ON;",
        )?;
        assert_eq!(dangling_set(conn, "chat_sessions")?.len(), 1, "same count");
        let error = ensure_no_new_dangling(conn, &before).expect_err("a new violation");
        assert!(
            format!("{error:#}").contains("new dangling reference"),
            "{error:#}"
        );
        Ok(())
    })
    .expect("the checks run");
}

/// The dangling check covers the tables the missing-parent step can change
/// (DR-SRX-32): with that list ignored, a row the step left dangling would pass
/// the run-time safety net. Every one of them that exists is in the set.
#[test]
fn the_dangling_check_covers_the_tables_of_the_missing_parent_step() {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| {
        let tables = existing_tables(conn)?;
        for scope in ALL_SCOPES {
            let scopes: HashSet<RestoreScope> = [scope].into_iter().collect();
            let shape = RestoreShape {
                project_id: "p",
                snapshot_id: "s",
                scopes: &scopes,
                events_aux: true,
            };
            let touched = touched_tables(conn, &shape, &tables)?;
            for table in super::super::restore_missing_parents::touched_tables(&scopes) {
                assert!(
                    touched.contains(&table),
                    "{scope:?}: {table} is checked for new dangling references"
                );
            }
        }
        Ok(())
    })
    .expect("touched tables");
}
