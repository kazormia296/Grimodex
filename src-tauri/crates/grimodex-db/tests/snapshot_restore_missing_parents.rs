//! Acceptance tests for a scoped project snapshot restore whose snapshot rows
//! name a parent that no longer exists (DR-SRX-26.., `docs/plans/nir1-lane-decisions/
//! snapshot-restore-cross-scope-decisions.md`).
//!
//! A row of the snapshot that points at a parent which is gone after the
//! restore is brought back as it would be had the parent been deleted after
//! the restore: an `ON DELETE SET NULL` column becomes NULL, a `CASCADE` row
//! (and the rows that `CASCADE` to it) is left out. The restore succeeds, the
//! foreign keys are clean, and the number of what was left out is reported in
//! the confirmation and in the result. Helpers are copied from
//! `snapshot_restore_cross_scope.rs`; `plan` mirrors the product builder
//! (src/features/revision/projectSnapshotApi.ts) for the tables these tests touch.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

use grimodex_db::change_events::{append_change_events_in_tx, AppendChangeEvent};
use grimodex_db::project_snapshots::{
    apply_project_snapshot_restore, create_project_snapshot, project_snapshot_restore_context,
    ApplyProjectSnapshotRestorePayload, CreateProjectSnapshotPayload, RestoreScope,
    SnapshotInsertMode, SnapshotInsertPlan, SnapshotRestoreTable,
};
use grimodex_db::Database;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

const P: &str = "probe-p1";
const SESSION: &str = "probe-session";
const BOARD: &str = "probe-p1-main-board";
const PARK_PREFIX: &str = "__grimodex_restore_park_";

fn de<T: DeserializeOwned>(value: Value) -> anyhow::Result<T> {
    Ok(serde_json::from_value(value)?)
}

fn must<T>(r: anyhow::Result<T>, what: &str) -> T {
    r.unwrap_or_else(|e| panic!("{what}: unexpected error: {e:#}"))
}

fn new_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute_batch(&format!(
            "INSERT INTO projects (id, title) VALUES ('{P}', 'One');
             INSERT INTO narrative_semantic_epochs
                 (id, project_id, epoch_number, reason, created_at)
             VALUES ('probe-epoch', '{P}', 0, 'initial', '2026-08-23T00:00:00.000Z');
             INSERT INTO chat_sessions (id, project_id, title)
               VALUES ('{SESSION}', '{P}', 'Local session');"
        ))?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn exec(db: &Database, sql: &str) {
    db.with_conn(|conn| {
        conn.execute_batch(sql)?;
        Ok(())
    })
    .unwrap_or_else(|e| panic!("sql failed: {e:#}\n{sql}"));
}

fn scalar_i64(db: &Database, sql: &str) -> i64 {
    db.with_conn(|conn| Ok(conn.query_row(sql, [], |r| r.get::<_, i64>(0))?))
        .unwrap_or_else(|e| panic!("scalar failed: {e:#}\n{sql}"))
}

fn scalar_text(db: &Database, sql: &str) -> Option<String> {
    db.with_conn(|conn| Ok(conn.query_row(sql, [], |r| r.get::<_, Option<String>>(0))?))
        .unwrap_or_else(|e| panic!("scalar failed: {e:#}\n{sql}"))
}

fn one_string(db: &Database, sql: &str, params: &[&str]) -> Option<String> {
    use rusqlite::OptionalExtension;
    db.with_conn(|conn| {
        Ok(conn
            .query_row(sql, rusqlite::params_from_iter(params.iter()), |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten())
    })
    .expect("query")
}

fn json_rows(db: &Database, sql: &str, params: &[&str]) -> Vec<serde_json::Map<String, Value>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                r.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("json rows")
    .into_iter()
    .map(|s| {
        serde_json::from_str::<Value>(&s)
            .expect("json")
            .as_object()
            .cloned()
            .expect("object")
    })
    .collect()
}

// =====================================================================
// Snapshot + canonical plan (the product's builder is crate-private)
// =====================================================================

fn snapshot(db: &Database, snapshot_id: &str) {
    let tree_rows = json_rows(
        db,
        "SELECT json_object(
            'snapshot_id', ?1, 'node_id', id, 'parent_id', parent_id,
            'node_type', node_type, 'title', title, 'synopsis', synopsis,
            'intent', intent, 'sort_order', sort_order,
            'story_time_order', story_time_order, 'story_time_label', story_time_label,
            'pov_character_id', pov_character_id, 'location_id', location_id,
            'chronicle_start_time', chronicle_start_time,
            'chronicle_start_minute', chronicle_start_minute,
            'chronicle_start_granularity', chronicle_start_granularity,
            'chronicle_end_time', chronicle_end_time,
            'chronicle_end_minute', chronicle_end_minute,
            'chronicle_end_granularity', chronicle_end_granularity,
            'chronicle_precision', chronicle_precision, 'status', status,
            'body_version_id', NULL, 'unplaced_beats_doc', unplaced_beats_doc,
            'char_count', char_count, 'created_at', created_at, 'updated_at', updated_at)
           FROM tree_nodes WHERE project_id = ?2",
        &[snapshot_id, P],
    );
    let codex_rows = json_rows(
        db,
        "SELECT json_object(
            'snapshot_id', ?1, 'entry_id', id, 'type', type, 'name', name,
            'parent_id', parent_id, 'aliases', aliases,
            'excluded_aliases', excluded_aliases, 'summary', summary, 'icon', icon,
            'context_mode', context_mode, 'children_budget', children_budget,
            'notes', notes, 'body_version_id', NULL,
            'created_at', created_at, 'updated_at', updated_at)
           FROM codex_entries WHERE project_id = ?2",
        &[snapshot_id, P],
    );
    let snippet_rows = json_rows(
        db,
        "SELECT json_object(
            'snapshot_id', ?1, 'snippet_id', id, 'title', title, 'scene_id', scene_id,
            'source_chat_message_id', source_chat_message_id, 'body_version_id', NULL,
            'created_at', created_at, 'updated_at', updated_at)
           FROM snippets WHERE project_id = ?2",
        &[snapshot_id, P],
    );
    create_project_snapshot(
        db,
        CreateProjectSnapshotPayload {
            project_id: P.to_string(),
            snapshot_id: snapshot_id.to_string(),
            name: format!("Snapshot {snapshot_id}"),
            description: None,
            created_at: "2026-08-23T00:00:00.000Z".to_string(),
            tree_rows,
            codex_rows,
            snippet_rows,
            version_ids: Vec::new(),
        },
    )
    .expect("create snapshot");
}

fn table(name: &str) -> SnapshotRestoreTable {
    serde_json::from_value(Value::String(name.to_string())).expect("restore table name")
}

fn live_ids(db: &Database, sql: &str) -> BTreeSet<String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?;
        Ok(rows)
    })
    .expect("live ids")
}

/// Mirrors the product plan builder (projectSnapshotApi.ts) and the canonical
/// plan's own filters: a reference to a parent of a scope that is not selected
/// and not live is cleared, or the row is left out (snippets.scene_id, the POV
/// and location of a scene, an event's entries, the pins, mentions, labels,
/// foreshadow and lint rows, editor stickies). A map position, a phase's
/// anchor and the other columns this step handles are sent as the snapshot has
/// them: the Rust side decides what a missing parent means (DR-SRX-26).
/// Returns false when the row is skipped.
fn product_filter(
    db: &Database,
    tbl: &str,
    scopes: &[RestoreScope],
    row: &mut serde_json::Map<String, Value>,
) -> bool {
    let body = scopes.contains(&RestoreScope::Body);
    let codex = scopes.contains(&RestoreScope::Codex);
    let snippet = scopes.contains(&RestoreScope::Snippet);
    let text = |row: &serde_json::Map<String, Value>, k: &str| -> Option<String> {
        row.get(k).and_then(Value::as_str).map(str::to_string)
    };
    let live_nodes = || live_ids(db, "SELECT id FROM tree_nodes");
    let live_codex = || live_ids(db, "SELECT id FROM codex_entries");
    match tbl {
        "snippets" => {
            if let Some(scene) = text(row, "scene_id") {
                if !body && !live_nodes().contains(&scene) {
                    row.insert("scene_id".to_string(), Value::Null);
                }
            }
            true
        }
        "editor_stickies" => {
            let unavailable = (!body
                && text(row, "tree_node_id").is_some_and(|t| !live_nodes().contains(&t)))
                || (!codex
                    && text(row, "codex_entry_id").is_some_and(|c| !live_codex().contains(&c)))
                || (!codex
                    && text(row, "phase_id").is_some_and(|p| {
                        !live_ids(db, "SELECT id FROM codex_entry_phases").contains(&p)
                    }))
                || (!snippet
                    && text(row, "snippet_id")
                        .is_some_and(|s| !live_ids(db, "SELECT id FROM snippets").contains(&s)))
                || (!body
                    && text(row, "chronicle_event_id")
                        .is_some_and(|e| !live_ids(db, "SELECT id FROM events").contains(&e)));
            !unavailable
        }
        "tree_nodes" => {
            for field in ["pov_character_id", "location_id"] {
                if let Some(c) = text(row, field) {
                    if !codex && !live_codex().contains(&c) {
                        row.insert(field.to_string(), Value::Null);
                    }
                }
            }
            true
        }
        "events" => {
            for field in ["primary_codex_id", "location_codex_id"] {
                if let Some(c) = text(row, field) {
                    if !codex && !live_codex().contains(&c) {
                        row.insert(field.to_string(), Value::Null);
                    }
                }
            }
            true
        }
        // A row that names an entry that is neither restored nor live is left out.
        "scene_codex_pins"
        | "scene_codex_mentions"
        | "scene_beat_pov_cache"
        | "event_participants"
        | "foreshadow_codex_links" => {
            let field = match tbl {
                "scene_codex_pins" => "entry_id",
                "scene_beat_pov_cache" => "pov_character_id",
                _ => "codex_entry_id",
            };
            codex || text(row, field).is_none_or(|c| live_codex().contains(&c))
        }
        "snippet_entry_tags" => {
            codex
                || text(row, "tag_id")
                    .is_none_or(|t| live_ids(db, "SELECT id FROM codex_tags").contains(&t))
        }
        // A row that needs a scene is left out unless Body restores it or it is live.
        "tree_node_labels" => {
            body || text(row, "node_id").is_some_and(|n| live_nodes().contains(&n))
        }
        "foreshadow_setups" | "foreshadow_payoffs" | "lint_ignored_diagnostics" => {
            body || text(row, "scene_id").is_some_and(|n| live_nodes().contains(&n))
        }
        "foreshadows" => {
            if let Some(n) = text(row, "payoff_scene_id") {
                if !body && !live_nodes().contains(&n) {
                    row.insert("payoff_scene_id".to_string(), Value::Null);
                }
            }
            true
        }
        _ => true,
    }
}

