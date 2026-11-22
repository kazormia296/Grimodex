//! Acceptance tests for the cross-scope links a project snapshot restore must
//! keep (DR-SRX-1..14, `docs/plans/nir1-lane-decisions/
//! snapshot-restore-cross-scope-decisions.md`).
//!
//! A restore deletes the selected scope's roots and re-inserts them from the
//! snapshot. The foreign keys' `ON DELETE CASCADE` / `SET NULL` used to take
//! the links of the scopes that were NOT selected with them (an event's
//! participants, a scene's POV character, a snippet's scene, ...). These tests
//! pin that those links survive, that only the links whose target is really
//! gone fall away (and are counted), and what must keep behaving as before.
//!
//! Rows that no product writer creates are inserted with plain SQL; that is
//! stated where it happens (`seed_rich`). Everything that is about the restore
//! itself goes through the real `apply_project_snapshot_restore`.

use std::collections::{BTreeMap, BTreeSet};

use grimodex_db::agent_writes::{
    agent_event_create_with_authority_impl, agent_event_update_with_authority_impl,
    AgentEventCreatePayload, AgentEventUpdatePayload, RendererCanonicalWriteContext,
};
use grimodex_db::change_events::{append_change_events_in_tx, AppendChangeEvent};
use grimodex_db::domain_writes::{
    tree_node_create, tree_node_patch, TreeNodeCreatePayload, TreeNodePatchPayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
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
            plans.push(SnapshotInsertPlan {
                table: table(scope),
                row: row.as_object().cloned().expect("row"),
                mode,
            });
        }
    };
    let core = |plans: &mut Vec<SnapshotInsertPlan>, tbl: &str, sql: &str| {
        for row in json_rows(db, sql, &[snapshot_id, P]) {
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

fn selected_scope_is_back(db: &Database, scope: RestoreScope) {
    let (sql, want) = match scope {
        RestoreScope::Codex => ("SELECT summary FROM codex_entries WHERE id = 'c1'", "sum"),
        RestoreScope::Body => ("SELECT title FROM tree_nodes WHERE id = 's1'", "Scene 1"),
        RestoreScope::Snippet => ("SELECT title FROM snippets WHERE id = 'sn1'", "Snippet 1"),
        RestoreScope::Map => (
            "SELECT title FROM map_stickies WHERE id = 'st1'",
            "Sticky 1",
        ),
        RestoreScope::Foreshadow => (
            "SELECT title FROM foreshadows WHERE id = 'fs1'",
            "Foreshadow 1",
        ),
        RestoreScope::Labels => ("SELECT name FROM labels WHERE id = 'lab1'", "Label"),
        RestoreScope::Lint => (
            "SELECT preferred FROM lint_term_dictionary WHERE id = 'lt1'",
            "p",
        ),
    };
    assert_eq!(
        scalar_text(db, sql).as_deref(),
        Some(want),
        "{scope:?}: the selected scope is back to the snapshot"
    );
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

/// Restore `scopes` after changing each of them and assert that every table
/// the scopes do not own is exactly what it was (rowid included: a row is
/// not rewritten, it is left in place).
fn assert_unselected_scopes_untouched(scopes: &[RestoreScope]) {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    for scope in scopes {
        change_after_snapshot(&db, *scope);
    }
    let before = snapshot_all(&db);
    let max_change_seq = scalar_i64(&db, "SELECT COALESCE(MAX(sequence),0) FROM change_events");
    let change_events_before = dump_sql(
        &db,
        &format!(
            "SELECT rowid, event_uid, scene_id, hash FROM change_events WHERE sequence <= {max_change_seq}"
        ),
    );
    let r = restore(&db, "r1", "S1", scopes);
    assert!(!r.no_op, "{scopes:?}: the change makes the restore real");
    // No link points at a parent that is gone. The one thing a Body restore
    // does let go of is the AI proposal of a scene whose body is not the
    // snapshot's (DR-SRX-8, 確認 114): `change_after_snapshot(Body)` gives s2 a
    // new body, and ps2 is s2's proposal. Nothing else may be reported.
    let body = scopes.contains(&RestoreScope::Body);
    let expected_dropped = if body {
        kinds(&[("ai_scene_proposals", 1)])
    } else {
        BTreeMap::new()
    };
    assert_eq!(
        r.notices, expected_dropped,
        "{scopes:?}: what the confirmation says falls away"
    );
    assert_eq!(
        r.dropped, expected_dropped,
        "{scopes:?}: what the restore says fell away"
    );
    assert_clean(&db, &format!("{scopes:?}"));
    for scope in scopes {
        selected_scope_is_back(&db, *scope);
    }
    let after = snapshot_all(&db);
    for g in groups() {
        let owned = g.owner.is_some_and(|o| scopes.contains(&o));
        if owned {
            continue;
        }
        if body && g.name == "prose_staging" {
            // ps2 (s2's proposal) goes with s2's changed body; ps1 stays
            // exactly as it was, rowid included.
            let without_ps2 = |rows: &[String]| {
                rows.iter()
                    .filter(|row| !row.contains("|ps2|"))
                    .cloned()
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                without_ps2(&before[g.name]),
                after[g.name],
                "{scopes:?}: the proposal of the scene whose body is the snapshot's is untouched"
            );
            assert_eq!(
                after[g.name].len() + 1,
                before[g.name].len(),
                "{scopes:?}: only ps2 went"
            );
            continue;
        }
        assert_eq!(
            before[g.name], after[g.name],
            "{scopes:?}: `{}` belongs to a scope that was not restored and must be untouched",
            g.name
        );
    }
    // Change Feed rows: the restore appends its marker but the scene a row is
    // about is still there, so the column is exactly what it was.
    let change_events_after = dump_sql(
        &db,
        &format!(
            "SELECT rowid, event_uid, scene_id, hash FROM change_events WHERE sequence <= {max_change_seq}"
        ),
    );
    if scopes.contains(&RestoreScope::Body) {
        assert_eq!(
            change_events_before, change_events_after,
            "{scopes:?}: change_events.scene_id is restored for scenes that are still there"
        );
    } else {
        assert_eq!(change_events_before, change_events_after);
    }
}

// ---------------------------------------------------------------------
// Scenarios that must be repaired
// ---------------------------------------------------------------------

#[test]
fn codex_only_restore_keeps_the_links_of_every_other_scope() {
    assert_unselected_scopes_untouched(&[RestoreScope::Codex]);
}

#[test]
fn body_only_restore_keeps_the_links_of_every_other_scope() {
    assert_unselected_scopes_untouched(&[RestoreScope::Body]);
}

#[test]
fn snippet_only_restore_keeps_the_links_of_every_other_scope() {
    assert_unselected_scopes_untouched(&[RestoreScope::Snippet]);
}

#[test]
fn map_only_restore_keeps_the_links_of_every_other_scope() {
    assert_unselected_scopes_untouched(&[RestoreScope::Map]);
}

#[test]
fn body_and_codex_restore_keeps_the_links_of_every_other_scope() {
    assert_unselected_scopes_untouched(&[RestoreScope::Body, RestoreScope::Codex]);
}

// ---------------------------------------------------------------------
// Scenarios that must keep behaving as they did: nothing is parked, nothing
// changes outside the selected scope.
// ---------------------------------------------------------------------

#[test]
fn foreshadow_only_restore_leaves_every_other_scope_untouched() {
    assert_unselected_scopes_untouched(&[RestoreScope::Foreshadow]);
}

#[test]
fn labels_only_restore_leaves_every_other_scope_untouched() {
    assert_unselected_scopes_untouched(&[RestoreScope::Labels]);
}

#[test]
fn lint_only_restore_leaves_every_other_scope_untouched() {
    assert_unselected_scopes_untouched(&[RestoreScope::Lint]);
}

#[test]
fn every_scope_restore_keeps_the_rows_nothing_owns() {
    assert_unselected_scopes_untouched(&ALL_SCOPES);
}

// ---------------------------------------------------------------------
// A link whose target is really gone falls away exactly the way the foreign
// key would, and the confirmation counted it first.
// ---------------------------------------------------------------------

fn kinds(items: &[(&str, i64)]) -> BTreeMap<String, i64> {
    items.iter().map(|(k, n)| (k.to_string(), *n)).collect()
}

/// Run `restore` after `after_snapshot` made things that the snapshot does not
/// know; assert the rows named by `vanished` are the only ones that changed.
fn assert_only_the_gone_links_fall_away(
    scopes: &[RestoreScope],
    after_snapshot: &str,
    vanished: &[&str],
    want: &[(&str, i64)],
) {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    for scope in scopes {
        change_after_snapshot(&db, *scope);
    }
    exec(&db, after_snapshot);
    let before = snapshot_all(&db);
    let r = restore(&db, "r1", "S1", scopes);
    assert!(
        !r.no_op,
        "{scopes:?}: a parent was lost, so this is not a no-op"
    );
    assert_clean(&db, &format!("{scopes:?}"));
    assert_eq!(r.notices, kinds(want), "{scopes:?}: confirmation counts");
    assert_eq!(
        r.dropped, r.notices,
        "{scopes:?}: the result agrees with the count"
    );
    let after = snapshot_all(&db);
    for g in groups() {
        let owned = g.owner.is_some_and(|o| scopes.contains(&o));
        if owned {
            continue;
        }
        assert_eq!(
            after[g.name],
            expected_after(&before[g.name], vanished, g.set_null),
            "{scopes:?}: `{}` loses only what pointed at {vanished:?}",
            g.name
        );
    }
}

#[test]
fn codex_restore_drops_only_the_links_to_entries_it_removes() {
    assert_only_the_gone_links_fall_away(
        &[RestoreScope::Codex],
        &format!(
            "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, version, created_at, updated_at)
               VALUES ('c3','{P}','character','Newcomer','[]','s','{{}}',0,'t','t');
             INSERT INTO codex_tags (id, project_id, name) VALUES ('tag2','{P}','Tag2');
             INSERT INTO codex_entry_phases (id, entry_id, label) VALUES ('ph2','c1','Phase 2');
             INSERT INTO event_participants (event_id, codex_entry_id, role) VALUES ('e1','c3','participant');
             INSERT INTO events (id, project_id, title, ordinal, primary_codex_id) VALUES ('e2','{P}','Event 2','a1','c3');
             UPDATE tree_nodes SET pov_character_id = 'c3' WHERE id = 's2';
             INSERT INTO scene_codex_pins (scene_id, entry_id, created_at) VALUES ('s2','c3','t');
             INSERT INTO scene_codex_mentions (scene_id, codex_entry_id, source) VALUES ('s2','c3','auto');
             INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES ('s2','c3');
             INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id) VALUES ('fs1','c3');
             INSERT INTO snippet_entry_tags (snippet_id, tag_id) VALUES ('sn1','tag2');
             INSERT INTO map_node_positions (id, board_id, node_ref_type, codex_entry_id, x, y) VALUES ('pos-c3','{BOARD}','codex','c3',9,9);
             INSERT INTO editor_stickies (id, project_id, document_key, codex_entry_id) VALUES ('es-c3','{P}','codex: c3','c3');
             INSERT INTO editor_stickies (id, project_id, document_key, codex_entry_id, phase_id) VALUES ('es-ph2','{P}','codex: c1','c1','ph2');
             INSERT INTO chat_session_pinned_codex (id, session_id, codex_entry_id) VALUES ('pin-c3','{SESSION}','c3');
             INSERT INTO trash_items (id, project_id, kind, sub_kind, origin_codex_id, preview_text, payload, char_count, deleted_at)
               VALUES ('tr-c3','{P}','codex','character','c3','p','{{}}',1,'t');
             INSERT INTO impact_review_baselines (entry_id, project_id, snapshot_json, content_hash) VALUES ('c3','{P}','{{}}','h');"
        ),
        &["c3", "tag2", "ph2"],
        &[
            ("event_participants", 1),
            ("event_primary_or_location", 1),
            ("scene_pov_or_location", 1),
            ("scene_codex_links", 2),
            ("foreshadow_codex_links", 1),
            ("snippet_tags", 1),
            ("map_placements", 1),
            ("editor_stickies", 2),
            ("chat_pins_or_anchors", 1),
            ("trash_items", 1),
            ("analysis_records", 1),
        ],
    );
}

#[test]
fn body_restore_drops_only_the_links_to_scenes_it_removes() {
    let db_sql = format!(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
           VALUES ('s3','{P}','scene','Scene 3','{{}}','t','t',0);
         INSERT INTO snippets (id, project_id, title, content, scene_id, usage_count, version, created_at, updated_at)
           VALUES ('sn2','{P}','Snippet 2','{{}}','s3',0,0,'t','t');
         INSERT INTO foreshadows (id, project_id, title, payoff_scene_id, created_at, updated_at) VALUES ('fs2','{P}','Foreshadow 2','s3',1,1);
         INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind, semantic_key, created_at, updated_at)
           VALUES ('su2','fs1','s3',0,1,'plant','k-su2',1,1);
         INSERT INTO foreshadow_payoffs (id, foreshadow_id, scene_id, semantic_key, created_at, updated_at)
           VALUES ('pa2','fs1','s3','k-pa2',1,1);
         INSERT INTO tree_node_labels (node_id, label_id) VALUES ('s3','lab1');
         INSERT INTO codex_entry_phases (id, entry_id, anchor_node_id, label) VALUES ('ph2','c1','s3','Phase 2');
         INSERT INTO lint_ignored_diagnostics (id, rule_id, scene_id, text_snippet, context_before, context_after, created_at)
           VALUES ('li2','r1','s3','t','a','b',1);
         INSERT INTO map_node_positions (id, board_id, node_ref_type, tree_node_id, x, y) VALUES ('pos-s3','{BOARD}','scene','s3',9,9);
         INSERT INTO editor_stickies (id, project_id, document_key, tree_node_id) VALUES ('es-s3','{P}','tree: s3','s3');
         INSERT INTO chat_sessions (id, project_id, title, node_id) VALUES ('cs2','{P}','Second','s3');
         INSERT INTO trash_items (id, project_id, kind, sub_kind, origin_scene_id, preview_text, payload, char_count, deleted_at)
           VALUES ('tr-s3','{P}','scene','scene','s3','p','{{}}',1,'t');
         INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status)
           VALUES ('run2','{P}','review','scene','s3','m','v','completed');
         INSERT INTO scene_lens_data (id, project_id, run_id, target_id, lens_type) VALUES ('ld2','{P}','run1','s3','pacing');
         INSERT INTO prose_staging (id, project_id, scene_id, proposed_content, base_version, status, source_surface)
           VALUES ('ps3','{P}','s3','proposal 3',0,'proposed','chat');
         INSERT INTO ai_usage (id, project_id, surface, scene_node_id) VALUES ('au2','{P}','chat','s3');
         INSERT INTO lint_action_log (rule_id, action, scene_id, occurred_at) VALUES ('r1','ignore','s3',2);"
    );
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Body);
    exec(&db, &db_sql);
    append_events(&db, &[Some("s3"), Some("s1")], "after");
    let before = snapshot_all(&db);
    let events_before = dump_sql(
        &db,
        "SELECT rowid, event_uid, scene_id, hash FROM change_events",
    );
    let r = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert!(!r.no_op);
    assert_clean(&db, "body restore");
    // s3 is the scene that goes away; ps2 belongs to s2, whose body changed.
    let want = kinds(&[
        ("snippet_scene_link", 1),
        ("foreshadow_scene_links", 3),
        ("scene_labels", 1),
        ("phase_anchor", 1),
        ("lint_ignores", 1),
        ("map_placements", 1),
        ("editor_stickies", 1),
        ("chat_pins_or_anchors", 1),
        ("trash_items", 1),
        ("analysis_records", 2),
        ("ai_scene_proposals", 2),
    ]);
    assert_eq!(r.notices, want, "confirmation counts");
    assert_eq!(r.dropped, want, "the result agrees with the count");
    let after = snapshot_all(&db);
    for g in groups() {
        if g.owner == Some(RestoreScope::Body) {
            continue;
        }
        let mut expected = expected_after(&before[g.name], &["s3"], g.set_null);
        if g.name == "prose_staging" {
            // ps2 is dropped on top: s2's body is not what the snapshot has.
            expected.retain(|row| !row.contains("|ps2|"));
        }
        assert_eq!(
            after[g.name], expected,
            "body restore: `{}` loses only what pointed at s3",
            g.name
        );
    }
    // ps1 is on s1, whose body the snapshot has: the proposal survives.
    assert_eq!(
        scalar_i64(&db, "SELECT COUNT(*) FROM prose_staging WHERE id = 'ps1'"),
        1
    );
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT COUNT(*) FROM prose_staging WHERE id IN ('ps2','ps3')"
        ),
        0
    );
    // The scene is gone, so its Change Feed rows have no scene any more (as
    // when a scene is deleted); every other row keeps the scene it had.
    let events_after = dump_sql(
        &db,
        "SELECT rowid, event_uid, scene_id, hash FROM change_events",
    );
    let want_events: Vec<String> = events_before
        .iter()
        .map(|row| row.replace("|s3|", "|∅|"))
        .collect();
    let mut want_events = want_events;
    want_events.sort();
    let events_after: Vec<String> = events_after
        .into_iter()
        .filter(|row| row.contains("uid-seed-") || row.contains("uid-after-"))
        .collect();
    assert_eq!(events_after, {
        let mut w: Vec<String> = want_events
            .into_iter()
            .filter(|row| row.contains("uid-seed-") || row.contains("uid-after-"))
            .collect();
        w.sort();
        w
    });
}

