//! The links a project snapshot restore must keep across scopes
//! (DR-SRX-2..10, `docs/plans/nir1-lane-decisions/
//! snapshot-restore-cross-scope-decisions.md`).
//!
//! A restore deletes the selected scope's roots (`tree_nodes`, `codex_entries`,
//! ...) and inserts them again from the snapshot. The foreign keys'
//! `ON DELETE CASCADE` / `SET NULL` then also take the rows of the scopes that
//! were NOT selected with them: an event's participants, a scene's POV
//! character, a snippet's scene, a map card, a chat pin, a trash item.
//!
//! **What this module does.** Inside the restore's transaction, before the
//! roots are deleted, the reference column of each such row is rewritten in
//! place to `<prefix><original value>` (a value no parent row has, so no
//! cascade fires and the row, its `rowid` and everything below it stay as
//! they are). After the roots are inserted again, a parked value whose parent
//! exists again goes back to the original value; one whose parent does not
//! exist gets what the foreign key would have done (the row is deleted for
//! `CASCADE`, the column becomes NULL for `SET NULL`). The same decision, made
//! on ids before the restore, gives the counts of what falls away.
//!
//! The columns are a fixed list ([`PARK_COLUMNS`]) so that every statement is
//! built from constants. A test derives the list again from
//! `PRAGMA foreign_key_list` and fails when a foreign key appears that nobody
//! classified.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{
    named_params, params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    maybe_aux_snapshot_rows, snapshot_has_aux, table_columns, table_exists, RawRow, RestoreScope,
    SnapshotInsertMode, SnapshotInsertPlan, SnapshotRestoreTable,
};
use crate::change_events::{ParkWindow, RestoreSceneIdParking};

/// One kind of link a restore could not give back, as the author sees it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LossNotice {
    pub kind: String,
    pub count: i64,
}

/// The fixed ids (never table names) the confirmation and the restore result
/// report. The order is the order they are reported in.
pub(super) const KIND_ORDER: &[&str] = &[
    "event_participants",
    "event_primary_or_location",
    "event_reveal_scene",
    "event_scene_links",
    "scene_pov_or_location",
    "scene_codex_links",
    "foreshadow_codex_links",
    "snippet_tags",
    "snippet_scene_link",
    "foreshadow_scene_links",
    "scene_labels",
    "phase_anchor",
    "lint_ignores",
    "map_placements",
    "editor_stickies",
    "chat_pins_or_anchors",
    "trash_items",
    "ai_scene_proposals",
    "analysis_records",
    // The snapshot's own rows a restore leaves out because their parent is
    // gone (`restore_missing_parents`, DR-SRX-31).
    "map_edges",
    "map_source_links",
    "snippet_source_message",
    "analysis_run_links",
    "analysis_annotations",
    "scene_scope_bindings_reset",
];

const KIND_AI_SCENE_PROPOSALS: &str = "ai_scene_proposals";
const KIND_SCENE_SCOPE_BINDINGS_RESET: &str = "scene_scope_bindings_reset";

/// SQLite's default limit on bound variables is 32,766; stay far below it.
pub(super) const ID_CHUNK: usize = 500;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum Parent {
    TreeNodes,
    CodexEntries,
    CodexTags,
    CodexEntryPhases,
    Snippets,
    Events,
    MapStickies,
}

impl Parent {
    pub(super) const ALL: [Parent; 7] = [
        Parent::TreeNodes,
        Parent::CodexEntries,
        Parent::CodexTags,
        Parent::CodexEntryPhases,
        Parent::Snippets,
        Parent::Events,
        Parent::MapStickies,
    ];