/// The canonical plan for any scope set. Every snapshot row is inserted as it
/// is: these tests only ever restore a snapshot whose rows all point at things
/// that existed when it was taken, so the product builder's "drop rows whose
/// unselected owner is gone" filters would not remove anything anyway.
fn plan(db: &Database, snapshot_id: &str, scopes: &[RestoreScope]) -> Vec<SnapshotInsertPlan> {
    let mut plans = Vec::new();
    let aux = |plans: &mut Vec<SnapshotInsertPlan>, scope: &str, mode: SnapshotInsertMode| {
        let payload: Option<String> = one_string(
            db,
            "SELECT payload_json FROM project_snapshot_aux WHERE snapshot_id = ?1 AND scope = ?2",
            &[snapshot_id, scope],
        );
        let Some(payload) = payload else { return };
        let payload: Value = serde_json::from_str(&payload).expect("aux payload");
        for row in payload["rows"].as_array().cloned().unwrap_or_default() {
            let mut row = row.as_object().cloned().expect("row");
            if !product_filter(db, scope, scopes, &mut row) {
                continue;
            }
            plans.push(SnapshotInsertPlan {
                table: table(scope),
                row,
                mode,
            });
        }
    };
    let core = |plans: &mut Vec<SnapshotInsertPlan>, tbl: &str, sql: &str| {
        for mut row in json_rows(db, sql, &[snapshot_id, P]) {
            if !product_filter(db, tbl, scopes, &mut row) {
                continue;
            }
            plans.push(SnapshotInsertPlan {
                table: table(tbl),
                row,
                mode: SnapshotInsertMode::Insert,
            });
        }
    };
    if scopes.contains(&RestoreScope::Codex) {
        aux(&mut plans, "codex_types", SnapshotInsertMode::Replace);
        core(
            &mut plans,
            "codex_entries",
            "SELECT json_object('id', entry_id, 'project_id', ?2, 'parent_id', parent_id,
                'type', type, 'name', name, 'aliases', aliases,
                'excluded_aliases', excluded_aliases, 'summary', summary, 'content', '{}',
                'icon', icon, 'tags_cache', NULL, 'context_mode', context_mode,
                'children_budget', children_budget, 'source_chat_message_id', NULL,
                'notes', notes, 'created_at', created_at, 'updated_at', updated_at)
               FROM project_snapshot_codex_entries WHERE snapshot_id = ?1 ORDER BY entry_id",
        );
        for scope in [
            "codex_tags",
            "codex_detail_definitions",
            "codex_detail_semantic_bindings",
            "codex_entry_tags",
            "codex_detail_values",
            "codex_entry_phases",
            "codex_phase_detail_overrides",
            "codex_quick_pins",
            "codex_dismissed_relations",
            "codex_relations",
        ] {
            aux(&mut plans, scope, SnapshotInsertMode::Insert);
        }
    }
    if scopes.contains(&RestoreScope::Body) {
        core(
            &mut plans,
            "tree_nodes",
            "SELECT json_object('id', node_id, 'project_id', ?2, 'parent_id', parent_id,
                'node_type', node_type, 'title', title, 'synopsis', synopsis,
                'intent', intent, 'sort_order', sort_order,
                'story_time_order', story_time_order, 'story_time_label', story_time_label,
                'pov_character_id', pov_character_id, 'location_id', location_id,
                'chronicle_start_time', chronicle_start_time,
                'chronicle_start_minute', chronicle_start_minute,
                'chronicle_start_granularity', chronicle_start_granularity,
                'chronicle_end_time', chronicle_end_time,
                'chronicle_end_minute', chronicle_end_minute,
                'chronicle_end_granularity', chronicle_end_granularity,
                'chronicle_precision', chronicle_precision, 'status', status,
                'content', '{}', 'unplaced_beats_doc', unplaced_beats_doc,
                'char_count', char_count, 'unplaced_beat_preview', NULL,
                'placed_beat_preview', NULL, 'created_at', created_at,
                'updated_at', updated_at)
               FROM project_snapshot_tree_nodes WHERE snapshot_id = ?1 ORDER BY node_id",
        );
        for scope in [
            "authorship_spans",
            "post_effect_annotations",
            "post_effect_annotation_relations",
            "scene_codex_pins",
            "scene_codex_mentions",
            "scene_beat_pov_cache",
            "plot_threads",
            "plot_thread_scene_links",
            "plot_thread_branches",
            "events",
            "scene_events",
            "event_participants",
            "event_relations",
            "project_calendar",
        ] {
            aux(&mut plans, scope, SnapshotInsertMode::Insert);
        }
    }
    if scopes.contains(&RestoreScope::Snippet) {
        core(
            &mut plans,
            "snippets",
            "SELECT json_object('id', snippet_id, 'project_id', ?2, 'title', title,
                'scene_id', scene_id, 'source_chat_message_id', source_chat_message_id,
                'content', '{}', 'tags_cache', NULL, 'content_source', NULL,
                'usage_count', 0, 'version', 0, 'created_at', created_at,
                'updated_at', updated_at)
               FROM project_snapshot_snippets WHERE snapshot_id = ?1 ORDER BY snippet_id",
        );
        aux(&mut plans, "snippet_entry_tags", SnapshotInsertMode::Insert);
    }
    if scopes.contains(&RestoreScope::Foreshadow) {
        for scope in [
            "foreshadows",
            "foreshadow_setups",
            "foreshadow_payoffs",
            "foreshadow_setup_payoff_links",
            "foreshadow_codex_links",
        ] {
            aux(&mut plans, scope, SnapshotInsertMode::Insert);
        }
    }
    if scopes.contains(&RestoreScope::Labels) {
        aux(&mut plans, "labels", SnapshotInsertMode::Insert);
        aux(&mut plans, "tree_node_labels", SnapshotInsertMode::Insert);
    }
    if scopes.contains(&RestoreScope::Map) {
        for scope in [
            "map_boards",
            "map_ai_branches",
            "map_stickies",
            "editor_stickies",
            "map_frames",
            "map_node_positions",
            "map_edges",
        ] {
            aux(&mut plans, scope, SnapshotInsertMode::Insert);
        }
    }
    if scopes.contains(&RestoreScope::Lint) {
        aux(
            &mut plans,
            "lint_term_dictionary",
            SnapshotInsertMode::Insert,
        );
        aux(
            &mut plans,
            "lint_ignored_diagnostics",
            SnapshotInsertMode::Insert,
        );
    }
    // A setup/payoff link stays only when both its ends were restored.
    let kept = |plans: &[SnapshotInsertPlan], tbl: &str| -> BTreeSet<String> {
        plans
            .iter()
            .filter(|p| p.table == table(tbl))
            .filter_map(|p| p.row.get("id").and_then(Value::as_str).map(str::to_string))
            .collect()
    };
    let setups = kept(&plans, "foreshadow_setups");
    let payoffs = kept(&plans, "foreshadow_payoffs");
    plans.retain(|p| {
        p.table != table("foreshadow_setup_payoff_links")
            || (p
                .row
                .get("setup_id")
                .and_then(Value::as_str)
                .is_some_and(|id| setups.contains(id))
                && p.row
                    .get("payoff_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| payoffs.contains(id)))
    });
    plans
}

fn payload(
    db: &Database,
    request_id: &str,
    snapshot_id: &str,
    scopes: &[RestoreScope],
) -> ApplyProjectSnapshotRestorePayload {
    ApplyProjectSnapshotRestorePayload {
        request_id: request_id.to_string(),
        session_id: SESSION.to_string(),
        project_id: P.to_string(),
        snapshot_id: snapshot_id.to_string(),
        scopes: scopes.to_vec(),
        inserts: plan(db, snapshot_id, scopes),
    }
}

/// What the restore reported and what the confirmation would have shown.
struct Restored {
    no_op: bool,
    /// `lossNotices` of `project_snapshot_restore_context` read before the
    /// restore (empty when the response has no such field).
    notices: BTreeMap<String, i64>,
    /// `dropped` of the restore result (empty when the result has no field).
    dropped: BTreeMap<String, i64>,
}

fn notice_map(value: &Value, field: &str) -> BTreeMap<String, i64> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    (
                        item["kind"].as_str().expect("kind").to_string(),
                        item["count"].as_i64().expect("count"),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn try_restore(
    db: &Database,
    request_id: &str,
    snapshot_id: &str,
    scopes: &[RestoreScope],
) -> anyhow::Result<Restored> {
    let context = project_snapshot_restore_context(
        db,
        P.to_string(),
        snapshot_id.to_string(),
        scopes.to_vec(),
    )?;
    let notices = notice_map(&serde_json::to_value(&context)?, "lossNotices");
    let result = apply_project_snapshot_restore(db, payload(db, request_id, snapshot_id, scopes))?;
    let dropped = notice_map(&serde_json::to_value(&result)?, "dropped");
    Ok(Restored {
        no_op: result.no_op,
        notices,
        dropped,
    })
}

fn restore(
    db: &Database,
    request_id: &str,
    snapshot_id: &str,
    scopes: &[RestoreScope],
) -> Restored {
    must(
        try_restore(db, request_id, snapshot_id, scopes),
        "restore must succeed",
    )
}

// =====================================================================
// Row dumps
// =====================================================================

fn cell(value: rusqlite::types::ValueRef<'_>) -> String {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => "∅".to_string(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => format!("blob{}", b.len()),
    }
}

/// Every row of `sql` (which must select `rowid, *`) as `a|b|c|`, sorted.
fn dump_sql(db: &Database, sql: &str) -> Vec<String> {
    let mut rows = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(sql)?;
            let n = stmt.column_count();
            let rows = stmt
                .query_map([], |r| {
                    let mut s = String::new();
                    for i in 0..n {
                        s.push_str(&cell(r.get_ref(i)?));
                        s.push('|');
                    }
                    Ok(s)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_else(|e| panic!("dump failed: {e:#}\n{sql}"));
    rows.sort();
    rows
}

fn dump(db: &Database, table: &str) -> Vec<String> {
    dump_sql(db, &format!("SELECT rowid, * FROM \"{table}\""))
}

/// A restorable table (or the part of one) and the scope that replaces it.
/// `None` is a table no scope owns (chat, trash, AI records, ...): a restore
/// never replaces it, so it can only be changed by the cascades.
struct Group {
    name: &'static str,
    owner: Option<RestoreScope>,
    sql: &'static str,
    /// An `ON DELETE SET NULL` table keeps its rows, nulling the cell.
    set_null: bool,
}

fn groups() -> Vec<Group> {
    use RestoreScope::*;
    let t = |name: &'static str, owner: Option<RestoreScope>, set_null: bool| Group {
        name,
        owner,
        sql: "",
        set_null,
    };
    let mut v = vec![
        // Body
        t("tree_nodes", Some(Body), true),
        t("generation_logs", Some(Body), false),
        t("post_effect_annotations", Some(Body), false),
        t("post_effect_annotation_relations", Some(Body), false),
        t("scene_codex_pins", Some(Body), false),
        t("scene_codex_mentions", Some(Body), false),
        t("scene_beat_pov_cache", Some(Body), false),
        t("plot_threads", Some(Body), true),
        t("plot_thread_scene_links", Some(Body), false),
        t("events", Some(Body), true),
        t("scene_events", Some(Body), false),
        t("event_participants", Some(Body), false),
        // Codex
        t("codex_entries", Some(Codex), true),
        t("codex_tags", Some(Codex), false),
        t("codex_entry_tags", Some(Codex), false),
        t("codex_detail_values", Some(Codex), false),
        t("codex_entry_phases", Some(Codex), true),
        t("codex_quick_pins", Some(Codex), false),
        t("codex_relations", Some(Codex), false),
        // Snippet
        t("snippets", Some(Snippet), true),
        t("snippet_entry_tags", Some(Snippet), false),
        // Labels
        t("labels", Some(Labels), false),
        t("tree_node_labels", Some(Labels), false),
        // Foreshadow
        t("foreshadows", Some(Foreshadow), true),
        t("foreshadow_setups", Some(Foreshadow), false),
        t("foreshadow_payoffs", Some(Foreshadow), false),
        t("foreshadow_setup_payoff_links", Some(Foreshadow), false),
        t("foreshadow_codex_links", Some(Foreshadow), false),
        // Map
        t("map_boards", Some(Map), false),
        t("map_stickies", Some(Map), true),
        t("editor_stickies", Some(Map), false),
        t("map_node_positions", Some(Map), false),
        t("map_edges", Some(Map), false),
        // Lint
        t("lint_term_dictionary", Some(Lint), false),
        t("lint_ignored_diagnostics", Some(Lint), false),
        // No owner
        t("chat_sessions", None, true),
        t("chat_session_pinned_codex", None, false),
        t("trash_items", None, false),
        t("impact_review_baselines", None, false),
        t("post_effect_runs", None, false),
        t("scene_lens_data", None, false),
        t("prose_staging", None, false),
        t("ai_usage", None, true),
        t("lint_action_log", None, true),
    ];
    for g in &mut v {
        g.sql = Box::leak(format!("SELECT rowid, * FROM \"{}\"", g.name).into_boxed_str());
    }
    // authorship_spans: one table, but the document a row points at decides
    // which scope owns it (a row points at exactly one document).
    for (name, owner, col) in [
        ("authorship:node", Body, "node_id IS NOT NULL"),
        (
            "authorship:codex",
            Codex,
            "(codex_entry_id IS NOT NULL OR detail_value_id IS NOT NULL)",
        ),
        ("authorship:snippet", Snippet, "snippet_id IS NOT NULL"),
        ("authorship:sticky", Map, "sticky_id IS NOT NULL"),
    ] {
        v.push(Group {
            name,
            owner: Some(owner),
            sql: Box::leak(
                format!("SELECT rowid, * FROM authorship_spans WHERE {col}").into_boxed_str(),
            ),
            set_null: false,
        });
    }
    v
}

fn snapshot_all(db: &Database) -> BTreeMap<&'static str, Vec<String>> {
    groups()
        .into_iter()
        .map(|g| (g.name, dump_sql(db, g.sql)))
        .collect()
}

/// The rows of a table after a restore that took `vanished` (ids of parents
/// that exist no longer) away: a row that names one is gone, except in an
/// `ON DELETE SET NULL` table, where only the cell becomes NULL.
fn expected_after(rows: &[String], vanished: &[&str], set_null: bool) -> Vec<String> {
    let mut out = Vec::new();
    for row in rows {
        let cells: Vec<&str> = row.split('|').collect();
        let hit = |c: &&str| vanished.contains(c);
        if cells.iter().any(hit) {
            if set_null {
                out.push(
                    cells
                        .iter()
                        .map(|c| if hit(c) { "∅" } else { c })
                        .collect::<Vec<_>>()
                        .join("|"),
                );
            }
        } else {
            out.push(row.clone());
        }
    }
    out.sort();
    out
}

/// Every text cell that still carries the restore's parking prefix.
fn parked_leftovers(db: &Database) -> Vec<String> {
    let tables: Vec<String> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                    AND name NOT LIKE '%\\_fts%' ESCAPE '\\'",
            )?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(names)
        })
        .expect("tables");
    let mut left = Vec::new();
    for table in tables {
        let columns: Vec<String> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
                let names = stmt
                    .query_map([], |r| r.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(names)
            })
            .expect("columns");
        for column in columns {
            let n = db
                .with_conn(|conn| {
                    Ok(conn
                        .query_row(
                            &format!(
                                "SELECT COUNT(*) FROM \"{table}\"
                                  WHERE typeof(\"{column}\") = 'text'
                                    AND substr(\"{column}\", 1, {}) = '{PARK_PREFIX}'",
                                PARK_PREFIX.len()
                            ),
                            [],
                            |r| r.get::<_, i64>(0),
                        )
                        .unwrap_or(0))
                })
                .expect("count");
            if n > 0 {
                left.push(format!("{table}.{column} x{n}"));
            }
        }
    }
    left
}