#[test]
fn snippet_restore_drops_only_the_links_to_snippets_it_removes() {
    assert_only_the_gone_links_fall_away(
        &[RestoreScope::Snippet],
        &format!(
            "INSERT INTO snippets (id, project_id, title, content, usage_count, version, created_at, updated_at)
               VALUES ('sn2','{P}','Snippet 2','{{}}',0,0,'t','t');
             INSERT INTO map_node_positions (id, board_id, node_ref_type, snippet_id, x, y) VALUES ('pos-sn2','{BOARD}','snippet','sn2',9,9);
             INSERT INTO editor_stickies (id, project_id, document_key, snippet_id) VALUES ('es-sn2','{P}','snippet: sn2','sn2');
             INSERT INTO chat_session_pinned_codex (id, session_id, snippet_id) VALUES ('pin-sn2','{SESSION}','sn2');
             INSERT INTO chat_sessions (id, project_id, title, snippet_anchor_id) VALUES ('cs2','{P}','Second','sn2');"
        ),
        &["sn2"],
        &[
            ("map_placements", 1),
            ("editor_stickies", 1),
            ("chat_pins_or_anchors", 2),
        ],
    );
}

#[test]
fn map_restore_drops_only_the_links_to_stickies_it_removes() {
    assert_only_the_gone_links_fall_away(
        &[RestoreScope::Map],
        &format!(
            "INSERT INTO map_stickies (id, board_id, title) VALUES ('st2','{BOARD}','Sticky 2');
             INSERT INTO chat_session_pinned_codex (id, session_id, sticky_id) VALUES ('pin-st2','{SESSION}','st2');"
        ),
        &["st2"],
        &[("chat_pins_or_anchors", 1)],
    );
}