    pub(super) fn table(self) -> &'static str {
        match self {
            Self::TreeNodes => "tree_nodes",
            Self::CodexEntries => "codex_entries",
            Self::CodexTags => "codex_tags",
            Self::CodexEntryPhases => "codex_entry_phases",
            Self::Snippets => "snippets",
            Self::Events => "events",
            Self::MapStickies => "map_stickies",
        }
    }

    /// The scope whose restore deletes (and inserts again) these rows.
    pub(super) fn scope(self) -> RestoreScope {
        match self {
            Self::TreeNodes | Self::Events => RestoreScope::Body,
            Self::CodexEntries | Self::CodexTags | Self::CodexEntryPhases => RestoreScope::Codex,
            Self::Snippets => RestoreScope::Snippet,
            Self::MapStickies => RestoreScope::Map,
        }
    }

    fn plan_table(self) -> SnapshotRestoreTable {
        match self {
            Self::TreeNodes => SnapshotRestoreTable::TreeNodes,
            Self::CodexEntries => SnapshotRestoreTable::CodexEntries,
            Self::CodexTags => SnapshotRestoreTable::CodexTags,
            Self::CodexEntryPhases => SnapshotRestoreTable::CodexEntryPhases,
            Self::Snippets => SnapshotRestoreTable::Snippets,
            Self::Events => SnapshotRestoreTable::Events,
            Self::MapStickies => SnapshotRestoreTable::MapStickies,
        }
    }

    /// Ids of this project's rows of the parent table (`:p` is the project).
    fn project_ids_sql(self) -> &'static str {
        match self {
            Self::TreeNodes => "SELECT id FROM tree_nodes WHERE project_id = :p",
            Self::CodexEntries => "SELECT id FROM codex_entries WHERE project_id = :p",
            Self::CodexTags => "SELECT id FROM codex_tags WHERE project_id = :p",
            Self::CodexEntryPhases => {
                "SELECT id FROM codex_entry_phases
                  WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = :p)"
            }
            Self::Snippets => "SELECT id FROM snippets WHERE project_id = :p",
            Self::Events => "SELECT id FROM events WHERE project_id = :p",
            Self::MapStickies => {
                "SELECT id FROM map_stickies
                  WHERE board_id IN (SELECT id FROM map_boards WHERE project_id = :p)"
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OnDelete {
    Cascade,
    SetNull,
}

/// A reference column of a table the restore does not replace, pointing at a
/// parent the restore deletes.
#[derive(Debug)]
pub(super) struct ParkColumn {
    pub(super) table: &'static str,
    pub(super) column: &'static str,
    pub(super) parent: Parent,
    pub(super) on_delete: OnDelete,
    /// The scope that replaces the table; `None` when no scope owns it (chat,
    /// trash, AI records), so a restore never replaces it.
    pub(super) owner: Option<RestoreScope>,
    /// What the author calls it; `None` is a link nobody needs to be told
    /// about (a log, a derived cache).
    pub(super) kind: Option<&'static str>,
}

const fn col(
    table: &'static str,
    column: &'static str,
    parent: Parent,
    on_delete: OnDelete,
    owner: Option<RestoreScope>,
    kind: Option<&'static str>,
) -> ParkColumn {
    ParkColumn {
        table,
        column,
        parent,
        on_delete,
        owner,
        kind,
    }
}

use OnDelete::{Cascade, SetNull};
use Parent::{
    CodexEntries as Cx, CodexEntryPhases as Ph, CodexTags as Tg, Events as Ev, MapStickies as St,
    Snippets as Sn, TreeNodes as Tn,
};
use RestoreScope::{Body, Codex, Foreshadow, Labels, Lint, Map, Snippet};

/// Every reference column that can be parked, classified. Tables that a scope
/// replaces appear only for the scopes that do not own them. Not listed on
/// purpose:
/// - `authorship_spans`: the document a row points at decides the owner, so
///   the restore inserts the rows of the selected scopes' documents again
///   instead ([`authorship_inserts`]);
/// - `change_events.scene_id` (a protected table, parked by its own module,
///   `RestoreSceneIdParking`), `prose_staging.scene_id` (parked per scene, see
///   [`prose_staging_plan`]);
/// - `scene_chunks`, `codex_chunks`, `event_chunks` (derived search indexes that
///   are rebuilt from the restored text) and
///   `narrative_scene_scope_bindings` (made again by the restore, by contract:
///   scope-default-decisions M10/M20, x1-4 DR-X1-4-22).
pub(super) const PARK_COLUMNS: &[ParkColumn] = &[
    // -- scenes (tree_nodes), restored by Body ---------------------------
    col("ai_usage", "scene_node_id", Tn, SetNull, None, None),
    col(
        "chat_sessions",
        "node_id",
        Tn,
        SetNull,
        None,
        Some("chat_pins_or_anchors"),
    ),
    col(
        "codex_entry_phases",
        "anchor_node_id",
        Tn,
        SetNull,
        Some(Codex),
        Some("phase_anchor"),
    ),
    col(
        "editor_stickies",
        "tree_node_id",
        Tn,
        Cascade,
        Some(Map),
        Some("editor_stickies"),
    ),
    col(
        "events",
        "reveal_scene_id",
        Tn,
        SetNull,
        Some(Body),
        Some("event_reveal_scene"),
    ),
    col(
        "foreshadow_payoffs",
        "scene_id",
        Tn,
        Cascade,
        Some(Foreshadow),
        Some("foreshadow_scene_links"),
    ),
    col(
        "foreshadow_setups",
        "scene_id",
        Tn,
        Cascade,
        Some(Foreshadow),
        Some("foreshadow_scene_links"),
    ),
    col(
        "foreshadows",
        "payoff_scene_id",
        Tn,
        SetNull,
        Some(Foreshadow),
        Some("foreshadow_scene_links"),
    ),
    col("lint_action_log", "scene_id", Tn, SetNull, None, None),
    col(
        "lint_ignored_diagnostics",
        "scene_id",
        Tn,
        Cascade,
        Some(Lint),
        Some("lint_ignores"),
    ),
    col(
        "map_node_positions",
        "tree_node_id",
        Tn,
        Cascade,
        Some(Map),
        Some("map_placements"),
    ),
    col(
        "post_effect_runs",
        "scope_target_id",
        Tn,
        Cascade,
        None,
        Some("analysis_records"),
    ),
    // Owned by Body, so it is replaced (and not parked) whenever the snapshot
    // carries events. A snapshot made before events existed has none: events
    // are then left alone (see `child_replaced`), and the scene links must be
    // set aside like the rest of the event tables' links, or the scene's
    // CASCADE would drop them with nothing to put them back.
    col(
        "scene_events",
        "scene_id",
        Tn,
        Cascade,
        Some(Body),
        Some("event_scene_links"),
    ),
    col(
        "scene_lens_data",
        "target_id",
        Tn,
        Cascade,
        None,
        Some("analysis_records"),
    ),
    col(
        "snippets",
        "scene_id",
        Tn,
        SetNull,
        Some(Snippet),
        Some("snippet_scene_link"),
    ),
    col(
        "trash_items",
        "origin_scene_id",
        Tn,
        Cascade,
        None,
        Some("trash_items"),
    ),
    col(
        "tree_node_labels",
        "node_id",
        Tn,
        Cascade,
        Some(Labels),
        Some("scene_labels"),
    ),
    // -- Codex entries, restored by Codex --------------------------------
    col(
        "chat_session_pinned_codex",
        "codex_entry_id",
        Cx,
        Cascade,
        None,
        Some("chat_pins_or_anchors"),
    ),
    col(
        "chat_sessions",
        "codex_anchor_id",
        Cx,
        SetNull,
        None,
        Some("chat_pins_or_anchors"),
    ),
    col(
        "editor_stickies",
        "codex_entry_id",
        Cx,
        Cascade,
        Some(Map),
        Some("editor_stickies"),
    ),
    col(
        "event_participants",
        "codex_entry_id",
        Cx,
        Cascade,
        Some(Body),
        Some("event_participants"),
    ),
    col(
        "events",
        "location_codex_id",
        Cx,
        SetNull,
        Some(Body),
        Some("event_primary_or_location"),
    ),
    col(
        "events",
        "primary_codex_id",
        Cx,
        SetNull,
        Some(Body),
        Some("event_primary_or_location"),
    ),
    col(
        "foreshadow_codex_links",
        "codex_entry_id",
        Cx,
        Cascade,
        Some(Foreshadow),
        Some("foreshadow_codex_links"),
    ),
    col(
        "impact_review_baselines",
        "entry_id",
        Cx,
        Cascade,
        None,
        Some("analysis_records"),
    ),
    col(
        "map_node_positions",
        "codex_entry_id",
        Cx,
        Cascade,
        Some(Map),
        Some("map_placements"),
    ),
    col(
        "scene_beat_pov_cache",
        "pov_character_id",
        Cx,
        Cascade,
        Some(Body),
        None,
    ),
    col(
        "scene_codex_mentions",
        "codex_entry_id",
        Cx,
        Cascade,
        Some(Body),
        Some("scene_codex_links"),
    ),
    col(
        "scene_codex_pins",
        "entry_id",
        Cx,
        Cascade,
        Some(Body),
        Some("scene_codex_links"),
    ),
    col(
        "trash_items",
        "origin_codex_id",
        Cx,
        Cascade,
        None,
        Some("trash_items"),
    ),
    col(
        "tree_nodes",
        "location_id",
        Cx,
        SetNull,
        Some(Body),
        Some("scene_pov_or_location"),
    ),
    col(
        "tree_nodes",
        "pov_character_id",
        Cx,
        SetNull,
        Some(Body),
        Some("scene_pov_or_location"),
    ),
    // -- Codex phases and tags -------------------------------------------
    col(
        "editor_stickies",
        "phase_id",
        Ph,
        Cascade,
        Some(Map),
        Some("editor_stickies"),
    ),
    col(
        "snippet_entry_tags",
        "tag_id",
        Tg,
        Cascade,
        Some(Snippet),
        Some("snippet_tags"),
    ),
    // -- Snippets, restored by Snippet -----------------------------------
    col(
        "chat_session_pinned_codex",
        "snippet_id",
        Sn,
        Cascade,
        None,
        Some("chat_pins_or_anchors"),
    ),
    col(
        "chat_sessions",
        "snippet_anchor_id",
        Sn,
        SetNull,
        None,
        Some("chat_pins_or_anchors"),
    ),
    col(
        "editor_stickies",
        "snippet_id",
        Sn,
        Cascade,
        Some(Map),
        Some("editor_stickies"),
    ),
    col(
        "map_node_positions",
        "snippet_id",
        Sn,
        Cascade,
        Some(Map),
        Some("map_placements"),
    ),
    // -- Events, restored by Body (when the snapshot has them) ------------
    col(
        "editor_stickies",
        "chronicle_event_id",
        Ev,
        Cascade,
        Some(Map),
        Some("editor_stickies"),
    ),
    // -- Map stickies, restored by Map -----------------------------------
    col(
        "chat_session_pinned_codex",
        "sticky_id",
        St,
        Cascade,
        None,
        Some("chat_pins_or_anchors"),
    ),
];

/// `prose_staging.scene_id` (`ON DELETE CASCADE`): parked per scene, not by
/// parent (DR-SRX-8).
static PROSE_STAGING: ParkColumn = col(
    "prose_staging",
    "scene_id",
    Tn,
    Cascade,
    None,
    Some(KIND_AI_SCENE_PROPOSALS),
);

/// The event tables a snapshot without an `events` aux does not replace even
/// when Body is selected (`apply` does not delete `events` then either).
fn is_event_table(table: &str) -> bool {
    matches!(
        table,
        "events" | "event_participants" | "scene_events" | "event_relations"
    )
}

/// What a restore of `scopes` deletes and inserts again, as the restore does.
pub(super) struct RestoreShape<'a> {
    pub(super) project_id: &'a str,
    pub(super) snapshot_id: &'a str,
    pub(super) scopes: &'a HashSet<RestoreScope>,
    /// The snapshot has an `events` aux (otherwise `events` is not deleted).
    pub(super) events_aux: bool,
}

