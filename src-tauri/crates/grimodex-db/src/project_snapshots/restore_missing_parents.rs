//! A snapshot row whose parent is gone after the restore (DR-SRX-26..34,
//! `docs/plans/nir1-lane-decisions/snapshot-restore-cross-scope-decisions.md`).
//!
//! A snapshot row can name a parent that no longer exists when the restore
//! runs: a scene, a Codex entry, a Snippet, a chat message, a chat session, an
//! analysis run or an annotation deleted after the snapshot was taken. The
//! parent is not brought back (the author deleted it), so the row is given the
//! form it would have had if the parent had been deleted *after* the restore,
//! which is what the foreign key's `ON DELETE` says:
//!
//! - a `SET NULL` column becomes NULL, and the row stays;
//! - a `CASCADE` row is left out, together with every row of the plan that
//!   `CASCADE`s to it (a card and the edges that name it, an annotation and its
//!   replies and relations), until nothing more falls away.
//!
//! `snippets.source_chat_message_id` is declared `RESTRICT`, but the
//! `chat_message_source_provenance_delete` trigger sets it to NULL when the
//! message is deleted, so it is a `SET NULL` here (DR-SRX-29).
//!
//! **Where it runs.** Only in Rust, after the renderer's plan has been compared
//! with the canonical plan (`ensure_restore_plan_is_snapshot_derived`) and
//! after `reshape_authorship_inserts`, so the renderer decides nothing here:
//! the result is a function of the snapshot, the live database and the scopes.
//! The same function runs for the confirmation (`count_losses` adds what it
//! counts to the links of the other scopes) and for the restore, so the two
//! agree for the same state (DR-SRX-28).
//!
//! **What keeps the list complete.** The edges are a fixed list
//! ([`MISSING_PARENT_EDGES`], [`DEPENDENTS`]) so that every statement is built
//! from constants. A test derives the foreign keys again from
//! `PRAGMA foreign_key_list` and fails when one that nobody classified points
//! at a parent a restore does not give back (DR-SRX-32). At run time the safety
//! net is `restore_links::ensure_no_new_dangling`, over the tables listed here
//! (`touched_tables`).

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde_json::Value;

use super::restore_links::{RestoreShape, ID_CHUNK};
use super::{maybe_aux_snapshot_rows, RestoreScope, SnapshotInsertPlan, SnapshotRestoreTable};

/// The parents a missing-parent edge can point at, and how to tell whether one
/// exists after the restore.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum ParentRef {
    TreeNodes,
    CodexEntries,
    Snippets,
    /// Never replaced by a scope. Counted when its session belongs to the
    /// project (as `integrity.rs` does for an orphaned source).
    ChatMessages,
    ChatSessions,
    Events,
    PostEffectRuns,
    /// Replaced by Body, but the snapshot does not hold every row: an
    /// annotation without a scene is not captured, and the restore does not
    /// delete it.
    PostEffectAnnotations,
}

impl ParentRef {
    /// The scope whose restore replaces this parent's rows; `None` when no
    /// scope does (the rows of the live database are the ones that exist).
    pub(super) fn replaced_by(self) -> Option<RestoreScope> {
        match self {
            Self::TreeNodes | Self::Events | Self::PostEffectAnnotations => {
                Some(RestoreScope::Body)
            }
            Self::CodexEntries => Some(RestoreScope::Codex),
            Self::Snippets => Some(RestoreScope::Snippet),
            Self::ChatMessages | Self::ChatSessions | Self::PostEffectRuns => None,
        }
    }

    /// The plan table whose rows are this parent when the scope replaces it.
    fn plan_table(self) -> Option<SnapshotRestoreTable> {
        match self {
            Self::TreeNodes => Some(SnapshotRestoreTable::TreeNodes),
            Self::Events => Some(SnapshotRestoreTable::Events),
            Self::CodexEntries => Some(SnapshotRestoreTable::CodexEntries),
            Self::Snippets => Some(SnapshotRestoreTable::Snippets),
            Self::PostEffectAnnotations => Some(SnapshotRestoreTable::PostEffectAnnotations),
            Self::ChatMessages | Self::ChatSessions | Self::PostEffectRuns => None,
        }
    }

