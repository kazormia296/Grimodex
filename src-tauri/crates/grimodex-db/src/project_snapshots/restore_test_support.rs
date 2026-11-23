//! What the guard tests of the restore's reference handling share: who owns
//! which table, which tables a restore replaces, and the foreign keys of the
//! current schema (read from `PRAGMA foreign_key_list`, not from a list kept by
//! hand).

use std::collections::HashSet;

use rusqlite::Connection;

use super::{RestoreScope, AUX_SPECS};

/// The rows a restore deletes for each scope, as `apply_project_snapshot_restore`
/// does (the `events` and `project_calendar` ones when the snapshot has them).
pub(super) fn roots(scope: RestoreScope) -> &'static [&'static str] {
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

pub(super) const ALL_SCOPES: [RestoreScope; 7] = [
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
pub(super) fn table_owner(table: &str) -> Option<RestoreScope> {
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
pub(super) struct Fk {
    pub(super) table: String,
    pub(super) column: String,
    pub(super) parent: String,
    pub(super) on_delete: String,
}

pub(super) fn foreign_keys(conn: &Connection) -> Vec<Fk> {
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

pub(super) fn schema_foreign_keys() -> Vec<Fk> {
    let db = crate::test_support::current_schema_memory().expect("current schema");
    db.with_conn(|conn| Ok(foreign_keys(conn)))
        .expect("foreign keys")
}

/// The tables of the Chronicle that a snapshot made before events existed does
/// not carry: a Body restore of it leaves them alone (the restore does not
/// delete `events` then, so nothing re-inserts the rest either).
pub(super) const EVENT_TABLES: [&str; 4] = [
    "events",
    "event_participants",
    "scene_events",
    "event_relations",
];

/// Is the table deleted and inserted again by a restore of `scopes`?
pub(super) fn replaced(table: &str, scopes: &HashSet<RestoreScope>, events_aux: bool) -> bool {
    let Some(owner) = table_owner(table) else {
        return false;
    };
    scopes.contains(&owner)
        && !(owner == RestoreScope::Body && EVENT_TABLES.contains(&table) && !events_aux)
}