fn foreign_key_violations(db: &Database) -> usize {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
        let n = stmt.query_map([], |_| Ok(()))?.count();
        Ok(n)
    })
    .expect("foreign_key_check")
}

fn assert_clean(db: &Database, what: &str) {
    assert_eq!(parked_leftovers(db), Vec::<String>::new(), "{what}: parked");
    assert_eq!(foreign_key_violations(db), 0, "{what}: foreign_key_check");
}

// =====================================================================
// A rich project. No product writer creates most of these rows, so they are
// plain SQL; the restore does not care how a row came to be.
// =====================================================================

fn seed_rich(db: &Database) {
    exec(
        db,
        &format!(
            "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at) VALUES
               ('c1','{P}','character','Hero','[]','sum','{{}}',NULL,0,'t','t'),
               ('c2','{P}','character','Rival','[]','sum','{{}}',NULL,0,'t','t'),
               ('l1','{P}','location','Town','[]','sum','{{}}',NULL,0,'t','t');
             INSERT INTO codex_tags (id, project_id, name) VALUES ('tag1','{P}','Tag1');
             INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES ('c1','tag1');
             INSERT INTO tree_nodes (id, project_id, node_type, title, content, pov_character_id, location_id, created_at, updated_at, version) VALUES
               ('s1','{P}','scene','Scene 1','{{}}','c1','l1','t','t',0),
               ('s2','{P}','scene','Scene 2','{{}}','c2',NULL,'t','t',0);
             INSERT INTO codex_entry_phases (id, entry_id, anchor_node_id, label) VALUES ('ph1','c1','s1','Phase 1');
             INSERT INTO codex_detail_definitions (id, project_id, type_slug, name) VALUES ('def1','{P}','character','Age');
             INSERT INTO codex_detail_values (id, entry_id, definition_id, value) VALUES ('dv1','c1','def1','10');
             INSERT INTO events (id, project_id, title, ordinal, primary_codex_id, location_codex_id, reveal_scene_id)
               VALUES ('e1','{P}','Event 1','a0','c1','l1','s2');
             INSERT INTO event_participants (event_id, codex_entry_id, role) VALUES ('e1','c1','participant'),('e1','c2','participant');
             INSERT INTO scene_events (scene_id, event_id, incarnation_token) VALUES ('s1','e1','tok-e1-s1');
             INSERT INTO snippets (id, project_id, title, content, scene_id, usage_count, version, created_at, updated_at)
               VALUES ('sn1','{P}','Snippet 1','{{\"type\":\"doc\"}}','s1',0,0,'t','t');
             INSERT INTO snippet_entry_tags (snippet_id, tag_id) VALUES ('sn1','tag1');
             INSERT INTO foreshadows (id, project_id, title, payoff_scene_id, created_at, updated_at)
               VALUES ('fs1','{P}','Foreshadow 1','s2',1,1);
             INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind, semantic_key, created_at, updated_at)
               VALUES ('su1','fs1','s1',0,1,'plant','k-su1',1,1);
             INSERT INTO foreshadow_payoffs (id, foreshadow_id, scene_id, semantic_key, created_at, updated_at)
               VALUES ('pa1','fs1','s2','k-pa1',1,1);
             INSERT INTO foreshadow_setup_payoff_links (foreshadow_id, setup_id, payoff_id, created_at)
               VALUES ('fs1','su1','pa1',1);
             INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id) VALUES ('fs1','c1');
             INSERT INTO labels (id, project_id, name, color) VALUES ('lab1','{P}','Label','#fff');
             INSERT INTO tree_node_labels (node_id, label_id) VALUES ('s1','lab1');
             INSERT INTO lint_ignored_diagnostics (id, rule_id, scene_id, text_snippet, context_before, context_after, created_at)
               VALUES ('li1','r1','s1','t','a','b',1);
             INSERT INTO lint_term_dictionary (id, project_id, preferred, variants, created_at, updated_at)
               VALUES ('lt1','{P}','p','v',1,1);
             INSERT INTO scene_codex_pins (scene_id, entry_id, created_at) VALUES ('s1','c1','t');
             INSERT INTO scene_codex_mentions (scene_id, codex_entry_id, source) VALUES ('s1','c2','auto');
             INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES ('s1','c1');
             INSERT INTO map_stickies (id, board_id, title) VALUES ('st1','{BOARD}','Sticky 1');
             INSERT INTO map_node_positions (id, board_id, node_ref_type, tree_node_id, x, y) VALUES ('pos-s','{BOARD}','scene','s1',1,1);
             INSERT INTO map_node_positions (id, board_id, node_ref_type, codex_entry_id, x, y) VALUES ('pos-c','{BOARD}','codex','c1',2,2);
             INSERT INTO map_node_positions (id, board_id, node_ref_type, snippet_id, x, y) VALUES ('pos-sn','{BOARD}','snippet','sn1',3,3);
             INSERT INTO map_node_positions (id, board_id, node_ref_type, sticky_id, x, y) VALUES ('pos-st','{BOARD}','sticky','st1',4,4);
             INSERT INTO map_edges (id, board_id, from_position_id, to_position_id) VALUES ('edge1','{BOARD}','pos-s','pos-c');
             INSERT INTO editor_stickies (id, project_id, document_key, tree_node_id) VALUES ('es-s','{P}','tree: s1','s1');
             INSERT INTO editor_stickies (id, project_id, document_key, codex_entry_id, phase_id) VALUES ('es-c','{P}','codex: c1','c1','ph1');
             INSERT INTO editor_stickies (id, project_id, document_key, snippet_id) VALUES ('es-sn','{P}','snippet: sn1','sn1');
             INSERT INTO editor_stickies (id, project_id, document_key, chronicle_event_id) VALUES ('es-e','{P}','chronicle-event: e1','e1');
             UPDATE chat_sessions SET node_id = 's1', codex_anchor_id = 'c1', snippet_anchor_id = 'sn1' WHERE id = '{SESSION}';
             INSERT INTO chat_session_pinned_codex (id, session_id, codex_entry_id) VALUES ('pin-c','{SESSION}','c1');
             INSERT INTO chat_session_pinned_codex (id, session_id, snippet_id) VALUES ('pin-sn','{SESSION}','sn1');
             INSERT INTO chat_session_pinned_codex (id, session_id, sticky_id) VALUES ('pin-st','{SESSION}','st1');
             INSERT INTO trash_items (id, project_id, kind, sub_kind, origin_scene_id, preview_text, payload, char_count, deleted_at)
               VALUES ('tr-s','{P}','scene','scene','s1','p','{{}}',1,'t');
             INSERT INTO trash_items (id, project_id, kind, sub_kind, origin_codex_id, preview_text, payload, char_count, deleted_at)
               VALUES ('tr-c','{P}','codex','character','c1','p','{{}}',1,'t');
             INSERT INTO impact_review_baselines (entry_id, project_id, snapshot_json, content_hash) VALUES ('c1','{P}','{{}}','h');
             INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status)
               VALUES ('run1','{P}','review','scene','s1','m','v','completed');
             INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
               VALUES ('an1','{P}','run1','scene_range','s1','review','note');
             INSERT INTO scene_lens_data (id, project_id, run_id, target_id, lens_type) VALUES ('ld1','{P}','run1','s1','pacing');
             INSERT INTO prose_staging (id, project_id, scene_id, proposed_content, base_version, status, source_surface)
               VALUES ('ps1','{P}','s1','proposal 1',0,'proposed','chat'),('ps2','{P}','s2','proposal 2',0,'proposed','chat');
             INSERT INTO ai_usage (id, project_id, surface, scene_node_id) VALUES ('au1','{P}','chat','s1');
             INSERT INTO lint_action_log (rule_id, action, scene_id, occurred_at) VALUES ('r1','ignore','s1',1);
             INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source) VALUES ('a-node','s1',0,3,'ai');
             INSERT INTO authorship_spans (id, codex_entry_id, from_pos, to_pos, source) VALUES ('a-codex','c1',0,3,'ai');
             INSERT INTO authorship_spans (id, codex_entry_id, phase_id, from_pos, to_pos, source) VALUES ('a-phase','c1','ph1',0,3,'human');
             INSERT INTO authorship_spans (id, detail_value_id, from_pos, to_pos, source) VALUES ('a-dv','dv1',0,3,'human');
             INSERT INTO authorship_spans (id, snippet_id, from_pos, to_pos, source) VALUES ('a-snip','sn1',0,3,'ai');
             INSERT INTO authorship_spans (id, sticky_id, from_pos, to_pos, source) VALUES ('a-sticky','st1',0,3,'unknown');"
        ),
    );
    append_events(db, &[Some("s1"), Some("s2"), None, Some("s1")], "seed");
}