    /// `true` when rows of the live database that the restore does not delete
    /// still exist next to the plan's rows (the parent is "partial").
    pub(super) fn partial(self) -> bool {
        matches!(self, Self::PostEffectAnnotations)
    }

    /// Which of `ids` (`{ids}`) of this project's rows exist in the live
    /// database and survive the restore; `?1` is the project.
    fn live_sql(self) -> &'static str {
        match self {
            Self::TreeNodes => "SELECT id FROM tree_nodes WHERE project_id = ?1 AND id IN ({ids})",
            Self::CodexEntries => {
                "SELECT id FROM codex_entries WHERE project_id = ?1 AND id IN ({ids})"
            }
            Self::Snippets => "SELECT id FROM snippets WHERE project_id = ?1 AND id IN ({ids})",
            Self::ChatMessages => {
                "SELECT m.id FROM chat_messages AS m
                   JOIN chat_sessions AS s ON s.id = m.session_id
                  WHERE s.project_id = ?1 AND m.id IN ({ids})"
            }
            Self::ChatSessions => {
                "SELECT id FROM chat_sessions WHERE project_id = ?1 AND id IN ({ids})"
            }
            Self::Events => "SELECT id FROM events WHERE project_id = ?1 AND id IN ({ids})",
            Self::PostEffectRuns => {
                "SELECT id FROM post_effect_runs WHERE project_id = ?1 AND id IN ({ids})"
            }
            // The rows with a scene go with their scene when Body is restored.
            Self::PostEffectAnnotations => {
                "SELECT id FROM post_effect_annotations
                  WHERE project_id = ?1 AND scene_id IS NULL AND id IN ({ids})"
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Action {
    /// The column becomes NULL (`ON DELETE SET NULL`).
    SetNull,
    /// The row, and the rows that cascade to it, are left out
    /// (`ON DELETE CASCADE`).
    DropRow,
}

/// A reference column of a table a restore replaces, pointing at a parent the
/// restore does not necessarily give back.
#[derive(Debug)]
pub(super) struct MissingParentEdge {
    pub(super) table: SnapshotRestoreTable,
    pub(super) column: &'static str,
    pub(super) parent: ParentRef,
    pub(super) action: Action,
    /// The scope that replaces `table` (the edge only matters when it is
    /// selected).
    pub(super) owner: RestoreScope,
    /// What the author calls it (`restore_links::KIND_ORDER`). Kinds are
    /// shared with `PARK_COLUMNS` where the meaning is the same: a live row
    /// parked and lost (the scope is not selected) and a snapshot row left out
    /// (the scope is selected) cannot both happen for one table.
    pub(super) kind: &'static str,
}

const fn edge(
    table: SnapshotRestoreTable,
    column: &'static str,
    parent: ParentRef,
    action: Action,
    owner: RestoreScope,
    kind: &'static str,
) -> MissingParentEdge {
    MissingParentEdge {
        table,
        column,
        parent,
        action,
        owner,
        kind,
    }
}

use Action::{DropRow, SetNull};
use ParentRef::{
    ChatMessages as Msg, ChatSessions as Sess, CodexEntries as Cx, Events as Ev,
    PostEffectAnnotations as Ann, PostEffectRuns as Run, Snippets as Sn, TreeNodes as Tn,
};
use RestoreScope::{Body, Codex, Map, Snippet};
use SnapshotRestoreTable as T;

/// 復元後に親が無くなりうる列。canonical filter で除外される分も別途通知件数へ加える。
pub(super) const MISSING_PARENT_EDGES: &[MissingParentEdge] = &[
    edge(
        T::CodexEntryPhases,
        "anchor_node_id",
        Tn,
        SetNull,
        Codex,
        "phase_anchor",
    ),
    edge(
        T::MapNodePositions,
        "snippet_id",
        Sn,
        DropRow,
        Map,
        "map_placements",
    ),
    edge(
        T::MapNodePositions,
        "tree_node_id",
        Tn,
        DropRow,
        Map,
        "map_placements",
    ),
    edge(
        T::MapNodePositions,
        "codex_entry_id",
        Cx,
        DropRow,
        Map,
        "map_placements",
    ),
    edge(
        T::MapStickies,
        "source_chat_message_id",
        Msg,
        SetNull,
        Map,
        "map_source_links",
    ),
    edge(
        T::EditorStickies,
        "chronicle_event_id",
        Ev,
        DropRow,
        Map,
        "editor_stickies",
    ),
    edge(
        T::MapAiBranches,
        "session_id",
        Sess,
        SetNull,
        Map,
        "map_source_links",
    ),
    edge(
        T::Snippets,
        "source_chat_message_id",
        Msg,
        SetNull,
        Snippet,
        "snippet_source_message",
    ),
    edge(
        T::PostEffectAnnotations,
        "run_id",
        Run,
        SetNull,
        Body,
        "analysis_run_links",
    ),
    edge(
        T::PostEffectAnnotationRelations,
        "annotation_b_id",
        Ann,
        DropRow,
        Body,
        "analysis_annotations",
    ),
    edge(
        T::PostEffectAnnotationRelations,
        "run_id",
        Run,
        SetNull,
        Body,
        "analysis_run_links",
    ),
    edge(
        T::PostEffectAnnotations,
        "parent_id",
        Ann,
        DropRow,
        Body,
        "analysis_annotations",
    ),
];

/// A row of the plan that `CASCADE`s to a row of the plan that is left out.
#[derive(Debug)]
pub(super) struct Dependent {
    /// The table of the row that is left out.
    pub(super) parent: SnapshotRestoreTable,
    pub(super) table: SnapshotRestoreTable,
    pub(super) column: &'static str,
    pub(super) owner: RestoreScope,
    pub(super) kind: &'static str,
}

pub(super) const DEPENDENTS: &[Dependent] = &[
    Dependent {
        parent: T::MapNodePositions,
        table: T::MapEdges,
        column: "from_position_id",
        owner: Map,
        kind: "map_edges",
    },
    Dependent {
        parent: T::MapNodePositions,
        table: T::MapEdges,
        column: "to_position_id",
        owner: Map,
        kind: "map_edges",
    },
    Dependent {
        parent: T::PostEffectAnnotations,
        table: T::PostEffectAnnotations,
        column: "parent_id",
        owner: Body,
        kind: "analysis_annotations",
    },
    Dependent {
        parent: T::PostEffectAnnotations,
        table: T::PostEffectAnnotationRelations,
        column: "annotation_a_id",
        owner: Body,
        kind: "analysis_annotations",
    },
    Dependent {
        parent: T::PostEffectAnnotations,
        table: T::PostEffectAnnotationRelations,
        column: "annotation_b_id",
        owner: Body,
        kind: "analysis_annotations",
    },
];

/// The plan after the missing parents have been dealt with, and what was left
/// out or cleared, by kind (rows, not columns).
pub(super) struct Resolved {
    pub(super) plan: Vec<SnapshotInsertPlan>,
    pub(super) dropped: BTreeMap<&'static str, i64>,
}

/// The tables whose references this step can change: the checked-for-dangling
/// set of the restore must include them (`restore_links::touched_tables`).
pub(super) fn touched_tables(scopes: &HashSet<RestoreScope>) -> Vec<&'static str> {
    let mut tables = Vec::new();
    let mut add = |table: SnapshotRestoreTable| {
        let name = table.as_str();
        if !tables.contains(&name) {
            tables.push(name);
        }
    };
    for edge in MISSING_PARENT_EDGES {
        if scopes.contains(&edge.owner) {
            add(edge.table);
        }
    }
    for dependent in DEPENDENTS {
        if scopes.contains(&dependent.owner) {
            add(dependent.table);
        }
    }
    tables
}

fn text<'a>(row: &'a serde_json::Map<String, Value>, column: &str) -> Option<&'a str> {
    row.get(column).and_then(Value::as_str)
}