impl RestoreShape<'_> {
    fn parent_vanishes(&self, parent: Parent) -> bool {
        self.scopes.contains(&parent.scope()) && (parent != Parent::Events || self.events_aux)
    }

    fn child_replaced(&self, column: &ParkColumn) -> bool {
        match column.owner {
            None => false,
            Some(owner) => {
                self.scopes.contains(&owner)
                    && !(owner == RestoreScope::Body
                        && is_event_table(column.table)
                        && !self.events_aux)
            }
        }
    }

    /// The columns this restore parks.
    pub(super) fn active_columns(&self) -> impl Iterator<Item = &'static ParkColumn> + '_ {
        PARK_COLUMNS
            .iter()
            .filter(|column| self.parent_vanishes(column.parent) && !self.child_replaced(column))
    }

    pub(super) fn parks_prose_staging(&self) -> bool {
        self.scopes.contains(&RestoreScope::Body)
    }

    pub(super) fn parks_change_events(&self) -> bool {
        self.scopes.contains(&RestoreScope::Body)
    }
}

pub(super) fn shape<'a>(
    conn: &Connection,
    project_id: &'a str,
    snapshot_id: &'a str,
    scopes: &'a HashSet<RestoreScope>,
) -> anyhow::Result<RestoreShape<'a>> {
    Ok(RestoreShape {
        project_id,
        snapshot_id,
        scopes,
        events_aux: snapshot_has_aux(conn, snapshot_id, "events")?,
    })
}