/// Real Change Feed rows (valid hashes) whose `scene_id` the restore must not lose.
fn append_events(db: &Database, scenes: &[Option<&str>], tag: &str) {
    let events: Vec<AppendChangeEvent> = scenes
        .iter()
        .enumerate()
        .map(|(i, scene)| AppendChangeEvent {
            event_uid: format!("uid-{tag}-{i}"),
            scene_id: scene.map(str::to_string),
            domain: "scene".to_string(),
            op_type: "scene.patch".to_string(),
            entity_type: Some("scene".to_string()),
            entity_id: scene.map(str::to_string),
            payload: "{}".to_string(),
            timestamp: 1_700_000_000_000 + i as i64,
        })
        .collect();
    db.with_conn(|conn| {
        append_change_events_in_tx(conn, P, SESSION, &events)?;
        Ok(())
    })
    .expect("append change events");
}

/// What a restore of `scope` must give back, checked on the selected scope's
/// own rows after the change below was made.
fn change_after_snapshot(db: &Database, scope: RestoreScope) {
    match scope {
        RestoreScope::Codex => exec(
            db,
            "UPDATE codex_entries SET summary = 'changed', version = 1 WHERE id = 'c1';
             DELETE FROM authorship_spans WHERE id = 'a-codex';
             INSERT INTO authorship_spans (id, codex_entry_id, from_pos, to_pos, source) VALUES ('a-codex2','c1',5,9,'human');",
        ),
        RestoreScope::Body => exec(
            db,
            "UPDATE tree_nodes SET title = 'changed' WHERE id = 's1';
             UPDATE tree_nodes SET content = '{\"x\":1}' WHERE id = 's2';
             DELETE FROM authorship_spans WHERE id = 'a-node';
             INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source) VALUES ('a-node2','s1',5,9,'human');",
        ),
        RestoreScope::Snippet => exec(
            db,
            "UPDATE snippets SET title = 'changed' WHERE id = 'sn1';
             DELETE FROM authorship_spans WHERE id = 'a-snip';
             INSERT INTO authorship_spans (id, snippet_id, from_pos, to_pos, source) VALUES ('a-snip2','sn1',5,9,'human');",
        ),
        RestoreScope::Map => exec(
            db,
            "UPDATE map_stickies SET title = 'changed' WHERE id = 'st1';
             DELETE FROM authorship_spans WHERE id = 'a-sticky';
             INSERT INTO authorship_spans (id, sticky_id, from_pos, to_pos, source) VALUES ('a-sticky2','st1',5,9,'human');",
        ),
        RestoreScope::Foreshadow => exec(db, "UPDATE foreshadows SET title = 'changed' WHERE id = 'fs1'"),
        RestoreScope::Labels => exec(db, "UPDATE labels SET name = 'changed' WHERE id = 'lab1'"),
        RestoreScope::Lint => exec(
            db,
            "UPDATE lint_term_dictionary SET preferred = 'changed' WHERE id = 'lt1'",
        ),
    }
}

// =====================================================================
// Acceptance tests
// =====================================================================

/// Count of the snapshot's aux rows (`scope`) whose `column` is `value`.
fn aux_refs(scope: &str, column: &str, value: &str) -> String {
    format!(
        "SELECT COUNT(*) FROM project_snapshot_aux a, json_each(a.payload_json, '$.rows') r
          WHERE a.snapshot_id = 'S1' AND a.scope = '{scope}'
            AND json_extract(r.value, '$.{column}') = '{value}'"
    )
}

const MSG: &str = "INSERT INTO chat_messages (id, session_id, role, content) VALUES ('m1', 'probe-session', 'user', 'hi');";

struct Setup<'a> {
    pre_snapshot: &'a str,
    post_snapshot: &'a str,
    /// (what, sql, wanted scalar): the setup must hold or the test is not valid.
    checks: Vec<(&'a str, String, i64)>,
    /// Apply `change_after_snapshot` for each selected scope (a real restore
    /// has something to undo); off for the net no-op cases.
    change: bool,
}

/// Builds the project, takes the snapshot, changes things, deletes the parent
/// (`post_snapshot`) and restores. A restore that fails stops the test.
fn run(label: &str, scopes: &[RestoreScope], setup: Setup<'_>) -> (Database, Restored) {
    let db = new_db();
    seed_rich(&db);
    if !setup.pre_snapshot.is_empty() {
        exec(&db, setup.pre_snapshot);
    }
    snapshot(&db, "S1");
    if setup.change {
        for scope in scopes {
            change_after_snapshot(&db, *scope);
        }
    }
    exec(&db, setup.post_snapshot);
    for (what, sql, want) in &setup.checks {
        assert_eq!(scalar_i64(&db, sql), *want, "{label}: setup: {what}");
    }
    let restored = must(
        try_restore(&db, "r1", "S1", scopes),
        &format!("{label}: restore must succeed"),
    );
    assert_clean(&db, label);
    (db, restored)
}