// ---------------------------------------------------------------------
// DR-SRX-7 (確認 113): the provenance of a document is part of the scope
// that owns the document
// ---------------------------------------------------------------------

fn authorship_ids(db: &Database, column: &str) -> Vec<String> {
    let mut v: Vec<String> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id FROM authorship_spans WHERE {column} IS NOT NULL ORDER BY id"
            ))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("authorship");
    v.sort();
    v
}

#[test]
fn a_codex_only_restore_puts_the_codex_provenance_back_to_the_snapshot() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Codex);
    let r = restore(&db, "r1", "S1", &[RestoreScope::Codex]);
    assert!(!r.no_op);
    assert_eq!(
        authorship_ids(&db, "codex_entry_id"),
        ["a-codex", "a-phase"]
    );
    assert_eq!(authorship_ids(&db, "detail_value_id"), ["a-dv"]);
    // The other documents' provenance is not the Codex scope's business.
    assert_eq!(authorship_ids(&db, "node_id"), ["a-node"]);
    assert_eq!(authorship_ids(&db, "snippet_id"), ["a-snip"]);
    assert_eq!(authorship_ids(&db, "sticky_id"), ["a-sticky"]);
    assert_clean(&db, "codex provenance");
}

#[test]
fn a_snippet_only_and_a_map_only_restore_put_their_provenance_back() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Snippet);
    change_after_snapshot(&db, RestoreScope::Map);
    restore(&db, "r1", "S1", &[RestoreScope::Snippet]);
    assert_eq!(authorship_ids(&db, "snippet_id"), ["a-snip"]);
    assert_eq!(
        authorship_ids(&db, "sticky_id"),
        ["a-sticky2"],
        "the Map scope was not restored"
    );
    restore(&db, "r2", "S1", &[RestoreScope::Map]);
    assert_eq!(authorship_ids(&db, "sticky_id"), ["a-sticky"]);
    assert_clean(&db, "snippet and map provenance");
}