// ----------------------------------------------------------------------
// Statements. Every name below comes from the constants above.
// ----------------------------------------------------------------------

fn park_sql(column: &ParkColumn) -> String {
    format!(
        "UPDATE \"{table}\" SET \"{col}\" = :prefix || \"{col}\"
          WHERE \"{col}\" IN ({ids})",
        table = column.table,
        col = column.column,
        ids = column.parent.project_ids_sql(),
    )
}

fn restore_sql(column: &ParkColumn) -> String {
    format!(
        "UPDATE \"{table}\" SET \"{col}\" = substr(\"{col}\", :from)
          WHERE \"{col}\" >= :prefix AND \"{col}\" < :upper
            AND EXISTS (SELECT 1 FROM \"{parent}\" AS p
                         WHERE p.id = substr(\"{table}\".\"{col}\", :from))",
        table = column.table,
        col = column.column,
        parent = column.parent.table(),
    )
}

fn detach_sql(column: &ParkColumn) -> String {
    match column.on_delete {
        OnDelete::Cascade => format!(
            "DELETE FROM \"{table}\" WHERE \"{col}\" >= :prefix AND \"{col}\" < :upper",
            table = column.table,
            col = column.column,
        ),
        OnDelete::SetNull => format!(
            "UPDATE \"{table}\" SET \"{col}\" = NULL
              WHERE \"{col}\" >= :prefix AND \"{col}\" < :upper",
            table = column.table,
            col = column.column,
        ),
    }
}

fn remaining_sql(column: &ParkColumn) -> String {
    format!(
        "SELECT EXISTS(SELECT 1 FROM \"{table}\"
                        WHERE \"{col}\" >= :prefix AND \"{col}\" < :upper)",
        table = column.table,
        col = column.column,
    )
}

fn existing_tables(conn: &Connection) -> anyhow::Result<HashSet<String>> {
    let mut statement = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(names)
}

fn column_is_present(
    conn: &Connection,
    tables: &HashSet<String>,
    column: &ParkColumn,
) -> anyhow::Result<bool> {
    Ok(tables.contains(column.table) && table_columns(conn, column.table)?.contains(column.column))
}

// ----------------------------------------------------------------------
// What the plan says survives
// ----------------------------------------------------------------------

/// What the restored rows are, read from the canonical plan.
pub(super) struct PlanFacts {
    /// Ids of the parents that exist again after the restore, for the parents
    /// whose scope is replaced.
    surviving: HashMap<Parent, HashSet<String>>,
    /// Restored scene ids with their body (`content`).
    scene_bodies: HashMap<String, Option<String>>,
}

pub(super) fn plan_facts(plan: &[SnapshotInsertPlan]) -> PlanFacts {
    let mut surviving: HashMap<Parent, HashSet<String>> = HashMap::new();
    let mut scene_bodies = HashMap::new();
    for insert in plan {
        let id = insert.row.get("id").and_then(Value::as_str);
        for parent in Parent::ALL {
            if insert.table == parent.plan_table() {
                if let Some(id) = id {
                    surviving.entry(parent).or_default().insert(id.to_string());
                }
            }
        }
        if insert.table == SnapshotRestoreTable::TreeNodes {
            if let Some(id) = id {
                let body = insert
                    .row
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if insert.row.get("node_type").and_then(Value::as_str) == Some("scene") {
                    scene_bodies.insert(id.to_string(), body);
                }
            }
        }
    }
    PlanFacts {
        surviving,
        scene_bodies,
    }
}

fn live_ids(conn: &Connection, parent: Parent, project_id: &str) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(parent.project_ids_sql())?;
    let ids = statement
        .query_map(named_params! { ":p": project_id }, |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Ids of `parent` rows that the restore removes for good.
fn vanishing_ids(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    facts: &PlanFacts,
    parent: Parent,
) -> anyhow::Result<Vec<String>> {
    let empty = HashSet::new();
    let surviving = facts.surviving.get(&parent).unwrap_or(&empty);
    Ok(live_ids(conn, parent, shape.project_id)?
        .into_iter()
        .filter(|id| !surviving.contains(id))
        .collect())
}

// ----------------------------------------------------------------------
// prose_staging (DR-SRX-8): a proposal stays only for a scene whose body is
// the snapshot's
// ----------------------------------------------------------------------

pub(super) struct ProsePlan {
    /// Scenes whose proposals are parked and come back.
    keep: Vec<String>,
    /// Proposals (status `proposed`) that go with their scene.
    dropped: i64,
}

fn prose_staging_plan(
    conn: &Connection,
    project_id: &str,
    facts: &PlanFacts,
) -> anyhow::Result<ProsePlan> {
    let mut statement = conn.prepare(
        "SELECT scene_id,
                SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END)
           FROM prose_staging WHERE project_id = ?1 GROUP BY scene_id",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut keep = Vec::new();
    let mut dropped = 0;
    for (scene_id, proposed) in rows {
        let same_body = match facts.scene_bodies.get(&scene_id) {
            None => false,
            Some(snapshot_body) => {
                // A real error (busy, I/O) stops the restore; only "no such
                // scene" means "not the same body".
                let live: Option<String> = conn
                    .query_row(
                        "SELECT content FROM tree_nodes WHERE id = ?1",
                        params![scene_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten();
                &live == snapshot_body
            }
        };
        if same_body {
            keep.push(scene_id);
        } else {
            dropped += proposed;
        }
    }
    Ok(ProsePlan { keep, dropped })
}

/// Bindings the restore makes again: every restored scene that has one now.
fn scene_bindings_reset(
    conn: &Connection,
    project_id: &str,
    facts: &PlanFacts,
) -> anyhow::Result<i64> {
    if !table_exists(conn, "narrative_scene_scope_bindings")? {
        return Ok(0);
    }
    let ids = facts.scene_bodies.keys().cloned().collect::<Vec<_>>();
    let mut total = 0;
    for chunk in ids.chunks(ID_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT COUNT(*) FROM narrative_scene_scope_bindings
              WHERE project_id = ?1 AND scene_id IN ({placeholders})"
        );
        let mut values = vec![SqlValue::Text(project_id.to_string())];
        values.extend(chunk.iter().cloned().map(SqlValue::Text));
        total += conn.query_row(&sql, params_from_iter(values.iter()), |row| {
            row.get::<_, i64>(0)
        })?;
    }
    Ok(total)
}

// ----------------------------------------------------------------------
// Counting (read only; the restore's confirmation)
// ----------------------------------------------------------------------

fn ordered_notices(counts: BTreeMap<&'static str, i64>) -> Vec<LossNotice> {
    KIND_ORDER
        .iter()
        .filter_map(|kind| {
            counts
                .get(kind)
                .copied()
                .filter(|count| *count > 0)
                .map(|count| LossNotice {
                    kind: (*kind).to_string(),
                    count,
                })
        })
        .collect()
}

/// The live links a restore lost and the snapshot rows it left out because
/// their parent is gone (`restore_missing_parents`), by kind, in the order of
/// [`KIND_ORDER`].
pub(super) fn merge_dropped(
    live: Vec<LossNotice>,
    plan: &BTreeMap<&'static str, i64>,
) -> Vec<LossNotice> {
    let mut counts: BTreeMap<&'static str, i64> = BTreeMap::new();
    for notice in live {
        if let Some(kind) = KIND_ORDER.iter().find(|kind| **kind == notice.kind) {
            *counts.entry(kind).or_default() += notice.count;
        }
    }
    for (kind, count) in plan {
        *counts.entry(kind).or_default() += count;
    }
    ordered_notices(counts)
}

/// How many links a restore of the shape's scopes would not give back,
/// decided on ids before anything is written. `apply` decides the same thing
/// on the rows it parked, so the two agree for the same state. `plan` is the
/// plan after `restore_missing_parents::resolve_with_dropped`, and `plan_dropped` what that
/// step left out or cleared; the latter is added to the count.
pub(super) fn count_losses(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    plan: &[SnapshotInsertPlan],
    plan_dropped: &BTreeMap<&'static str, i64>,
) -> anyhow::Result<Vec<LossNotice>> {
    let facts = plan_facts(plan);
    let tables = existing_tables(conn)?;
    let mut vanished: HashMap<Parent, Vec<String>> = HashMap::new();
    // Rows (by rowid) per (table, kind) that name a parent that goes away.
    let mut rows: HashMap<(&'static str, &'static str), HashSet<i64>> = HashMap::new();
    for column in shape.active_columns() {
        let Some(kind) = column.kind else { continue };
        if !column_is_present(conn, &tables, column)? {
            continue;
        }
        let ids = match vanished.entry(column.parent) {
            std::collections::hash_map::Entry::Occupied(known) => known.into_mut(),
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(vanishing_ids(conn, shape, &facts, column.parent)?)
            }
        };
        let entry = rows.entry((column.table, kind)).or_default();
        for chunk in ids.chunks(ID_CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT rowid FROM \"{table}\" WHERE \"{col}\" IN ({placeholders})",
                table = column.table,
                col = column.column,
            );
            let mut statement = conn.prepare(&sql)?;
            let found = statement
                .query_map(params_from_iter(chunk.iter()), |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            entry.extend(found);
        }
    }
    let mut counts: BTreeMap<&'static str, i64> = BTreeMap::new();
    for ((_, kind), set) in rows {
        *counts.entry(kind).or_default() += set.len() as i64;
    }
    if shape.parks_prose_staging() && tables.contains("prose_staging") {
        *counts.entry(KIND_AI_SCENE_PROPOSALS).or_default() +=
            prose_staging_plan(conn, shape.project_id, &facts)?.dropped;
    }
    if shape.scopes.contains(&RestoreScope::Body) {
        *counts.entry(KIND_SCENE_SCOPE_BINDINGS_RESET).or_default() +=
            scene_bindings_reset(conn, shape.project_id, &facts)?;
    }
    for (kind, count) in plan_dropped {
        *counts.entry(kind).or_default() += count;
    }
    Ok(ordered_notices(counts))
}

// ----------------------------------------------------------------------
// Park and put back (inside the restore's transaction)
// ----------------------------------------------------------------------

/// What `park` decided that `restore` reports at the end.
pub(super) struct Parked {
    window: ParkWindow,
    scene_ids: RestoreSceneIdParking,
    prose_dropped: i64,
    bindings_reset: i64,
    /// The dangling references each touched table already had before the
    /// restore wrote anything, as a set. The restore must not add one, but a
    /// work whose old data already has some (a database imported with foreign
    /// keys off) must stay restorable. The set, not a count: one old violation
    /// mended and one new one made is the same count, and SQLite's own check at
    /// commit does not see it once rows are set aside.
    dangling_before: HashMap<&'static str, HashSet<Dangling>>,
    /// The ids of the AI proposals that were current when the restore began
    /// (made against the scene's version as it was). Only these are made
    /// against the scene's version after the restore; one that was already
    /// stale stays stale.
    current_proposals: Vec<String>,
}

/// One violation `PRAGMA foreign_key_check` reports for a table:
/// (rowid, parent table, foreign key id).
type Dangling = (Option<i64>, String, i64);

/// The rows of `table` that name a parent which does not exist. `table` is
/// always one of the constants above.
fn dangling_set(conn: &Connection, table: &str) -> anyhow::Result<HashSet<Dangling>> {
    let mut statement = conn.prepare(&format!("PRAGMA foreign_key_check(\"{table}\")"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(rows)
}

/// The proposals of this project that were current when the restore began.
fn current_proposal_ids(conn: &Connection, project_id: &str) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT id FROM prose_staging
          WHERE project_id = ?1 AND status = 'proposed' AND base_version IS NOT NULL
            AND base_version = (SELECT version FROM tree_nodes
                                 WHERE tree_nodes.id = prose_staging.scene_id)",
    )?;
    let ids = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// While links are set aside, "a value in the parking window" means "set
/// aside". An id of a parent row that itself starts with the parking root
/// would be set aside twice and then be taken for a value that did not come
/// back. No product code makes such an id (they are UUIDs), but the IPC takes
/// any string, so the restore refuses before it writes anything.
fn ensure_no_reserved_ids(conn: &Connection, tables: &HashSet<String>) -> anyhow::Result<()> {
    let (root, upper) = ParkWindow::reserved_range();
    for parent in Parent::ALL {
        if !tables.contains(parent.table()) {
            continue;
        }
        let found: bool = conn.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM \"{}\" WHERE id >= ?1 AND id < ?2)",
                parent.table()
            ),
            params![root, upper],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            !found,
            "project snapshot restore refuses an id in {} that starts with `{root}`: \
             that prefix is reserved while the links of other scopes are set aside",
            parent.table()
        );
    }
    Ok(())
}

/// The tables this restore rewrites a reference column of.
fn touched_tables(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    tables: &HashSet<String>,
) -> anyhow::Result<Vec<&'static str>> {
    let mut columns: Vec<&ParkColumn> = shape.active_columns().collect();
    if shape.parks_prose_staging() {
        columns.push(&PROSE_STAGING);
    }
    let mut touched = Vec::new();
    for column in columns {
        if column_is_present(conn, tables, column)? && !touched.contains(&column.table) {
            touched.push(column.table);
        }
    }
    // The tables whose references the missing-parent step may change are
    // checked as well: this is the run-time safety net for them (DR-SRX-32).
    for table in super::restore_missing_parents::touched_tables(shape.scopes) {
        if tables.contains(table) && !touched.contains(&table) {
            touched.push(table);
        }
    }
    Ok(touched)
}

/// Set aside the links of every scope the restore does not replace. Call it
/// before the roots are deleted.
pub(super) fn park(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    plan: &[SnapshotInsertPlan],
) -> anyhow::Result<Parked> {
    ensure_no_reserved_ids(conn, &existing_tables(conn)?)?;
    let facts = plan_facts(plan);
    let tables = existing_tables(conn)?;
    let window = ParkWindow::for_snapshot(shape.snapshot_id);
    let mut dangling_before = HashMap::new();
    for table in touched_tables(conn, shape, &tables)? {
        dangling_before.insert(table, dangling_set(conn, table)?);
    }
    let current_proposals = if shape.parks_prose_staging() && tables.contains("prose_staging") {
        current_proposal_ids(conn, shape.project_id)?
    } else {
        Vec::new()
    };
    for column in shape.active_columns() {
        if !column_is_present(conn, &tables, column)? {
            continue;
        }
        conn.execute(
            &park_sql(column),
            named_params! { ":prefix": window.prefix, ":p": shape.project_id },
        )?;
    }
    let mut prose_dropped = 0;
    if shape.parks_prose_staging() && tables.contains("prose_staging") {
        let prose = prose_staging_plan(conn, shape.project_id, &facts)?;
        prose_dropped = prose.dropped;
        for scene_id in &prose.keep {
            conn.execute(
                "UPDATE prose_staging SET scene_id = ?1 || scene_id
                  WHERE project_id = ?2 AND scene_id = ?3",
                params![window.prefix, shape.project_id, scene_id],
            )?;
        }
    }
    let scene_ids = RestoreSceneIdParking::for_snapshot(shape.snapshot_id);
    if shape.parks_change_events() {
        scene_ids.park(conn, shape.project_id)?;
    }
    let bindings_reset = if shape.scopes.contains(&RestoreScope::Body) {
        scene_bindings_reset(conn, shape.project_id, &facts)?
    } else {
        0
    };
    Ok(Parked {
        window,
        scene_ids,
        prose_dropped,
        bindings_reset,
        dangling_before,
        current_proposals,
    })
}

/// Put the parked links back (the parent exists again) or let them fall away
/// as the foreign key would (it does not). Returns what fell away, by kind.
pub(super) fn restore(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    parked: &Parked,
) -> anyhow::Result<Vec<LossNotice>> {
    let tables = existing_tables(conn)?;
    let window = &parked.window;
    let mut columns: Vec<&ParkColumn> = shape.active_columns().collect();
    if shape.parks_prose_staging() {
        columns.push(&PROSE_STAGING);
    }
    let columns = columns
        .into_iter()
        .filter_map(|column| match column_is_present(conn, &tables, column) {
            Ok(true) => Some(Ok(column)),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    // First put back everything whose parent exists, in every column ...
    for column in &columns {
        conn.execute(
            &restore_sql(column),
            named_params! {
                ":prefix": window.prefix,
                ":upper": window.upper,
                ":from": window.original_from,
            },
        )?;
    }
    // A proposal that stays belongs to a scene whose body is the snapshot's,
    // but the scene is inserted again at the version the plan gives it (not the
    // one it had), so the version the proposal was made against no longer
    // names the scene. Left alone, a proposal that was current would be stale
    // now and would look current again when the scene's version happens to
    // reach that number with a different body. It is the same body, so it is
    // valid: it is made against the scene as it is after the restore.
    // Only the proposals that were current when the restore began are touched:
    // one that was already stale (the body had moved on since) stays stale,
    // and is not made current by the restore (an auto-accept would then apply
    // it to a body it was not made for).
    for chunk in parked.current_proposals.chunks(ID_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "UPDATE prose_staging
                SET base_version = (SELECT version FROM tree_nodes
                                     WHERE tree_nodes.id = prose_staging.scene_id)
              WHERE id IN ({placeholders})
                AND scene_id IN (SELECT id FROM tree_nodes)"
        );
        conn.execute(&sql, params_from_iter(chunk.iter()))?;
    }
    // ... then count and detach what is left.
    let mut rows: HashMap<(&'static str, &'static str), HashSet<i64>> = HashMap::new();
    for column in &columns {
        let Some(kind) = column.kind else { continue };
        if std::ptr::eq(*column, &PROSE_STAGING) {
            continue;
        }
        let sql = format!(
            "SELECT rowid FROM \"{table}\" WHERE \"{col}\" >= :prefix AND \"{col}\" < :upper",
            table = column.table,
            col = column.column,
        );
        let mut statement = conn.prepare(&sql)?;
        let found = statement
            .query_map(
                named_params! { ":prefix": window.prefix, ":upper": window.upper },
                |row| row.get::<_, i64>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.entry((column.table, kind)).or_default().extend(found);
    }
    for column in &columns {
        conn.execute(
            &detach_sql(column),
            named_params! { ":prefix": window.prefix, ":upper": window.upper },
        )?;
    }
    if shape.parks_change_events() {
        parked.scene_ids.restore(conn)?;
    }
    let mut counts: BTreeMap<&'static str, i64> = BTreeMap::new();
    for ((_, kind), set) in rows {
        *counts.entry(kind).or_default() += set.len() as i64;
    }
    if parked.prose_dropped > 0 {
        *counts.entry(KIND_AI_SCENE_PROPOSALS).or_default() += parked.prose_dropped;
    }
    if parked.bindings_reset > 0 {
        *counts.entry(KIND_SCENE_SCOPE_BINDINGS_RESET).or_default() += parked.bindings_reset;
    }
    Ok(ordered_notices(counts))
}

/// Nothing parked may survive the restore, and the restore must not have added
/// a dangling reference to a table it touched. SQLite's own deferred check at
/// commit is not relied on: with rows set aside it can let a swap through (an
/// old violation mended while a new one is made, DR-SRX-16), so this check is
/// the one that counts, and it stops the restore with a reason. A dangling
/// reference the table already had before the restore is not the restore's
/// doing and does not stop it.
pub(super) fn ensure_nothing_left_parked(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    parked: &Parked,
) -> anyhow::Result<()> {
    let tables = existing_tables(conn)?;
    let window = &parked.window;
    let mut columns: Vec<&ParkColumn> = shape.active_columns().collect();
    if shape.parks_prose_staging() {
        columns.push(&PROSE_STAGING);
    }
    for column in columns {
        if !column_is_present(conn, &tables, column)? {
            continue;
        }
        let left: bool = conn.query_row(
            &remaining_sql(column),
            named_params! { ":prefix": window.prefix, ":upper": window.upper },
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            !left,
            "project snapshot restore left a parked value in {}.{}",
            column.table,
            column.column
        );
    }
    if shape.parks_change_events() {
        anyhow::ensure!(
            parked.scene_ids.remaining(conn)? == 0,
            "project snapshot restore left a parked value in change_events.scene_id"
        );
    }
    ensure_no_new_dangling(conn, &parked.dangling_before)
}

/// Fails when a touched table has a dangling reference it did not have before
/// the restore. Compared as sets, not counts: mending an old violation while
/// making a new one keeps the count, and with rows set aside SQLite's own check
/// at commit does not catch it (measured by the integrator on SQLite 3.54.1).
fn ensure_no_new_dangling(
    conn: &Connection,
    before: &HashMap<&'static str, HashSet<Dangling>>,
) -> anyhow::Result<()> {
    for (table, old) in before {
        let after = dangling_set(conn, table)?;
        let new = after.difference(old).collect::<Vec<_>>();
        if let Some((rowid, parent, _)) = new.first() {
            anyhow::bail!(
                "project snapshot restore left {} new dangling reference(s) in {table} \
                 (for example rowid {rowid:?}, naming a row of {parent})",
                new.len()
            );
        }
    }
    Ok(())
}

// ----------------------------------------------------------------------
// authorship_spans (DR-SRX-7, 確認 113)
// ----------------------------------------------------------------------

/// The scope that owns an `authorship_spans` row: the one that owns the
/// document it points at (a row points at exactly one document).
fn authorship_scope(row: &RawRow) -> Option<RestoreScope> {
    let present = |field: &str| row.get(field).is_some_and(|value| !value.is_null());
    if present("node_id") {
        Some(RestoreScope::Body)
    } else if present("codex_entry_id") || present("phase_id") || present("detail_value_id") {
        Some(RestoreScope::Codex)
    } else if present("snippet_id") {
        Some(RestoreScope::Snippet)
    } else if present("sticky_id") {
        Some(RestoreScope::Map)
    } else {
        None
    }
}

/// The provenance rows to insert again: the snapshot's rows for the documents
/// of the selected scopes (and only those; the documents of the other scopes
/// keep the rows they have), whose document exists after the restore. The
/// plan's own `authorship_spans` rows (every row of the snapshot) are
/// replaced by these.
pub(super) fn reshape_authorship_inserts(
    conn: &Connection,
    snapshot_id: &str,
    scopes: &HashSet<RestoreScope>,
    plan: Vec<SnapshotInsertPlan>,
) -> anyhow::Result<Vec<SnapshotInsertPlan>> {
    let mut documents: HashMap<&'static str, HashSet<String>> = HashMap::new();
    for insert in &plan {
        let field = match insert.table {
            SnapshotRestoreTable::TreeNodes => "node_id",
            SnapshotRestoreTable::CodexEntries => "codex_entry_id",
            SnapshotRestoreTable::CodexEntryPhases => "phase_id",
            SnapshotRestoreTable::CodexDetailValues => "detail_value_id",
            SnapshotRestoreTable::Snippets => "snippet_id",
            SnapshotRestoreTable::MapStickies => "sticky_id",
            _ => continue,
        };
        if let Some(id) = insert.row.get("id").and_then(Value::as_str) {
            documents.entry(field).or_default().insert(id.to_string());
        }
    }
    let mut out: Vec<SnapshotInsertPlan> = plan
        .into_iter()
        .filter(|insert| insert.table != SnapshotRestoreTable::AuthorshipSpans)
        .collect();
    let empty = HashSet::new();
    for row in maybe_aux_snapshot_rows(conn, snapshot_id, "authorship_spans")? {
        let Some(owner) = authorship_scope(&row) else {
            continue;
        };
        if !scopes.contains(&owner) {
            continue;
        }
        let exists = [
            "node_id",
            "codex_entry_id",
            "phase_id",
            "detail_value_id",
            "snippet_id",
            "sticky_id",
        ]
        .iter()
        .all(|field| match row.get(*field).and_then(Value::as_str) {
            None => true,
            Some(id) => documents.get(field).unwrap_or(&empty).contains(id),
        });
        if exists {
            out.push(SnapshotInsertPlan {
                table: SnapshotRestoreTable::AuthorshipSpans,
                row,
                mode: SnapshotInsertMode::Insert,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