/// Which of `wanted` (ids a plan row names) exist after the restore.
fn existing_ids(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    plan: &[SnapshotInsertPlan],
    parent: ParentRef,
    wanted: &HashSet<String>,
) -> anyhow::Result<HashSet<String>> {
    let mut found = HashSet::new();
    let replaced = parent
        .replaced_by()
        .is_some_and(|scope| shape.scopes.contains(&scope))
        && (parent != ParentRef::Events || shape.events_aux);
    if replaced {
        // The restore deletes this parent's rows and inserts the plan's.
        if let Some(table) = parent.plan_table() {
            for insert in plan.iter().filter(|insert| insert.table == table) {
                if let Some(id) = text(&insert.row, "id") {
                    if wanted.contains(id) {
                        found.insert(id.to_string());
                    }
                }
            }
        }
        if !parent.partial() {
            return Ok(found);
        }
    }
    // The lookup below knows only the live rows the restore keeps. A partial
    // parent (annotations) whose scope is not selected would also need the live
    // rows that carry a scene, which `live_sql` leaves out. No edge points at
    // one today (annotations are the parent of Body edges only).
    debug_assert!(
        replaced || !parent.partial(),
        "a partial parent whose scope is not selected needs its own live lookup"
    );
    let ids: Vec<&String> = wanted.iter().collect();
    let restored_tree_node_ids: HashSet<String> = plan
        .iter()
        .filter(|insert| insert.table == SnapshotRestoreTable::TreeNodes)
        .filter_map(|insert| text(&insert.row, "id").map(str::to_string))
        .collect();
    for chunk in ids.chunks(ID_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let mut values = vec![SqlValue::Text(shape.project_id.to_string())];
        values.extend(chunk.iter().map(|id| SqlValue::Text((*id).clone())));
        if parent == ParentRef::PostEffectRuns && shape.scopes.contains(&RestoreScope::Body) {
            let sql = format!(
                "SELECT r.id, r.scope_target_id,
                        EXISTS(SELECT 1 FROM tree_nodes n
                                WHERE n.project_id = ?1 AND n.id = r.scope_target_id)
                   FROM post_effect_runs r
                  WHERE r.project_id = ?1 AND r.id IN ({placeholders})"
            );
            let mut statement = conn.prepare(&sql)?;
            let rows = statement
                .query_map(params_from_iter(values.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            found.extend(
                rows.into_iter()
                    .filter_map(|(id, target, target_is_live_scene)| {
                        (!target_is_live_scene
                            || target
                                .as_ref()
                                .is_some_and(|target| restored_tree_node_ids.contains(target)))
                        .then_some(id)
                    }),
            );
        } else {
            let sql = parent.live_sql().replace("{ids}", &placeholders);
            let mut statement = conn.prepare(&sql)?;
            let rows = statement
                .query_map(params_from_iter(values.iter()), |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            found.extend(rows);
        }
    }
    Ok(found)
}

fn count_uncaptured_body_losses(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    plan: &[SnapshotInsertPlan],
) -> anyhow::Result<(i64, i64)> {
    if !shape.scopes.contains(&RestoreScope::Body) {
        return Ok((0, 0));
    }
    let captured: HashSet<String> =
        maybe_aux_snapshot_rows(conn, shape.snapshot_id, "post_effect_annotation_relations")?
            .into_iter()
            .filter_map(|row| text(&row, "id").map(str::to_string))
            .collect();
    let mut statement = conn.prepare(
        "WITH RECURSIVE doomed_annotations(id) AS (
             SELECT a.id
               FROM post_effect_annotations a
               JOIN tree_nodes n ON n.id = a.scene_id
              WHERE a.project_id = ?1 AND n.project_id = ?1
             UNION
             SELECT child.id
               FROM post_effect_annotations child
               JOIN doomed_annotations parent ON parent.id = child.parent_id
              WHERE child.project_id = ?1
         )
         SELECT id FROM doomed_annotations",
    )?;
    let doomed_annotations: HashSet<String> = statement
        .query_map([shape.project_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let restored_scenes: HashSet<String> = plan
        .iter()
        .filter(|insert| insert.table == SnapshotRestoreTable::TreeNodes)
        .filter_map(|insert| text(&insert.row, "id").map(str::to_string))
        .collect();
    let mut statement = conn.prepare(
        "SELECT r.id, r.scope_target_id,
                EXISTS(SELECT 1 FROM tree_nodes n
                        WHERE n.project_id = ?1 AND n.id = r.scope_target_id)
           FROM post_effect_runs r
          WHERE r.project_id = ?1
            AND r.id IN (
                SELECT run_id FROM post_effect_annotations
                 WHERE project_id = ?1 AND run_id IS NOT NULL
                UNION
                SELECT run_id FROM post_effect_annotation_relations
                 WHERE project_id = ?1 AND run_id IS NOT NULL
            )",
    )?;
    let runs = statement
        .query_map([shape.project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let vanished_runs: HashSet<String> = runs
        .into_iter()
        .filter_map(|(id, target, is_project_scene)| {
            (is_project_scene
                && target
                    .as_ref()
                    .is_some_and(|target| !restored_scenes.contains(target)))
            .then_some(id)
        })
        .collect();

    let mut lost_run_links = 0;
    if !vanished_runs.is_empty() {
        let mut statement = conn.prepare(
            "SELECT id, run_id FROM post_effect_annotations
              WHERE project_id = ?1 AND scene_id IS NULL AND run_id IS NOT NULL",
        )?;
        let links = statement
            .query_map([shape.project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        lost_run_links += links
            .into_iter()
            .filter(|(id, run_id)| {
                !doomed_annotations.contains(id) && vanished_runs.contains(run_id)
            })
            .count() as i64;
    }

    let mut statement = conn.prepare(
        "SELECT id, annotation_a_id, annotation_b_id, run_id
           FROM post_effect_annotation_relations
          WHERE project_id = ?1",
    )?;
    let relations = statement
        .query_map([shape.project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut lost_annotations = 0;
    for (id, a_id, b_id, run_id) in relations {
        let endpoint_disappears =
            doomed_annotations.contains(&a_id) || doomed_annotations.contains(&b_id);
        if !captured.contains(&id) && endpoint_disappears {
            lost_annotations += 1;
        } else if !captured.contains(&id)
            && run_id
                .as_ref()
                .is_some_and(|run_id| vanished_runs.contains(run_id))
        {
            lost_run_links += 1;
        }
    }
    Ok((lost_annotations, lost_run_links))
}

/// The rows of the plan that fall away: by position in the plan (with the kind
/// that took them away) and, for the rows that others cascade to, by id.
#[derive(Default)]
struct LeftOut {
    kinds: HashMap<usize, &'static str>,
    ids: HashMap<SnapshotRestoreTable, HashSet<String>>,
}

impl LeftOut {
    /// `true` when the row had not fallen away yet.
    fn add(&mut self, plan: &[SnapshotInsertPlan], index: usize, kind: &'static str) -> bool {
        if self.kinds.insert(index, kind).is_some() {
            return false;
        }
        if let Some(id) = text(&plan[index].row, "id") {
            self.ids
                .entry(plan[index].table)
                .or_default()
                .insert(id.to_string());
        }
        true
    }
}

#[cfg(test)]
pub(super) fn resolve(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    plan: Vec<SnapshotInsertPlan>,
) -> anyhow::Result<Resolved> {
    resolve_with_dropped(conn, shape, plan, BTreeMap::new())
}

/// Deals with every snapshot row of `plan` whose parent is missing after the
/// restore, as described in the module documentation. The input is the plan
/// that was compared with the renderer's; nothing in it comes from the
/// renderer's judgement.
pub(super) fn resolve_with_dropped(
    conn: &Connection,
    shape: &RestoreShape<'_>,
    mut plan: Vec<SnapshotInsertPlan>,
    mut dropped: BTreeMap<&'static str, i64>,
) -> anyhow::Result<Resolved> {
    let edges: Vec<&MissingParentEdge> = MISSING_PARENT_EDGES
        .iter()
        .filter(|edge| shape.scopes.contains(&edge.owner))
        .collect();
    let mut by_table: HashMap<SnapshotRestoreTable, Vec<usize>> = HashMap::new();
    for (index, insert) in plan.iter().enumerate() {
        if edges.iter().any(|edge| edge.table == insert.table)
            || DEPENDENTS.iter().any(|dep| dep.table == insert.table)
        {
            by_table.entry(insert.table).or_default().push(index);
        }
    }
    let rows_of = |table: SnapshotRestoreTable| -> &[usize] {
        by_table.get(&table).map_or(&[], Vec::as_slice)
    };

    // Which parents exist, for the ids the plan names.
    let mut wanted: HashMap<ParentRef, HashSet<String>> = HashMap::new();
    for edge in &edges {
        for &index in rows_of(edge.table) {
            if let Some(id) = text(&plan[index].row, edge.column) {
                wanted
                    .entry(edge.parent)
                    .or_default()
                    .insert(id.to_string());
            }
        }
    }
    let mut exists: HashMap<ParentRef, HashSet<String>> = HashMap::new();
    for (parent, ids) in &wanted {
        exists.insert(*parent, existing_ids(conn, shape, &plan, *parent, ids)?);
    }
    let missing = |plan: &[SnapshotInsertPlan], index: usize, edge: &MissingParentEdge| -> bool {
        text(&plan[index].row, edge.column)
            .is_some_and(|id| !exists.get(&edge.parent).is_some_and(|set| set.contains(id)))
    };

    // Rows that fall away: first those whose own parent is missing, then every
    // row that cascades to one that fell away, until nothing more does.
    let mut left_out = LeftOut::default();
    for edge in edges.iter().filter(|edge| edge.action == Action::DropRow) {
        for &index in rows_of(edge.table) {
            if missing(&plan, index, edge) {
                left_out.add(&plan, index, edge.kind);
            }
        }
    }
    loop {
        let mut changed = false;
        for dependent in DEPENDENTS
            .iter()
            .filter(|dep| shape.scopes.contains(&dep.owner))
        {
            let Some(parents) = left_out.ids.get(&dependent.parent).cloned() else {
                continue;
            };
            for &index in rows_of(dependent.table) {
                if !left_out.kinds.contains_key(&index)
                    && text(&plan[index].row, dependent.column)
                        .is_some_and(|id| parents.contains(id))
                {
                    changed |= left_out.add(&plan, index, dependent.kind);
                }
            }
        }
        if !changed {
            break;
        }
    }

    // The rows that stay lose the references that point at nothing.
    let mut cleared: HashSet<(usize, &'static str)> = HashSet::new();
    for edge in edges.iter().filter(|edge| edge.action == Action::SetNull) {
        for &index in rows_of(edge.table) {
            if !left_out.kinds.contains_key(&index) && missing(&plan, index, edge) {
                plan[index].row.insert(edge.column.to_string(), Value::Null);
                cleared.insert((index, edge.kind));
            }
        }
    }

    for kind in left_out.kinds.values() {
        *dropped.entry(kind).or_default() += 1;
    }
    for (_, kind) in &cleared {
        *dropped.entry(kind).or_default() += 1;
    }
    let (uncaptured_relations, live_run_links) = count_uncaptured_body_losses(conn, shape, &plan)?;
    if uncaptured_relations > 0 {
        *dropped.entry("analysis_annotations").or_default() += uncaptured_relations;
    }
    if live_run_links > 0 {
        *dropped.entry("analysis_run_links").or_default() += live_run_links;
    }
    let plan = plan
        .into_iter()
        .enumerate()
        .filter(|(index, _)| !left_out.kinds.contains_key(index))
        .map(|(_, insert)| insert)
        .collect();
    Ok(Resolved { plan, dropped })
}

#[cfg(test)]
mod tests;