#[test]
fn a_body_restore_succeeds_when_other_documents_have_provenance() {
    // Before: the snapshot's rows for Codex, Snippet and sticky documents were
    // inserted again next to the live ones -> UNIQUE constraint failed.
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Body);
    let r = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert!(!r.no_op);
    assert_eq!(authorship_ids(&db, "node_id"), ["a-node"]);
    assert_eq!(
        authorship_ids(&db, "codex_entry_id"),
        ["a-codex", "a-phase"]
    );
    assert_eq!(authorship_ids(&db, "snippet_id"), ["a-snip"]);
    assert_eq!(authorship_ids(&db, "sticky_id"), ["a-sticky"]);
    // A Snippet that was deleted after the snapshot does not stop a Body
    // restore either (the snapshot's row for it was inserted and failed
    // with "not scoped to project").
    exec(&db, "DELETE FROM snippets WHERE id = 'sn1'");
    change_after_snapshot(&db, RestoreScope::Body);
    must(
        try_restore(&db, "r2", "S1", &[RestoreScope::Body]),
        "a Body restore with a deleted Snippet",
    );
    assert_clean(&db, "body provenance");
}

#[test]
fn body_and_codex_restore_works_with_snippet_provenance_alive() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Body);
    change_after_snapshot(&db, RestoreScope::Codex);
    restore(&db, "r1", "S1", &[RestoreScope::Body, RestoreScope::Codex]);
    assert_eq!(authorship_ids(&db, "snippet_id"), ["a-snip"]);
    assert_eq!(authorship_ids(&db, "node_id"), ["a-node"]);
    assert_eq!(
        authorship_ids(&db, "codex_entry_id"),
        ["a-codex", "a-phase"]
    );
    assert_clean(&db, "body and codex provenance");
}

// ---------------------------------------------------------------------
// DR-SRX-8 (確認 114): AI records about a scene
// ---------------------------------------------------------------------

#[test]
fn a_body_restore_succeeds_with_scene_analysis_records_and_keeps_them() {
    // Before: post_effect_runs (scope_target_id) and scene_lens_data
    // (target_id) cascade away with the scene while the snapshot's
    // annotations still name the run -> FOREIGN KEY constraint failed.
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Body);
    restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT COUNT(*) FROM post_effect_runs WHERE id = 'run1'"
        ),
        1
    );
    assert_eq!(
        scalar_i64(&db, "SELECT COUNT(*) FROM scene_lens_data WHERE id = 'ld1'"),
        1
    );
    assert_eq!(
        scalar_text(
            &db,
            "SELECT run_id FROM post_effect_annotations WHERE id = 'an1'"
        )
        .as_deref(),
        Some("run1")
    );
    assert_clean(&db, "analysis records");
}