fn notes(items: &[(&str, i64)]) -> BTreeMap<String, i64> {
    items.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

/// The confirmation (read before) and the result (read after) say the same.
fn assert_notices(label: &str, restored: &Restored, want: &[(&str, i64)]) {
    assert_eq!(
        restored.notices,
        notes(want),
        "{label}: confirmation context"
    );
    assert_eq!(restored.dropped, notes(want), "{label}: restore result");
}

fn ids(db: &Database, sql: &str) -> Vec<String> {
    live_ids(db, sql).into_iter().collect()
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn count(db: &Database, sql: &str) -> i64 {
    scalar_i64(db, sql)
}

#[test]
fn p1_codex_phase_anchor_scene_deleted() {
    let (db, r) = run(
        "P1",
        &[RestoreScope::Codex],
        Setup {
            pre_snapshot: "",
            post_snapshot: "DELETE FROM tree_nodes WHERE id = 's1';",
            checks: vec![
                (
                    "s1 is gone",
                    "SELECT COUNT(*) FROM tree_nodes WHERE id='s1'".into(),
                    0,
                ),
                (
                    "snapshot phase row anchors on s1",
                    aux_refs("codex_entry_phases", "anchor_node_id", "s1"),
                    1,
                ),
            ],
            change: true,
        },
    );
    // The phase is back, without its anchor (the same as when the scene is
    // deleted after the restore).
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM codex_entry_phases WHERE id='ph1' AND anchor_node_id IS NULL AND label='Phase 1'"),
        1
    );
    assert_eq!(
        scalar_text(&db, "SELECT summary FROM codex_entries WHERE id='c1'").as_deref(),
        Some("sum"),
        "the rest of the Codex scope is restored"
    );
    assert_notices("P1", &r, &[("phase_anchor", 1)]);
}

#[test]
fn p2_map_position_snippet_deleted() {
    let (db, r) = run(
        "P2",
        &[RestoreScope::Map],
        Setup {
            pre_snapshot: "",
            post_snapshot: "DELETE FROM snippets WHERE id = 'sn1';",
            checks: vec![
                (
                    "sn1 is gone",
                    "SELECT COUNT(*) FROM snippets WHERE id='sn1'".into(),
                    0,
                ),
                (
                    "snapshot position pos-sn names sn1",
                    aux_refs("map_node_positions", "snippet_id", "sn1"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM map_node_positions"),
        strs(&["pos-c", "pos-s", "pos-st"]),
        "the card of the missing snippet is gone, the others are back"
    );
    assert_eq!(ids(&db, "SELECT id FROM map_edges"), strs(&["edge1"]));
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM map_node_positions WHERE id='pos-s' AND x=1 AND y=1"
        ),
        1
    );
    assert_eq!(
        scalar_text(&db, "SELECT title FROM map_stickies WHERE id='st1'").as_deref(),
        Some("Sticky 1")
    );
    assert_notices("P2", &r, &[("map_placements", 1)]);
}

#[test]
fn p3_map_position_scene_deleted() {
    let (db, r) = run(
        "P3",
        &[RestoreScope::Map],
        Setup {
            pre_snapshot: "",
            post_snapshot: "DELETE FROM tree_nodes WHERE id = 's1';",
            checks: vec![
                (
                    "s1 is gone",
                    "SELECT COUNT(*) FROM tree_nodes WHERE id='s1'".into(),
                    0,
                ),
                (
                    "snapshot position pos-s names s1",
                    aux_refs("map_node_positions", "tree_node_id", "s1"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM map_node_positions"),
        strs(&["pos-c", "pos-sn", "pos-st"])
    );
    // The edge between the dropped card (pos-s) and pos-c goes with it, as
    // the foreign key's CASCADE would have taken it.
    assert_eq!(ids(&db, "SELECT id FROM map_edges"), Vec::<String>::new());
    assert_notices("P3", &r, &[("map_placements", 1), ("map_edges", 1)]);
}

#[test]
fn p4_map_position_codex_deleted() {
    let (db, r) = run(
        "P4",
        &[RestoreScope::Map],
        Setup {
            pre_snapshot: "",
            post_snapshot: "DELETE FROM codex_entries WHERE id = 'c1';",
            checks: vec![
                (
                    "c1 is gone",
                    "SELECT COUNT(*) FROM codex_entries WHERE id='c1'".into(),
                    0,
                ),
                (
                    "snapshot position pos-c names c1",
                    aux_refs("map_node_positions", "codex_entry_id", "c1"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM map_node_positions"),
        strs(&["pos-s", "pos-sn", "pos-st"])
    );
    assert_eq!(ids(&db, "SELECT id FROM map_edges"), Vec::<String>::new());
    assert_notices("P4", &r, &[("map_placements", 1), ("map_edges", 1)]);
}

#[test]
fn p5_map_sticky_source_message_deleted() {
    let pre =
        format!("{MSG} UPDATE map_stickies SET source_chat_message_id = 'm1' WHERE id = 'st1';");
    let (db, r) = run(
        "P5",
        &[RestoreScope::Map],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "DELETE FROM chat_messages WHERE id = 'm1';",
            checks: vec![
                (
                    "m1 is gone",
                    "SELECT COUNT(*) FROM chat_messages WHERE id='m1'".into(),
                    0,
                ),
                (
                    "snapshot sticky st1 names m1",
                    aux_refs("map_stickies", "source_chat_message_id", "m1"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM map_stickies WHERE id='st1' AND source_chat_message_id IS NULL AND title='Sticky 1'"),
        1
    );
    assert_notices("P5", &r, &[("map_source_links", 1)]);
}

#[test]
fn p6_map_ai_branch_session_deleted() {
    let pre = format!(
        "INSERT INTO chat_sessions (id, project_id, title) VALUES ('sess-b', '{P}', 'B');
         INSERT INTO map_ai_branches (id, board_id, prompt, session_id) VALUES ('br1', '{BOARD}', 'p', 'sess-b');"
    );
    let (db, r) = run(
        "P6",
        &[RestoreScope::Map],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "DELETE FROM chat_sessions WHERE id = 'sess-b';",
            checks: vec![
                (
                    "sess-b is gone",
                    "SELECT COUNT(*) FROM chat_sessions WHERE id='sess-b'".into(),
                    0,
                ),
                (
                    "snapshot branch br1 names sess-b",
                    aux_refs("map_ai_branches", "session_id", "sess-b"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM map_ai_branches WHERE id='br1' AND session_id IS NULL AND prompt='p'"),
        1
    );
    assert_notices("P6", &r, &[("map_source_links", 1)]);
}

#[test]
fn p7_snippet_source_message_deleted() {
    let pre = format!("{MSG} UPDATE snippets SET source_chat_message_id = 'm1' WHERE id = 'sn1';");
    let (db, r) = run(
        "P7",
        &[RestoreScope::Snippet],
        Setup {
            pre_snapshot: &pre,
            // Deleting the message sets the snippet's source to NULL by its
            // BEFORE DELETE trigger (DR-SRX-26), as the restore must.
            post_snapshot: "DELETE FROM chat_messages WHERE id = 'm1';",
            checks: vec![
                ("m1 is gone", "SELECT COUNT(*) FROM chat_messages WHERE id='m1'".into(), 0),
                (
                    "the trigger set the live snippet's source to NULL",
                    "SELECT COUNT(*) FROM snippets WHERE id='sn1' AND source_chat_message_id IS NULL".into(),
                    1,
                ),
                (
                    "snapshot snippet sn1 names m1",
                    "SELECT COUNT(*) FROM project_snapshot_snippets
                      WHERE snapshot_id='S1' AND snippet_id='sn1' AND source_chat_message_id='m1'"
                        .into(),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM snippets WHERE id='sn1' AND source_chat_message_id IS NULL AND scene_id='s1' AND title='Snippet 1'"),
        1,
        "the snippet keeps its row and its scene"
    );
    assert_notices("P7", &r, &[("snippet_source_message", 1)]);
}

#[test]
fn p8_body_annotation_run_deleted() {
    let pre = format!(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status)
           VALUES ('run2', '{P}', 'review', 'scene', 's2', 'm', 'v', 'completed');
         INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
           VALUES ('an2', '{P}', 'run2', 'scene_range', 's2', 'review', 'note2');"
    );
    let (db, r) = run(
        "P8",
        &[RestoreScope::Body],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "DELETE FROM post_effect_runs WHERE id = 'run2';",
            checks: vec![
                ("run2 is gone", "SELECT COUNT(*) FROM post_effect_runs WHERE id='run2'".into(), 0),
                (
                    "live an2 survives with run_id NULL",
                    "SELECT COUNT(*) FROM post_effect_annotations WHERE id='an2' AND run_id IS NULL".into(),
                    1,
                ),
                (
                    "snapshot annotation an2 names run2",
                    aux_refs("post_effect_annotations", "run_id", "run2"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM post_effect_annotations ORDER BY id"),
        strs(&["an1", "an2"])
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM post_effect_annotations WHERE id='an2' AND run_id IS NULL AND content='note2'"),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM post_effect_annotations WHERE id='an1' AND run_id='run1'"
        ),
        1,
        "an annotation whose run exists keeps it"
    );
    // The Body change of the setup (scene 2's text) also drops the proposal
    // made for it: an older notice of the restore, not of this rule.
    assert_notices(
        "P8",
        &r,
        &[("ai_scene_proposals", 1), ("analysis_run_links", 1)],
    );
}

#[test]
fn p9_body_relation_to_sceneless_annotation_deleted() {
    let pre = format!(
        "INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
           VALUES ('an-null', '{P}', NULL, 'codex_entry', NULL, 'review', 'no scene');
         INSERT INTO post_effect_annotation_relations (id, project_id, annotation_a_id, annotation_b_id, relation_type)
           VALUES ('rel1', '{P}', 'an1', 'an-null', 'theme_echo');"
    );
    let (db, r) = run(
        "P9",
        &[RestoreScope::Body],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "DELETE FROM post_effect_annotations WHERE id = 'an-null';",
            checks: vec![
                (
                    "an-null is gone",
                    "SELECT COUNT(*) FROM post_effect_annotations WHERE id='an-null'".into(),
                    0,
                ),
                (
                    "snapshot relation rel1 names an-null",
                    aux_refs(
                        "post_effect_annotation_relations",
                        "annotation_b_id",
                        "an-null",
                    ),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM post_effect_annotation_relations"),
        Vec::<String>::new(),
        "the relation to the missing annotation is gone"
    );
    assert_eq!(
        ids(&db, "SELECT id FROM post_effect_annotations"),
        strs(&["an1"])
    );
    assert_notices(
        "P9",
        &r,
        &[("ai_scene_proposals", 1), ("analysis_annotations", 1)],
    );
}

/// A regression pin, not a new behaviour: a Snippet-only restore of a snippet
/// whose scene is gone clears `snippets.scene_id` (the product builder does
/// it, DR-SRX-5) and says nothing.
#[test]
fn p10_snippet_scene_deleted_keeps_working() {
    let (db, r) = run(
        "P10",
        &[RestoreScope::Snippet],
        Setup {
            pre_snapshot: "",
            post_snapshot: "DELETE FROM tree_nodes WHERE id = 's1';",
            checks: vec![
                (
                    "s1 is gone",
                    "SELECT COUNT(*) FROM tree_nodes WHERE id='s1'".into(),
                    0,
                ),
                (
                    "snapshot snippet sn1 names s1",
                    "SELECT COUNT(*) FROM project_snapshot_snippets
                      WHERE snapshot_id='S1' AND snippet_id='sn1' AND scene_id='s1'"
                        .into(),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM snippets WHERE id='sn1' AND scene_id IS NULL AND title='Snippet 1'"),
        1
    );
    assert_notices("P10", &r, &[]);
}

// =====================================================================
// Edges outside the nine (found by deriving the foreign keys)
// =====================================================================

// =====================================================================
// A parent of another project is not a parent of this one (DR-SRX-34)
// =====================================================================

/// A second project, whose rows a row of the first is made to name. Nothing
/// is deleted: the parents all exist, but not in the project that is restored.
const OTHER_PROJECT: &str = "INSERT INTO projects (id, title) VALUES ('probe-p2', 'Two');
 INSERT INTO narrative_semantic_epochs (id, project_id, epoch_number, reason, created_at)
   VALUES ('probe-epoch-2', 'probe-p2', 0, 'initial', '2026-08-23T00:00:00.000Z');
 INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
   VALUES ('x-s1', 'probe-p2', 'scene', 'X scene', '{}', 't', 't', 0);
 INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
   VALUES ('x-c1', 'probe-p2', 'character', 'Other', '[]', 'sum', '{}', NULL, 0, 't', 't');
 INSERT INTO snippets (id, project_id, title, content, scene_id, usage_count, version, created_at, updated_at)
   VALUES ('x-sn1', 'probe-p2', 'X snippet', '{}', NULL, 0, 0, 't', 't');
 INSERT INTO chat_sessions (id, project_id, title) VALUES ('x-sess', 'probe-p2', 'X session');
 INSERT INTO chat_messages (id, session_id, role, content) VALUES ('x-m1', 'x-sess', 'user', 'hi');
 INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status)
   VALUES ('x-run', 'probe-p2', 'review', 'scene', 'x-s1', 'm', 'v', 'completed');
 INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
   VALUES ('x-an', 'probe-p2', NULL, 'codex_entry', NULL, 'review', 'no scene');";

/// A row of the first project that names a row of the second is given back
/// as if that row were gone (`SET NULL` → NULL, `CASCADE` → left out), and
/// counted. This is stricter than the foreign key (which the other project's
/// row satisfies) and is the same as `integrity.rs` calling the reference an
/// orphan; before this rule such a row was restored as it was (DR-SRX-34, 5).
/// A parent is looked up in this project only: each of the live lookups in
/// `restore_missing_parents.rs` is pinned by one of the four tests below.
#[test]
fn cross_project_codex_phase_anchor_counts_as_missing() {
    let pre = format!(
        "{OTHER_PROJECT} UPDATE codex_entry_phases SET anchor_node_id = 'x-s1' WHERE id = 'ph1';"
    );
    let (db, r) = run(
        "X-codex",
        &[RestoreScope::Codex],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "",
            checks: vec![
                (
                    "x-s1 exists, in the other project",
                    "SELECT COUNT(*) FROM tree_nodes WHERE id='x-s1' AND project_id='probe-p2'"
                        .into(),
                    1,
                ),
                (
                    "snapshot phase row anchors on x-s1",
                    aux_refs("codex_entry_phases", "anchor_node_id", "x-s1"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM codex_entry_phases WHERE id='ph1' AND anchor_node_id IS NULL AND label='Phase 1'"),
        1
    );
    assert_notices("X-codex", &r, &[("phase_anchor", 1)]);
}

#[test]
fn cross_project_map_references_count_as_missing() {
    let pre = format!(
        "{OTHER_PROJECT}
         UPDATE map_stickies SET source_chat_message_id = 'x-m1' WHERE id = 'st1';
         INSERT INTO map_ai_branches (id, board_id, prompt, session_id) VALUES ('br-x', '{BOARD}', 'p', 'x-sess');
         INSERT INTO map_node_positions (id, board_id, node_ref_type, tree_node_id, x, y) VALUES ('pos-x-s', '{BOARD}', 'scene', 'x-s1', 5, 5);
         INSERT INTO map_node_positions (id, board_id, node_ref_type, codex_entry_id, x, y) VALUES ('pos-x-c', '{BOARD}', 'codex', 'x-c1', 6, 6);
         INSERT INTO map_node_positions (id, board_id, node_ref_type, snippet_id, x, y) VALUES ('pos-x-sn', '{BOARD}', 'snippet', 'x-sn1', 7, 7);"
    );
    let (db, r) = run(
        "X-map",
        &[RestoreScope::Map],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "",
            checks: vec![
                (
                    "the other project's rows exist",
                    "SELECT (SELECT COUNT(*) FROM tree_nodes WHERE id='x-s1')
                          + (SELECT COUNT(*) FROM codex_entries WHERE id='x-c1')
                          + (SELECT COUNT(*) FROM snippets WHERE id='x-sn1')
                          + (SELECT COUNT(*) FROM chat_sessions WHERE id='x-sess')
                          + (SELECT COUNT(*) FROM chat_messages WHERE id='x-m1')"
                        .into(),
                    5,
                ),
                (
                    "snapshot sticky st1 names x-m1",
                    aux_refs("map_stickies", "source_chat_message_id", "x-m1"),
                    1,
                ),
                (
                    "snapshot branch br-x names x-sess",
                    aux_refs("map_ai_branches", "session_id", "x-sess"),
                    1,
                ),
                (
                    "snapshot position pos-x-s names x-s1",
                    aux_refs("map_node_positions", "tree_node_id", "x-s1"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM map_node_positions WHERE id LIKE 'pos-x-%'"
        ),
        0,
        "the cards that name another project's scene, Codex entry or Snippet are left out"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM map_stickies WHERE id='st1' AND source_chat_message_id IS NULL AND title='Sticky 1'"),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM map_ai_branches WHERE id='br-x' AND session_id IS NULL"
        ),
        1
    );
    assert_notices(
        "X-map",
        &r,
        &[("map_placements", 3), ("map_source_links", 2)],
    );
}

#[test]
fn cross_project_snippet_source_message_counts_as_missing() {
    let pre = format!(
        "{OTHER_PROJECT} UPDATE snippets SET source_chat_message_id = 'x-m1' WHERE id = 'sn1';"
    );
    let (db, r) = run(
        "X-snippet",
        &[RestoreScope::Snippet],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "",
            checks: vec![
                (
                    "x-m1 exists, in the other project",
                    "SELECT COUNT(*) FROM chat_messages WHERE id='x-m1'".into(),
                    1,
                ),
                (
                    "snapshot snippet sn1 names x-m1",
                    "SELECT COUNT(*) FROM project_snapshot_snippets
                      WHERE snapshot_id='S1' AND snippet_id='sn1' AND source_chat_message_id='x-m1'"
                        .into(),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM snippets WHERE id='sn1' AND source_chat_message_id IS NULL AND title='Snippet 1'"),
        1
    );
    assert_notices("X-snippet", &r, &[("snippet_source_message", 1)]);
}

#[test]
fn cross_project_analysis_references_count_as_missing() {
    let pre = format!(
        "{OTHER_PROJECT}
         UPDATE post_effect_annotations SET run_id = 'x-run' WHERE id = 'an1';
         INSERT INTO post_effect_annotation_relations (id, project_id, annotation_a_id, annotation_b_id, relation_type)
           VALUES ('rel-x', '{P}', 'an1', 'x-an', 'theme_echo');"
    );
    let (db, r) = run(
        "X-body",
        &[RestoreScope::Body],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "",
            checks: vec![
                (
                    "x-run and x-an exist, in the other project",
                    "SELECT (SELECT COUNT(*) FROM post_effect_runs WHERE id='x-run' AND project_id='probe-p2')
                          + (SELECT COUNT(*) FROM post_effect_annotations WHERE id='x-an' AND project_id='probe-p2' AND scene_id IS NULL)"
                        .into(),
                    2,
                ),
                (
                    "snapshot annotation an1 names x-run",
                    aux_refs("post_effect_annotations", "run_id", "x-run"),
                    1,
                ),
                (
                    "snapshot relation rel-x names x-an",
                    aux_refs("post_effect_annotation_relations", "annotation_b_id", "x-an"),
                    1,
                ),
            ],
            change: true,
        },
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM post_effect_annotations WHERE id='an1' AND run_id IS NULL"
        ),
        1,
        "the annotation keeps its row, without the other project's run"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM post_effect_annotation_relations WHERE id='rel-x'"
        ),
        0,
        "the relation to the other project's annotation is left out"
    );
    assert_notices(
        "X-body",
        &r,
        &[
            ("ai_scene_proposals", 1),
            ("analysis_run_links", 1),
            ("analysis_annotations", 1),
        ],
    );
}

/// `post_effect_annotation_relations.run_id` is a `SET NULL` edge of its own.
#[test]
fn relation_run_deleted_clears_the_relation_run() {
    let pre = format!(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status)
           VALUES ('run-rel', '{P}', 'review', 'scene', 's2', 'm', 'v', 'completed');
         INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
           VALUES ('an2', '{P}', NULL, 'scene_range', 's2', 'review', 'note2');
         INSERT INTO post_effect_annotation_relations (id, project_id, annotation_a_id, annotation_b_id, relation_type, run_id)
           VALUES ('rel-run', '{P}', 'an1', 'an2', 'theme_echo', 'run-rel');"
    );
    let (db, r) = run(
        "relation.run_id",
        &[RestoreScope::Body],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "DELETE FROM post_effect_runs WHERE id = 'run-rel';",
            checks: vec![(
                "snapshot relation names the run",
                aux_refs("post_effect_annotation_relations", "run_id", "run-rel"),
                1,
            )],
            change: false,
        },
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM post_effect_annotation_relations WHERE id='rel-run' AND run_id IS NULL"),
        1
    );
    assert!(r.notices.contains_key("analysis_run_links"));
    assert_eq!(r.notices, r.dropped);
}

/// An annotation whose scene-less parent is gone is left out with its replies
/// and the relations that name any of them, transitively.
#[test]
fn annotation_parent_chain_is_left_out_transitively() {
    // `an-root` has no scene (the snapshot does not hold it); `an-a` replies to
    // it, `an-b` replies to `an-a`; `rel-a` and `rel-b` name them. The scene of
    // `an-a`/`an-b` is s1, so they are captured. Nothing of the product writes a
    // scene-ful reply to a scene-less parent, hence the plain SQL.
    let pre = format!(
        "INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content, parent_id)
           VALUES ('an-root', '{P}', NULL, 'codex_entry', NULL, 'review', 'root', NULL);
         INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content, parent_id)
           VALUES ('an-a', '{P}', NULL, 'scene_range', 's1', 'review', 'a', 'an-root');
         INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content, parent_id)
           VALUES ('an-b', '{P}', NULL, 'scene_range', 's1', 'review', 'b', 'an-a');
         INSERT INTO post_effect_annotation_relations (id, project_id, annotation_a_id, annotation_b_id, relation_type)
           VALUES ('rel-a', '{P}', 'an1', 'an-a', 'theme_echo'),
                  ('rel-b', '{P}', 'an-b', 'an1', 'theme_echo'),
                  ('rel-ok', '{P}', 'an1', 'an1', 'theme_echo');"
    );
    let (db, r) = run(
        "annotation.parent_id",
        &[RestoreScope::Body],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "DELETE FROM post_effect_annotations WHERE id = 'an-root';",
            checks: vec![
                (
                    "an-root is gone and took its replies",
                    "SELECT COUNT(*) FROM post_effect_annotations WHERE id IN ('an-root','an-a','an-b')".into(),
                    0,
                ),
                (
                    "snapshot reply an-a names an-root",
                    aux_refs("post_effect_annotations", "parent_id", "an-root"),
                    1,
                ),
            ],
            change: false,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM post_effect_annotations"),
        strs(&["an1"])
    );
    assert_eq!(
        ids(&db, "SELECT id FROM post_effect_annotation_relations"),
        strs(&["rel-ok"])
    );
    // an-a and an-b, then rel-a and rel-b: four rows, one kind.
    assert_eq!(r.notices.get("analysis_annotations"), Some(&4));
    assert_eq!(r.notices, r.dropped);
}

/// An annotation without a scene that is still there is a parent that exists:
/// a Body restore does not delete it.
#[test]
fn relation_to_a_live_sceneless_annotation_is_kept() {
    let pre = format!(
        "INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
           VALUES ('an-null', '{P}', NULL, 'codex_entry', NULL, 'review', 'no scene');
         INSERT INTO post_effect_annotation_relations (id, project_id, annotation_a_id, annotation_b_id, relation_type)
           VALUES ('rel1', '{P}', 'an1', 'an-null', 'theme_echo');"
    );
    let (db, r) = run(
        "sceneless survives",
        &[RestoreScope::Body],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "",
            checks: vec![],
            change: true,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM post_effect_annotation_relations"),
        strs(&["rel1"])
    );
    assert!(!r.notices.contains_key("analysis_annotations"));
}

// =====================================================================
// A parent that the restore puts back is not missing
// =====================================================================

#[test]
fn parent_in_the_plan_is_not_dropped() {
    // Body + Map after the scene was deleted: the snapshot has the scene, so
    // the restore puts it back, and the card and its edge stay.
    let (db, r) = run(
        "Body+Map",
        &[RestoreScope::Body, RestoreScope::Map],
        Setup {
            pre_snapshot: "",
            post_snapshot: "DELETE FROM tree_nodes WHERE id = 's1';",
            checks: vec![(
                "s1 is gone",
                "SELECT COUNT(*) FROM tree_nodes WHERE id='s1'".into(),
                0,
            )],
            change: true,
        },
    );
    assert_eq!(
        ids(&db, "SELECT id FROM map_node_positions"),
        strs(&["pos-c", "pos-s", "pos-sn", "pos-st"])
    );
    assert_eq!(ids(&db, "SELECT id FROM map_edges"), strs(&["edge1"]));
    assert!(!r.notices.contains_key("map_placements"));
    assert!(!r.notices.contains_key("map_edges"));

    // Codex + Map after the entry was deleted; Snippet + Map after the snippet.
    for (scope, delete, keep) in [
        (
            RestoreScope::Codex,
            "DELETE FROM codex_entries WHERE id='c1';",
            "pos-c",
        ),
        (
            RestoreScope::Snippet,
            "DELETE FROM snippets WHERE id='sn1';",
            "pos-sn",
        ),
    ] {
        let (db, r) = run(
            "plan parent",
            &[scope, RestoreScope::Map],
            Setup {
                pre_snapshot: "",
                post_snapshot: delete,
                checks: vec![],
                change: true,
            },
        );
        assert_eq!(
            count(
                &db,
                &format!("SELECT COUNT(*) FROM map_node_positions WHERE id='{keep}'")
            ),
            1
        );
        assert!(!r.notices.contains_key("map_placements"));
    }
}

// =====================================================================
// The same as deleting the parent after the restore (the rule itself)
// =====================================================================

/// For each case: restore after the parent is gone (A) and restore first, then
/// delete the parent (B). The child tables must be the same.
#[test]
fn restoring_without_the_parent_equals_deleting_it_afterwards() {
    struct Case {
        label: &'static str,
        scopes: Vec<RestoreScope>,
        pre: String,
        delete: &'static str,
        tables: &'static [&'static str],
    }
    let map_tables: &[&str] = &[
        "map_node_positions",
        "map_edges",
        "map_stickies",
        "map_ai_branches",
        "editor_stickies",
    ];
    let cases = vec![
        Case {
            label: "phase anchor",
            scopes: vec![RestoreScope::Codex],
            pre: String::new(),
            delete: "DELETE FROM tree_nodes WHERE id='s1';",
            tables: &["codex_entry_phases"],
        },
        Case {
            label: "card snippet",
            scopes: vec![RestoreScope::Map],
            pre: String::new(),
            delete: "DELETE FROM snippets WHERE id='sn1';",
            tables: map_tables,
        },
        Case {
            label: "card scene",
            scopes: vec![RestoreScope::Map],
            pre: String::new(),
            delete: "DELETE FROM tree_nodes WHERE id='s1';",
            tables: map_tables,
        },
        Case {
            label: "card codex",
            scopes: vec![RestoreScope::Map],
            pre: String::new(),
            delete: "DELETE FROM codex_entries WHERE id='c1';",
            tables: map_tables,
        },
        Case {
            label: "sticky message",
            scopes: vec![RestoreScope::Map],
            pre: format!("{MSG} UPDATE map_stickies SET source_chat_message_id = 'm1' WHERE id = 'st1';"),
            delete: "DELETE FROM chat_messages WHERE id='m1';",
            tables: map_tables,
        },
        Case {
            label: "branch session",
            scopes: vec![RestoreScope::Map],
            pre: format!(
                "INSERT INTO chat_sessions (id, project_id, title) VALUES ('sess-b', '{P}', 'B');
                 INSERT INTO map_ai_branches (id, board_id, prompt, session_id) VALUES ('br1', '{BOARD}', 'p', 'sess-b');"
            ),
            delete: "DELETE FROM chat_sessions WHERE id='sess-b';",
            tables: map_tables,
        },
        Case {
            label: "snippet message",
            scopes: vec![RestoreScope::Snippet],
            pre: format!("{MSG} UPDATE snippets SET source_chat_message_id = 'm1' WHERE id = 'sn1';"),
            delete: "DELETE FROM chat_messages WHERE id='m1';",
            tables: &["snippets"],
        },
        Case {
            label: "annotation run",
            scopes: vec![RestoreScope::Body],
            pre: format!(
                "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status)
                   VALUES ('run2', '{P}', 'review', 'scene', 's2', 'm', 'v', 'completed');
                 INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
                   VALUES ('an2', '{P}', 'run2', 'scene_range', 's2', 'review', 'note2');"
            ),
            delete: "DELETE FROM post_effect_runs WHERE id='run2';",
            tables: &["post_effect_annotations", "post_effect_annotation_relations"],
        },
        Case {
            label: "relation annotation",
            scopes: vec![RestoreScope::Body],
            pre: format!(
                "INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
                   VALUES ('an-null', '{P}', NULL, 'codex_entry', NULL, 'review', 'no scene');
                 INSERT INTO post_effect_annotation_relations (id, project_id, annotation_a_id, annotation_b_id, relation_type)
                   VALUES ('rel1', '{P}', 'an1', 'an-null', 'theme_echo');"
            ),
            delete: "DELETE FROM post_effect_annotations WHERE id='an-null';",
            tables: &["post_effect_annotations", "post_effect_annotation_relations"],
        },
    ];
    // Rows seeded by SQL default carry the second they were made in.
    let stamp = |row: String| -> String {
        row.split('|')
            .map(|cell| {
                let b = cell.as_bytes();
                let is_stamp = b.len() == 19 && b[4] == b'-' && b[10] == b' ' && b[13] == b':';
                if is_stamp {
                    "<stamp>"
                } else {
                    cell
                }
            })
            .collect::<Vec<_>>()
            .join("|")
    };
    let dump_tables = |db: &Database, tables: &[&str]| -> Vec<(String, Vec<String>)> {
        tables
            .iter()
            .map(|t| {
                (
                    t.to_string(),
                    dump_sql(db, &format!("SELECT * FROM \"{t}\""))
                        .into_iter()
                        .map(stamp)
                        .collect(),
                )
            })
            .collect()
    };
    for case in cases {
        // A: the parent is gone before the restore.
        let a = new_db();
        seed_rich(&a);
        if !case.pre.is_empty() {
            exec(&a, &case.pre);
        }
        snapshot(&a, "S1");
        for scope in &case.scopes {
            change_after_snapshot(&a, *scope);
        }
        exec(&a, case.delete);
        must(
            try_restore(&a, "r1", "S1", &case.scopes),
            &format!("{}: restore without the parent", case.label),
        );
        assert_clean(&a, case.label);
        // B: the parent is there for the restore and goes afterwards.
        let b = new_db();
        seed_rich(&b);
        if !case.pre.is_empty() {
            exec(&b, &case.pre);
        }
        snapshot(&b, "S1");
        for scope in &case.scopes {
            change_after_snapshot(&b, *scope);
        }
        must(
            try_restore(&b, "r1", "S1", &case.scopes),
            &format!("{}: restore with the parent", case.label),
        );
        exec(&b, case.delete);
        assert_eq!(
            dump_tables(&a, case.tables),
            dump_tables(&b, case.tables),
            "{}: restoring without the parent must equal deleting it afterwards",
            case.label
        );
    }
}

// =====================================================================
// Net no-op, trust boundary, replay
// =====================================================================

/// A restore that changes nothing the Change Feed knows about but leaves a
/// snapshot reference out is a no-op that still says so: the "dropped links but
/// changed no Feed object" guard looks only at the links of the other scopes.
#[test]
fn net_no_op_restore_still_reports_what_it_left_out() {
    let pre =
        format!("{MSG} UPDATE map_stickies SET source_chat_message_id = 'm1' WHERE id = 'st1';");
    let (db, r) = run(
        "no-op",
        &[RestoreScope::Map],
        Setup {
            pre_snapshot: &pre,
            post_snapshot: "DELETE FROM chat_messages WHERE id = 'm1';",
            checks: vec![],
            change: false,
        },
    );
    assert!(r.no_op, "the live database already was in that form");
    assert_eq!(r.dropped, notes(&[("map_source_links", 1)]));
    assert_eq!(r.notices, r.dropped);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM map_stickies WHERE id='st1' AND source_chat_message_id IS NULL"
        ),
        1
    );
}

fn p3_setup(db: &Database) {
    exec(db, "DELETE FROM tree_nodes WHERE id = 's1';");
}

fn prepared_p3() -> Database {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    p3_setup(&db);
    db
}

fn apply_plan(
    db: &Database,
    request_id: &str,
    inserts: Vec<SnapshotInsertPlan>,
) -> anyhow::Result<()> {
    apply_project_snapshot_restore(
        db,
        ApplyProjectSnapshotRestorePayload {
            request_id: request_id.to_string(),
            session_id: SESSION.to_string(),
            project_id: P.to_string(),
            snapshot_id: "S1".to_string(),
            scopes: vec![RestoreScope::Map],
            inserts,
        },
    )
    .map(|_| ())
}

/// The renderer does not decide what falls away: a plan it has already
/// reshaped does not match the owned snapshot, and a restore of the full plan
/// still leaves the card out.
#[test]
fn renderer_cannot_pre_shape_the_plan() {
    let db = prepared_p3();
    let full = plan(&db, "S1", &[RestoreScope::Map]);

    // (1) Leaves the card and its edge out itself.
    let shaped: Vec<_> = full
        .iter()
        .filter(|insert| {
            let id = insert.row.get("id").and_then(Value::as_str);
            !matches!(id, Some("pos-s") | Some("edge1"))
        })
        .cloned()
        .collect();
    let error = apply_plan(&db, "shaped", shaped).expect_err("a reshaped plan is refused");
    assert!(
        format!("{error:#}").contains("omits owned snapshot rows"),
        "{error:#}"
    );

    // (2) Clears the reference itself.
    let mut cleared = full.clone();
    for insert in &mut cleared {
        if insert.row.get("id").and_then(Value::as_str) == Some("pos-s") {
            insert.row.insert("tree_node_id".to_string(), Value::Null);
        }
    }
    let error = apply_plan(&db, "cleared", cleared).expect_err("a cleared reference is refused");
    assert!(
        format!("{error:#}").contains("does not match the owned snapshot"),
        "{error:#}"
    );

    // (3) Adds a row of its own.
    let mut extra = full.clone();
    let mut card = extra
        .iter()
        .find(|insert| insert.row.get("id").and_then(Value::as_str) == Some("pos-c"))
        .cloned()
        .expect("pos-c");
    card.row.insert("id".to_string(), json!("pos-extra"));
    extra.push(card);
    let error = apply_plan(&db, "extra", extra).expect_err("an extra row is refused");
    assert!(
        format!("{error:#}").contains("outside the owned snapshot"),
        "{error:#}"
    );

    // Nothing was written by the refusals.
    assert_eq!(count(&db, "SELECT COUNT(*) FROM map_node_positions"), 3);

    // The full plan is accepted, and the card is left out by the restore.
    apply_plan(&db, "full", full).expect("the canonical plan restores");
    assert_clean(&db, "full");
    assert_eq!(
        ids(&db, "SELECT id FROM map_node_positions"),
        strs(&["pos-c", "pos-sn", "pos-st"])
    );
}

/// The same request id returns the stored result, counts included.
#[test]
fn replay_returns_the_same_dropped() {
    let db = prepared_p3();
    let scopes = [RestoreScope::Map];
    let first = apply_project_snapshot_restore(&db, payload(&db, "replay", "S1", &scopes))
        .expect("first restore");
    let again =
        apply_project_snapshot_restore(&db, payload(&db, "replay", "S1", &scopes)).expect("replay");
    assert_eq!(first.dropped, again.dropped);
    assert_eq!(
        notice_map(&serde_json::to_value(&first).unwrap(), "dropped"),
        notes(&[("map_placements", 1), ("map_edges", 1)])
    );
}

/// The order a restore reports in is the fixed order of the kinds, with the new
/// ones before the scene-scope reset.
#[test]
fn new_kinds_come_in_the_fixed_order() {
    let pre = format!(
        "{MSG} UPDATE map_stickies SET source_chat_message_id = 'm1' WHERE id = 'st1';
         UPDATE snippets SET source_chat_message_id = 'm1' WHERE id = 'sn1';"
    );
    let db = new_db();
    seed_rich(&db);
    exec(&db, &pre);
    snapshot(&db, "S1");
    exec(
        &db,
        "DELETE FROM tree_nodes WHERE id = 's1'; DELETE FROM chat_messages WHERE id = 'm1';",
    );
    let scopes = [RestoreScope::Map, RestoreScope::Snippet];
    let context =
        project_snapshot_restore_context(&db, P.to_string(), "S1".to_string(), scopes.to_vec())
            .expect("context");
    let kinds: Vec<String> = context
        .loss_notices
        .iter()
        .map(|n| n.kind.clone())
        .collect();
    let order = [
        "map_placements",
        "map_edges",
        "map_source_links",
        "snippet_source_message",
    ];
    assert_eq!(kinds, order.map(String::from).to_vec());
}

// =====================================================================
// Every scope alone, after each kind of parent was deleted
// =====================================================================

/// Rows that name every kind of parent the restore does not own, so each
/// deletion below leaves something in the snapshot pointing at nothing.
fn pre_for_every_parent() -> String {
    format!(
        "{MSG}
         UPDATE map_stickies SET source_chat_message_id = 'm1' WHERE id = 'st1';
         UPDATE snippets SET source_chat_message_id = 'm1' WHERE id = 'sn1';
         INSERT INTO chat_sessions (id, project_id, title) VALUES ('sess-b', '{P}', 'B');
         INSERT INTO map_ai_branches (id, board_id, prompt, session_id) VALUES ('br1', '{BOARD}', 'p', 'sess-b');
         INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status)
           VALUES ('run2', '{P}', 'review', 'scene', 's2', 'm', 'v', 'completed');
         INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
           VALUES ('an2', '{P}', 'run2', 'scene_range', 's2', 'review', 'note2');
         INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content)
           VALUES ('an-root', '{P}', NULL, 'codex_entry', NULL, 'review', 'root');
         INSERT INTO post_effect_annotations (id, project_id, run_id, anchor_type, scene_id, category, content, parent_id)
           VALUES ('an-reply', '{P}', NULL, 'scene_range', 's1', 'review', 'reply', 'an-root');
         INSERT INTO post_effect_annotation_relations (id, project_id, annotation_a_id, annotation_b_id, relation_type, run_id)
           VALUES ('rel1', '{P}', 'an1', 'an-root', 'theme_echo', 'run2');"
    )
}

const PARENT_DELETIONS: &[(&str, &str)] = &[
    ("scene", "DELETE FROM tree_nodes WHERE id = 's1';"),
    ("codex entry", "DELETE FROM codex_entries WHERE id = 'c1';"),
    ("snippet", "DELETE FROM snippets WHERE id = 'sn1';"),
    ("chat message", "DELETE FROM chat_messages WHERE id = 'm1';"),
    (
        "chat session",
        "DELETE FROM chat_sessions WHERE id = 'sess-b';",
    ),
    (
        "analysis run",
        "DELETE FROM post_effect_runs WHERE id = 'run2';",
    ),
    (
        "annotation without a scene",
        "DELETE FROM post_effect_annotations WHERE id = 'an-root';",
    ),
];

/// The restore of one scope succeeds, leaves the foreign keys clean and nothing
/// parked, whichever parent was deleted after the snapshot, and the
/// confirmation and the result agree.
fn every_parent_deleted(scope: RestoreScope) {
    every_parent_deleted_in(&[scope]);
}

/// The same for several scopes at once: a parent that comes from the plan
/// (a scene, a Codex entry, a Snippet of a selected scope) and one that comes
/// from the live database (a message, a session, a run) are told apart in one
/// restore.
fn every_parent_deleted_in(scopes: &[RestoreScope]) {
    let pre = pre_for_every_parent();
    for (what, delete) in PARENT_DELETIONS {
        let label = format!("{scopes:?} after deleting a {what}");
        let (_, r) = run(
            &label,
            scopes,
            Setup {
                pre_snapshot: &pre,
                post_snapshot: delete,
                checks: vec![],
                change: true,
            },
        );
        assert_eq!(r.notices, r.dropped, "{label}: confirmation vs result");
    }
}

#[test]
fn several_scopes_restore_after_any_parent_was_deleted() {
    every_parent_deleted_in(&[RestoreScope::Body, RestoreScope::Codex, RestoreScope::Map]);
    every_parent_deleted_in(&[RestoreScope::Snippet, RestoreScope::Map]);
    every_parent_deleted_in(&[
        RestoreScope::Body,
        RestoreScope::Codex,
        RestoreScope::Snippet,
        RestoreScope::Map,
        RestoreScope::Foreshadow,
        RestoreScope::Labels,
        RestoreScope::Lint,
    ]);
}

#[test]
fn body_restores_after_any_parent_was_deleted() {
    every_parent_deleted(RestoreScope::Body);
}

#[test]
fn codex_restores_after_any_parent_was_deleted() {
    every_parent_deleted(RestoreScope::Codex);
}

#[test]
fn snippet_restores_after_any_parent_was_deleted() {
    every_parent_deleted(RestoreScope::Snippet);
}

#[test]
fn map_restores_after_any_parent_was_deleted() {
    every_parent_deleted(RestoreScope::Map);
}

#[test]
fn foreshadow_restores_after_any_parent_was_deleted() {
    every_parent_deleted(RestoreScope::Foreshadow);
}

#[test]
fn labels_restore_after_any_parent_was_deleted() {
    every_parent_deleted(RestoreScope::Labels);
}

#[test]
fn lint_restores_after_any_parent_was_deleted() {
    every_parent_deleted(RestoreScope::Lint);
}