#[test]
fn proposals_survive_only_for_scenes_whose_body_is_the_snapshots() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    // s1 keeps its body, s2 gets another one.
    change_after_snapshot(&db, RestoreScope::Body);
    let r = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert_eq!(
        scalar_i64(&db, "SELECT COUNT(*) FROM prose_staging WHERE id = 'ps1'"),
        1
    );
    assert_eq!(
        scalar_i64(&db, "SELECT COUNT(*) FROM prose_staging WHERE id = 'ps2'"),
        0
    );
    assert_eq!(r.notices, kinds(&[("ai_scene_proposals", 1)]));
    assert_eq!(r.dropped, r.notices);
}

// ---------------------------------------------------------------------
// DR-SRX-5 / 11 (確認 116・117): what stays as it was
// ---------------------------------------------------------------------

fn create_scene(db: &Database, id: &str) {
    must(
        tree_node_create(
            db,
            de::<TreeNodeCreatePayload>(json!({
                "id": id, "projectId": P, "requestId": format!("create-{id}"),
                "sessionId": SESSION, "eventUid": format!("uid-create-{id}"),
                "origin": "human", "parentId": null, "nodeType": "scene",
                "title": "Scene original", "sortOrder": "a0", "synopsis": null,
                "status": null, "sourceUri": null, "sourceMtime": null,
                "content": null
            }))
            .unwrap(),
        ),
        "create scene",
    );
}

fn patch_scene(db: &Database, id: &str, req: &str, title: &str) {
    must(
        tree_node_patch(
            db,
            de::<TreeNodePatchPayload>(json!({
                "projectId": P, "requestId": req, "sessionId": SESSION,
                "eventUid": format!("uid-{req}"), "nodeId": id,
                "patch": { "title": title }, "baseVersion": null, "bumpVersion": false,
                "updatedAt": "2026-08-24T00:00:00.000Z", "changeEvent": null,
                "origin": "human"
            }))
            .unwrap(),
        ),
        "patch scene",
    );
}

#[test]
fn a_body_restore_still_recreates_the_scene_scope_bindings_and_says_so() {
    let db = new_db();
    create_scene(&db, "w1");
    create_scene(&db, "w2");
    snapshot(&db, "S1");
    patch_scene(&db, "w1", "edit-w1", "edited");
    let incarnations_before = dump_sql(
        &db,
        "SELECT rowid, scene_id, scene_incarnation_id FROM narrative_scene_scope_bindings",
    );
    assert_eq!(incarnations_before.len(), 2);
    let r = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    let incarnations_after = dump_sql(
        &db,
        "SELECT rowid, scene_id, scene_incarnation_id FROM narrative_scene_scope_bindings",
    );
    assert_eq!(incarnations_after.len(), 2);
    for (a, b) in incarnations_before.iter().zip(&incarnations_after) {
        let (ida, idb) = (a.split('|').nth(2), b.split('|').nth(2));
        assert_ne!(ida, idb, "a new scene incarnation, as before (確認 117)");
    }
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE compatibility_marker = 'unknown'"
        ),
        2
    );
    assert_eq!(
        r.notices.get("scene_scope_bindings_reset"),
        Some(&2),
        "the bindings that are made again are counted"
    );
    assert_eq!(r.dropped.get("scene_scope_bindings_reset"), Some(&2));
}

#[test]
fn a_restore_still_drops_the_revisions_the_snapshot_does_not_point_at() {
    // 確認 116: the revision history trigger is not touched.
    let db = new_db();
    exec(
        &db,
        &format!(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
               VALUES ('s1','{P}','scene','Scene 1','{{}}','t','t',0);
             INSERT INTO content_versions (id, entity_type, entity_id, content, version_number)
               VALUES ('v1','scene','s1','one',1),('v2','scene','s1','two',2),('v3','scene','s1','three',3);"
        ),
    );
    snapshot(&db, "S1");
    exec(
        &db,
        "UPDATE tree_nodes SET title = 'changed' WHERE id = 's1'",
    );
    restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT COUNT(*) FROM content_versions WHERE entity_id = 's1'"
        ),
        0,
        "the revisions the snapshot does not point at are gone, as before"
    );
}

// ---------------------------------------------------------------------
// DR-SRX-9 (確認 115): the Change Feed rows keep their scene, so their hash
// still matches
// ---------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HashInput<'a> {
    project_id: &'a str,
    scene_id: Option<&'a str>,
    domain: &'a str,
    op_type: &'a str,
    entity_type: Option<&'a str>,
    entity_id: Option<&'a str>,
    payload: &'a str,
    session_id: &'a str,
    sequence: i64,
    timestamp: i64,
    prev_hash: &'a str,
}

/// Recompute every row's hash from its stored columns (what the timelapse
/// verifier does) and return the sequences that do not match.
fn hash_mismatches(db: &Database) -> Vec<i64> {
    use sha2::{Digest, Sha256};
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT scene_id, domain, op_type, entity_type, entity_id, payload,
                    session_id, sequence, timestamp, prev_hash, hash
               FROM change_events WHERE project_id = ?1 ORDER BY sequence",
        )?;
        let rows = stmt
            .query_map([P], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, String>(10)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut bad = Vec::new();
        for (scene, domain, op, et, eid, payload, session, seq, ts, prev, hash) in rows {
            let body = serde_json::to_vec(&HashInput {
                project_id: P,
                scene_id: scene.as_deref(),
                domain: &domain,
                op_type: &op,
                entity_type: et.as_deref(),
                entity_id: eid.as_deref(),
                payload: &payload,
                session_id: &session,
                sequence: seq,
                timestamp: ts,
                prev_hash: &prev,
            })?;
            if hex::encode(Sha256::digest(body)) != hash {
                bad.push(seq);
            }
        }
        Ok(bad)
    })
    .expect("hash chain")
}

#[test]
fn a_body_restore_keeps_the_change_feed_hash_chain_valid_for_scenes_that_stay() {
    let db = new_db();
    create_scene(&db, "w1");
    create_scene(&db, "w2");
    patch_scene(&db, "w1", "edit-w1-a", "a");
    snapshot(&db, "S1");
    create_scene(&db, "w3");
    patch_scene(&db, "w2", "edit-w2", "b");
    let with_scene = scalar_i64(
        &db,
        "SELECT COUNT(*) FROM change_events WHERE scene_id IN ('w1','w2')",
    );
    assert!(
        with_scene >= 3,
        "the writers record the scene: {with_scene}"
    );
    assert_eq!(hash_mismatches(&db), Vec::<i64>::new(), "precondition");
    let ids_before = dump_sql(
        &db,
        "SELECT rowid, event_uid, scene_id FROM change_events WHERE scene_id IN ('w1','w2')",
    );
    restore(&db, "r1", "S1", &[RestoreScope::Body]);
    let ids_after = dump_sql(
        &db,
        "SELECT rowid, event_uid, scene_id FROM change_events WHERE scene_id IN ('w1','w2')",
    );
    assert_eq!(
        ids_before, ids_after,
        "rows of scenes that stay keep scene_id"
    );
    // The only rows that may not match are those about w3 (the scene the
    // restore removed): its rows lose the scene exactly as a normal scene
    // deletion does. Every other row is still valid.
    let bad = hash_mismatches(&db);
    let w3_rows: BTreeSet<i64> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT sequence FROM change_events
                  WHERE scene_id IS NULL AND entity_id = 'w3'",
            )?;
            let rows = stmt
                .query_map([], |r| r.get::<_, i64>(0))?
                .collect::<Result<BTreeSet<_>, _>>()?;
            Ok(rows)
        })
        .expect("w3 rows");
    for seq in &bad {
        assert!(
            w3_rows.contains(seq),
            "sequence {seq} does not match its hash although its scene is still there"
        );
    }
    assert_clean(&db, "hash chain");
}

#[test]
fn a_normal_scene_delete_still_breaks_the_hash_of_that_scenes_rows() {
    // 変えない動き（DR-SRX-13 の 4）: the restore does not repair this one.
    let db = new_db();
    create_scene(&db, "w1");
    assert_eq!(hash_mismatches(&db), Vec::<i64>::new());
    exec(&db, "DELETE FROM tree_nodes WHERE id = 'w1'");
    assert!(
        !hash_mismatches(&db).is_empty(),
        "deleting a scene nulls change_events.scene_id and that is not repaired here"
    );
}

// ---------------------------------------------------------------------
// DR-SRX-14: the PR #1026 hole -- a Codex-only restore that changes nothing
// ---------------------------------------------------------------------

fn human_context(request_id: &str) -> RendererCanonicalWriteContext {
    RendererCanonicalWriteContext {
        request_id: request_id.to_string(),
        event_uid: format!("uid-{request_id}"),
        authority_session_id: None,
        origin: NarrativeChangeOrigin::Human,
        authority_route: "human-direct".to_string(),
        caller: "human-ui".to_string(),
        controls: vec![
            "runtime-policy".to_string(),
            "actor-context".to_string(),
            "typed-writer".to_string(),
            "occ".to_string(),
            "change-event".to_string(),
            "change-feed".to_string(),
        ],
        provenance: None,
        writes_authority_protected_field: false,
        original_transaction_id: None,
        undo_journal_id: None,
        context_mode: None,
        icon: None,
        children_budget: None,
        notes: None,
        canonical_payload: None,
    }
}

fn version(db: &Database, table: &str, id: &str) -> i64 {
    scalar_i64(
        db,
        &format!("SELECT version FROM {table} WHERE id = '{id}'"),
    )
}

#[test]
fn a_codex_restore_that_changes_nothing_leaves_events_and_scenes_writable() {
    let db = new_db();
    // Codex entries made directly keep version 0, so a restore of them is a
    // net no-op (a writer-made entry has version 1 and the restore resets it).
    exec(
        &db,
        &format!(
            "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, version, created_at, updated_at) VALUES
               ('c1','{P}','character','Hero','[]','sum','{{}}',0,'t','t'),
               ('c2','{P}','character','Rival','[]','sum','{{}}',0,'t','t');"
        ),
    );
    create_scene(&db, "w1");
    must(
        agent_event_create_with_authority_impl(
            &db,
            de::<AgentEventCreatePayload>(json!({
                "requestId": "create-e1", "eventId": "e1", "projectId": P,
                "sessionId": SESSION, "surface": "manual", "title": "orig",
                "ordinal": "a0", "kind": "generic", "participantCodexIds": ["c1", "c2"],
                "primaryCodexId": "c1",
            }))
            .unwrap(),
            Some(human_context("create-e1")),
        ),
        "event with participants",
    );
    // The scene's POV goes through the writer too: a raw UPDATE of a column
    // the Change Feed's state digest covers would make the scene differ from
    // its feed head before any restore happens.
    must(
        tree_node_patch(
            &db,
            de::<TreeNodePatchPayload>(json!({
                "projectId": P, "requestId": "pov-w1", "sessionId": SESSION,
                "eventUid": "uid-pov-w1", "nodeId": "w1",
                "patch": { "povCharacterId": "c1" }, "baseVersion": null,
                "bumpVersion": false, "updatedAt": "2026-08-24T00:00:00.000Z",
                "changeEvent": null, "origin": "human"
            }))
            .unwrap(),
        ),
        "scene POV through the writer",
    );
    snapshot(&db, "S1");
    let participants = dump(&db, "event_participants");
    let r = restore(&db, "r1", "S1", &[RestoreScope::Codex]);
    assert!(r.no_op, "nothing the Codex scope owns changed");
    assert_eq!(dump(&db, "event_participants"), participants);
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT COUNT(*) FROM narrative_change_events
              WHERE json_extract(structural_impact_json, '$.event') = 'project-restored'"
        ),
        0,
        "no marker: the exemption cannot be what lets the next write through"
    );
    // The writers go through the Change Feed continuity check.
    let bv = version(&db, "events", "e1");
    must(
        agent_event_update_with_authority_impl(
            &db,
            de::<AgentEventUpdatePayload>(json!({
                "projectId": P, "sessionId": SESSION, "surface": "manual",
                "eventId": "e1", "baseVersion": bv, "title": "after"
            }))
            .unwrap(),
            human_context("post-1"),
        ),
        "event update after a no-op codex restore",
    );
    patch_scene(&db, "w1", "post-scene", "after");
}

// ---------------------------------------------------------------------
// Failure: a restore that fails leaves nothing parked
// ---------------------------------------------------------------------

#[test]
fn a_failed_restore_leaves_no_parked_value_and_a_retry_succeeds() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Codex);
    let before = snapshot_all(&db);
    db.with_conn_mut(|conn| {
        conn.authorizer(Some(|context: AuthContext<'_>| match context.action {
            AuthAction::Insert {
                table_name: "state_snapshots",
                ..
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }))?;
        Ok(())
    })
    .expect("install authorizer");
    let failed = try_restore(&db, "r1", "S1", &[RestoreScope::Codex]);
    db.with_conn_mut(|conn| {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        Ok(())
    })
    .expect("remove authorizer");
    assert!(failed.is_err(), "the denied insert aborts the restore");
    assert_eq!(
        parked_leftovers(&db),
        Vec::<String>::new(),
        "after the failure"
    );
    assert_eq!(before, snapshot_all(&db), "rolled back to the byte");
    // The same request goes through, and keeps the links.
    let r = restore(&db, "r1", "S1", &[RestoreScope::Codex]);
    assert!(!r.no_op);
    assert_clean(&db, "after the retry");
    assert_eq!(
        scalar_i64(&db, "SELECT COUNT(*) FROM event_participants"),
        2,
        "participants survived"
    );
}

// ---------------------------------------------------------------------
// Retry (idempotency): the stored result keeps what was dropped
// ---------------------------------------------------------------------

#[test]
fn an_exact_retry_returns_the_stored_result_with_what_was_dropped() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Body);
    let first = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert_eq!(first.dropped, kinds(&[("ai_scene_proposals", 1)]));
    // The same request again is answered from what the first one stored, even
    // though the state it would count now is different.
    let again = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert_eq!(again.no_op, first.no_op);
    assert_eq!(again.dropped, first.dropped, "the retry reports the same");
    assert_clean(&db, "after the retry");
}

#[test]
fn a_result_stored_before_the_dropped_list_existed_still_reads() {
    let stored = json!({
        "canonicalSequence": 4,
        "changeEventUid": null,
        "maintenanceTransactionId": null,
        "noOp": true
    });
    let result: grimodex_db::project_snapshots::ApplyProjectSnapshotRestoreResult =
        serde_json::from_value(stored).expect("an old stored result reads");
    assert!(notice_map(&serde_json::to_value(&result).unwrap(), "dropped").is_empty());
    assert_eq!(
        serde_json::to_value(&result).unwrap()["dropped"],
        json!([]),
        "and is answered with an empty list"
    );
}

// ---------------------------------------------------------------------
// 確認 122 (DR-SRX-13 の 3): a restore that changes an entry's type
// ---------------------------------------------------------------------

/// OBSERVATION, not a decision. The links come back for "the same id", whatever
/// the entry has become. When the restore changes an entry's type back (here:
/// a character turned into a place and the other way round after the
/// snapshot), the entry stays a scene's POV character, an event's primary
/// character, a participant and a place although it is no longer of that type.
/// Nothing in the Codex restore or the writers checks a type for these columns
/// (the only guard, `NEX_SCENE_SCOPE_CHARACTER_REFERENCED`, is about the Scene
/// Scope bindings' knowledge holders and audiences). Whether to keep that or to
/// drop such links and count them is the user's call (確認 122); this test pins
/// what the implementation does until it is made.
#[test]
fn observation_a_codex_restore_that_changes_a_type_keeps_the_entry_where_it_was() {
    let db = new_db();
    exec(
        &db,
        &format!(
            "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at) VALUES
               ('c1','{P}','location','Town','[]','sum','{{}}',NULL,0,'t','t'),
               ('c2','{P}','character','Hero','[]','sum','{{}}',NULL,0,'t','t');
             INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
               VALUES ('s1','{P}','scene','Scene 1','{{}}','t','t',0);
             INSERT INTO events (id, project_id, title, ordinal) VALUES ('e1','{P}','Event 1','a0');"
        ),
    );
    snapshot(&db, "S1");
    // After the snapshot c1 became a character and c2 a place, and the links
    // were made to match.
    exec(
        &db,
        "UPDATE codex_entries SET type = 'character' WHERE id = 'c1';
         UPDATE codex_entries SET type = 'location' WHERE id = 'c2';
         UPDATE tree_nodes SET pov_character_id = 'c1', location_id = 'c2' WHERE id = 's1';
         UPDATE events SET primary_codex_id = 'c1', location_codex_id = 'c2' WHERE id = 'e1';
         INSERT INTO event_participants (event_id, codex_entry_id, role) VALUES ('e1','c1','participant');",
    );
    let r = restore(&db, "r1", "S1", &[RestoreScope::Codex]);
    assert!(!r.no_op, "the types change back, so the restore is real");
    assert!(
        r.notices.is_empty() && r.dropped.is_empty(),
        "no link is reported"
    );
    let type_of = |sql: &str| scalar_text(&db, sql).expect("type");
    assert_eq!(
        type_of("SELECT type FROM codex_entries WHERE id = 'c1'"),
        "location",
        "the restore put the snapshot's type back"
    );
    // Observed: the links survive although the types no longer fit them.
    assert_eq!(
        type_of(
            "SELECT e.type FROM tree_nodes t JOIN codex_entries e ON e.id = t.pov_character_id WHERE t.id = 's1'"
        ),
        "location",
        "the scene's POV character is now a location"
    );
    assert_eq!(
        type_of(
            "SELECT e.type FROM tree_nodes t JOIN codex_entries e ON e.id = t.location_id WHERE t.id = 's1'"
        ),
        "character",
        "the scene's place is now a character"
    );
    assert_eq!(
        type_of(
            "SELECT e.type FROM events v JOIN codex_entries e ON e.id = v.primary_codex_id WHERE v.id = 'e1'"
        ),
        "location",
        "the event's primary character is now a location"
    );
    assert_eq!(
        type_of(
            "SELECT e.type FROM event_participants p JOIN codex_entries e ON e.id = p.codex_entry_id WHERE p.event_id = 'e1'"
        ),
        "location",
        "the participant is now a location"
    );
    assert_clean(&db, "after the type-changing restore");
}

// ---------------------------------------------------------------------
// A dangling reference the work already had is not the restore's doing
// ---------------------------------------------------------------------

#[test]
fn a_dangling_reference_the_work_already_had_does_not_stop_a_restore() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Body);
    // A work whose old data names a scene that is not there (a database made
    // with foreign keys off). SQLite's own check at commit counts only what a
    // transaction adds, and the restore must be no stricter than that.
    exec(
        &db,
        &format!(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO chat_sessions (id, project_id, title, node_id)
               VALUES ('orphan-chat','{P}','Old','ghost-scene');
             PRAGMA foreign_keys = ON;"
        ),
    );
    assert_eq!(
        foreign_key_violations(&db),
        1,
        "precondition: one old violation"
    );
    let r = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert!(!r.no_op);
    assert_eq!(
        foreign_key_violations(&db),
        1,
        "the restore added no violation of its own"
    );
    assert_eq!(parked_leftovers(&db), Vec::<String>::new());
}

// ---------------------------------------------------------------------
// Found by the review of this change
// ---------------------------------------------------------------------

/// A snapshot made before the Chronicle existed carries none of the event
/// tables, so a Body restore leaves the events alone. The scene links
/// (`scene_events`) cascade from the scenes, which the restore deletes and
/// inserts again, and nothing in the snapshot puts them back: they must be set
/// aside like the other links of a scope that is not restored.
#[test]
fn a_body_restore_of_a_snapshot_made_before_events_keeps_the_scene_event_links() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    exec(
        &db,
        "DELETE FROM project_snapshot_aux
          WHERE snapshot_id = 'S1'
            AND scope IN ('events','scene_events','event_participants','event_relations')",
    );
    change_after_snapshot(&db, RestoreScope::Body);
    let links = dump(&db, "scene_events");
    assert!(
        !links.is_empty(),
        "precondition: a scene is linked to an event"
    );
    let events = dump(&db, "events");
    let participants = dump(&db, "event_participants");
    let r = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert!(!r.no_op);
    assert_eq!(
        links,
        dump(&db, "scene_events"),
        "the links of the scenes that stay"
    );
    assert_eq!(events, dump(&db, "events"), "the events are left alone");
    assert_eq!(participants, dump(&db, "event_participants"));
    // Only the AI proposal of the scene whose body changed goes (DR-SRX-8).
    assert_eq!(r.dropped, kinds(&[("ai_scene_proposals", 1)]));
    assert_clean(&db, "after a Body restore of a snapshot without events");
}

/// A proposal that stays was made against a scene version the restore does
/// not give back; it is aligned with the scene as it is after the restore
/// (same body, so it is valid), instead of being stale now and looking current
/// again when the scene's version reaches the old number with another body.
#[test]
fn a_kept_proposal_is_made_against_the_scene_as_it_is_after_the_restore() {
    let db = new_db();
    seed_rich(&db);
    exec(
        &db,
        "UPDATE tree_nodes SET version = 5 WHERE id = 's1';
         UPDATE prose_staging SET base_version = 5 WHERE id = 'ps1';",
    );
    snapshot(&db, "S1");
    // s1 keeps its body (only its title changes), s2 gets another one.
    change_after_snapshot(&db, RestoreScope::Body);
    restore(&db, "r1", "S1", &[RestoreScope::Body]);
    let version = scalar_i64(&db, "SELECT version FROM tree_nodes WHERE id = 's1'");
    assert_ne!(
        version, 5,
        "premise: the restore does not give the old version back"
    );
    assert_eq!(
        scalar_i64(&db, "SELECT COUNT(*) FROM prose_staging WHERE id = 'ps1'"),
        1,
        "the proposal stayed"
    );
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT base_version FROM prose_staging WHERE id = 'ps1'"
        ),
        version,
        "and is made against the scene as it is now"
    );
}

/// While links are set aside a value in the parking window means "set aside",
/// so an id that starts with the window's root would be taken for a link that
/// did not come back. The restore refuses it before it writes anything.
#[test]
fn an_id_that_starts_with_the_parking_prefix_stops_the_restore_before_it_writes() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    change_after_snapshot(&db, RestoreScope::Body);
    exec(
        &db,
        &format!(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
             VALUES ('{PARK_PREFIX}S1__x','{P}','scene','Odd','{{}}','t','t',0)"
        ),
    );
    let before = snapshot_all(&db);
    let error = try_restore(&db, "r1", "S1", &[RestoreScope::Body])
        .err()
        .expect("the restore is refused");
    assert!(
        format!("{error:#}").contains("reserved"),
        "the reason is the reserved prefix: {error:#}"
    );
    assert_eq!(before, snapshot_all(&db), "nothing was written");
    // (`parked_leftovers` would report the odd id itself.)
    assert_eq!(foreign_key_violations(&db), 0, "after the refused restore");
}
