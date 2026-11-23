//! Guard tests for the ownership check of a project snapshot restore
//! (`docs/plans/nir1-lane-decisions/restore-insert-perf-decisions.md`,
//! DR-RIP-1..9).
//!
//! `apply_project_snapshot_restore` inserts the rows of the snapshot and then
//! checks, for every inserted row, that it sits inside the project's chain of
//! ownership (`ensure_inserted_row_is_project_scoped`). That check is a trust
//! boundary: an aux row of a stored snapshot may name a parent of ANOTHER
//! project, and the foreign keys (which do not know projects) let it through.
//! The plan checks (`ensure_restore_plan_is_snapshot_derived`) compare the
//! renderer's plan with Native's plan built from the same snapshot, so they do
//! not catch it either.
//!
//! These tests pin what the check refuses (which rows, the exact message, the
//! order) and what it lets through, so that the check can be made faster
//! without being weakened. They go through the real
//! `apply_project_snapshot_restore`; a stored snapshot is made hostile by
//! rewriting its `project_snapshot_aux.payload_json`, the way a tampered
//! database file would be. Another project (`probe-p2`) holds a copy of every
//! row of the first one, so that a rewritten parent exists and the foreign
//! keys have nothing to say.

use std::collections::BTreeMap;

use grimodex_db::change_events::{append_change_events_in_tx, AppendChangeEvent};
use grimodex_db::project_snapshots::{
    apply_project_snapshot_restore, create_project_snapshot, project_snapshot_restore_context,
    ApplyProjectSnapshotRestorePayload, CreateProjectSnapshotPayload, RestoreScope,
    SnapshotInsertMode, SnapshotInsertPlan, SnapshotRestoreTable,
};
use grimodex_db::Database;
use serde_json::{json, Value};

const P: &str = "probe-p1";
const FOREIGN: &str = "probe-p2";
const SESSION: &str = "probe-session";
const BOARD: &str = "probe-p1-main-board";
const PARK_PREFIX: &str = "__grimodex_restore_park_";

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
// Row dumps and checks
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

// =====================================================================
// Helpers of this file
// =====================================================================

/// The message of the ownership check, word for word.
fn not_scoped(table: &str) -> String {
    format!("project snapshot insert for '{table}' is not scoped to project '{P}'")
}

/// Every table, row by row (rowid included where the table has one), so that
/// "a refused restore changed nothing" is a statement about the whole database
/// and not about the tables a test happened to think of.
fn dump_all(db: &Database) -> BTreeMap<String, Vec<String>> {
    let tables: Vec<String> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                    AND name NOT LIKE '%\\_fts%' ESCAPE '\\'
                  ORDER BY name",
            )?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(names)
        })
        .expect("tables");
    tables
        .into_iter()
        .map(|name| {
            let with_rowid = format!("SELECT rowid, * FROM \"{name}\"");
            let plain = format!("SELECT * FROM \"{name}\"");
            let rows = if db
                .with_conn(|conn| Ok(conn.prepare(&with_rowid).is_ok()))
                .expect("prepare")
            {
                dump_sql(db, &with_rowid)
            } else {
                dump_sql(db, &plain)
            };
            (name, rows)
        })
        .collect()
}

fn aux_payload(db: &Database, snapshot_id: &str, scope: &str) -> String {
    one_string(
        db,
        "SELECT payload_json FROM project_snapshot_aux WHERE snapshot_id = ?1 AND scope = ?2",
        &[snapshot_id, scope],
    )
    .unwrap_or_else(|| panic!("no aux payload for {scope}"))
}

fn set_aux_payload(db: &Database, snapshot_id: &str, scope: &str, payload_json: &str) {
    let changed = db
        .with_conn(|conn| {
            Ok(conn.execute(
                "UPDATE project_snapshot_aux SET payload_json = ?3
                  WHERE snapshot_id = ?1 AND scope = ?2",
                rusqlite::params![snapshot_id, scope, payload_json],
            )?)
        })
        .expect("update aux payload");
    assert_eq!(changed, 1, "one aux payload per (snapshot, scope)");
}

/// Rewrite `column` of the stored aux rows of `scope` to `to`. `only` limits
/// it to the rows whose `id` is listed, `from` to the rows that hold that value
/// now. Returns what the payload was before, and how many rows changed.
fn rewrite_aux(
    db: &Database,
    snapshot_id: &str,
    scope: &str,
    column: &str,
    from: Option<&str>,
    only: Option<&[String]>,
    to: Value,
) -> (String, usize) {
    let before = aux_payload(db, snapshot_id, scope);
    let mut value: Value = serde_json::from_str(&before).expect("aux payload");
    let mut changed = 0;
    for row in value["rows"].as_array_mut().expect("rows") {
        let id_matches = only.is_none_or(|ids| {
            row.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| ids.iter().any(|wanted| wanted == id))
        });
        let from_matches =
            from.is_none_or(|from| row.get(column).and_then(Value::as_str) == Some(from));
        if id_matches && from_matches {
            row[column] = to.clone();
            changed += 1;
        }
    }
    set_aux_payload(db, snapshot_id, scope, &value.to_string());
    (before, changed)
}

fn apply(
    db: &Database,
    request_id: &str,
    scopes: &[RestoreScope],
) -> anyhow::Result<grimodex_db::project_snapshots::ApplyProjectSnapshotRestoreResult> {
    apply_project_snapshot_restore(db, payload(db, request_id, "S1", scopes))
}

/// The restore must be refused; nothing of the database may have changed, and
/// nothing may stay parked. Returns the message of the root cause.
fn refused(db: &Database, request_id: &str, scopes: &[RestoreScope]) -> String {
    refused_plan(db, payload(db, request_id, "S1", scopes))
}

fn refused_plan(db: &Database, plan_payload: ApplyProjectSnapshotRestorePayload) -> String {
    let before = dump_all(db);
    let error =
        apply_project_snapshot_restore(db, plan_payload).expect_err("the restore must be refused");
    assert_eq!(
        before,
        dump_all(db),
        "a refused restore changes nothing (rolled back to the byte)"
    );
    assert_eq!(
        parked_leftovers(db),
        Vec::<String>::new(),
        "a refused restore leaves nothing parked"
    );
    error.root_cause().to_string()
}

/// `(id, declared type, pk ordinal)` of every column.
fn columns(conn: &rusqlite::Connection, table: &str) -> anyhow::Result<Vec<(String, String, i64)>> {
    let mut st = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every table a restore touches. A copy of each row of `P` is made for
/// `FOREIGN` below.
const COPIED_TABLES: &[&str] = &[
    "codex_types",
    "codex_entries",
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
    "tree_nodes",
    "authorship_spans",
    "generation_logs",
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
    "snippets",
    "snippet_entry_tags",
    "labels",
    "tree_node_labels",
    "foreshadows",
    "foreshadow_setups",
    "foreshadow_payoffs",
    "foreshadow_setup_payoff_links",
    "foreshadow_codex_links",
    "map_boards",
    "map_ai_branches",
    "map_stickies",
    "editor_stickies",
    "map_frames",
    "map_node_positions",
    "map_edges",
    "lint_term_dictionary",
    "lint_ignored_diagnostics",
];

/// The id a row of `P` has in the copy owned by `FOREIGN`.
fn foreign_id(id: &str) -> String {
    format!("x-{id}")
}

/// Another project that holds a copy of every row of `P`: `project_id` is the
/// other project, and every id (and every column that names an id) is
/// `x-<id>`. A parent of `P` rewritten to its copy therefore exists, and the
/// foreign keys are satisfied.
fn copy_project_for_foreign(db: &Database) {
    let counts_before: Vec<i64> = COPIED_TABLES
        .iter()
        .map(|t| scalar_i64(db, &format!("SELECT COUNT(*) FROM \"{t}\"")))
        .collect();
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        conn.execute(
            "INSERT OR IGNORE INTO projects (id, title) VALUES (?1, 'Two')",
            [FOREIGN],
        )?;
        conn.execute_batch("CREATE TEMP TABLE zz_ids (v TEXT PRIMARY KEY);")?;
        for t in COPIED_TABLES {
            let cols = columns(conn, t)?;
            if cols.iter().any(|(n, _, _)| n == "id") {
                conn.execute_batch(&format!(
                    "INSERT OR IGNORE INTO zz_ids SELECT \"id\" FROM \"{t}\" WHERE typeof(\"id\") = 'text';"
                ))?;
            }
        }
        for t in COPIED_TABLES {
            let cols = columns(conn, t)?;
            if cols.is_empty() {
                continue;
            }
            let names = cols
                .iter()
                .map(|(n, _, _)| format!("\"{n}\""))
                .collect::<Vec<_>>()
                .join(", ");
            let exprs = cols
                .iter()
                .map(|(n, ty, _)| {
                    let ty = ty.to_uppercase();
                    if n == "project_id" {
                        format!("'{FOREIGN}'")
                    } else if n == "semantic_key" || n == "incarnation_token" || n == "document_key" {
                        // Columns with a unique index of their own.
                        format!("'x-' || \"{n}\"")
                    } else if ty.contains("CHAR") || ty.contains("TEXT") || ty.is_empty() {
                        format!(
                            "CASE WHEN \"{n}\" IN (SELECT v FROM zz_ids) THEN 'x-' || \"{n}\" ELSE \"{n}\" END"
                        )
                    } else {
                        format!("\"{n}\"")
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            conn.execute_batch(&format!(
                "INSERT OR IGNORE INTO \"{t}\" ({names}) SELECT {exprs} FROM \"{t}\""
            ))?;
        }
        conn.execute_batch("DROP TABLE zz_ids; PRAGMA foreign_keys = ON;")?;
        Ok(())
    })
    .expect("copy the project");
    let mut short = Vec::new();
    for (t, before) in COPIED_TABLES.iter().zip(counts_before) {
        let after = scalar_i64(db, &format!("SELECT COUNT(*) FROM \"{t}\""));
        // A new project is born with its own default Codex types, which are
        // unique per project; the copy of ours finds them taken.
        if after < before * 2 && *t != "codex_types" {
            short.push(format!("{t}: {before} -> {after}"));
        }
    }
    assert_eq!(
        short,
        Vec::<String>::new(),
        "every row has a copy (a copy that an index refused would hide a case)"
    );
    let on = scalar_i64(db, "PRAGMA foreign_keys");
    assert_eq!(on, 1, "foreign keys are enforced again after the copy");
}

/// A project of its own (`P`) plus another that mirrors it (`FOREIGN`).
fn rich_with_foreign() -> Database {
    let db = new_db();
    seed_rich(&db);
    copy_project_for_foreign(&db);
    // The copy must be a faithful one: the foreign key check is clean, and the
    // other project owns what it should.
    let details: Vec<String> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(format!(
                        "{}:{:?}->{}",
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, String>(2)?
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("foreign_key_check");
    assert_eq!(details, Vec::<String>::new(), "the copy is consistent");
    assert_eq!(
        scalar_i64(
            &db,
            &format!("SELECT COUNT(*) FROM map_stickies WHERE id = 'x-st1' AND board_id IN (SELECT id FROM map_boards WHERE project_id = '{FOREIGN}')")
        ),
        1,
        "premise: the other project has its own copy of the sticky"
    );
    db
}

// =====================================================================
// 1. A row whose parent is another project's (or none) is refused
// =====================================================================

/// `(table, the scope that restores it, column naming the parent, the parent's
/// id in `P`, the table of the parent)`. One row per ownership predicate of
/// `AUX_SPECS` that names a parent chain, and for the 12 tables the plan names.
const PARENT_CASES: &[(&str, RestoreScope, &str, &str, &str)] = &[
    (
        "map_stickies",
        RestoreScope::Map,
        "board_id",
        BOARD,
        "map_boards",
    ),
    (
        "map_node_positions",
        RestoreScope::Map,
        "board_id",
        BOARD,
        "map_boards",
    ),
    (
        "map_edges",
        RestoreScope::Map,
        "board_id",
        BOARD,
        "map_boards",
    ),
    (
        "codex_entry_tags",
        RestoreScope::Codex,
        "entry_id",
        "c1",
        "codex_entries",
    ),
    (
        "codex_detail_values",
        RestoreScope::Codex,
        "entry_id",
        "c1",
        "codex_entries",
    ),
    (
        "scene_codex_mentions",
        RestoreScope::Body,
        "scene_id",
        "s1",
        "tree_nodes",
    ),
    (
        "scene_codex_pins",
        RestoreScope::Body,
        "scene_id",
        "s1",
        "tree_nodes",
    ),
    (
        "post_effect_annotations",
        RestoreScope::Body,
        "scene_id",
        "s1",
        "tree_nodes",
    ),
    (
        "scene_events",
        RestoreScope::Body,
        "event_id",
        "e1",
        "events",
    ),
    (
        "event_participants",
        RestoreScope::Body,
        "event_id",
        "e1",
        "events",
    ),
    (
        "foreshadow_setups",
        RestoreScope::Foreshadow,
        "foreshadow_id",
        "fs1",
        "foreshadows",
    ),
    (
        "snippet_entry_tags",
        RestoreScope::Snippet,
        "snippet_id",
        "sn1",
        "snippets",
    ),
    // Beyond the 12: other shapes of the predicate.
    (
        "tree_node_labels",
        RestoreScope::Labels,
        "node_id",
        "s1",
        "tree_nodes",
    ),
    (
        "lint_ignored_diagnostics",
        RestoreScope::Lint,
        "scene_id",
        "s1",
        "tree_nodes",
    ),
    (
        "foreshadow_payoffs",
        RestoreScope::Foreshadow,
        "foreshadow_id",
        "fs1",
        "foreshadows",
    ),
    (
        "codex_entry_phases",
        RestoreScope::Codex,
        "entry_id",
        "c1",
        "codex_entries",
    ),
    // (Not here: `authorship_spans`. Its rows are first reshaped to the
    // documents the restore replaces, so a row that names a document of no
    // project of ours is dropped before it is inserted; and a row of
    // `foreshadow_setup_payoff_links` whose `setup_id` is rewritten is not in
    // the canonical plan either, so the plan check refuses it first.)
];

/// The scopes a restore of `table` is asked for. A table whose rows depend on
/// a document of another scope (a label on a scene, a lint ignore on a scene)
/// is only kept by the plan when that scope is restored too, or the document is
/// still there; the restore that reaches the ownership check is the one that
/// restores both.
fn own_scopes(table: &str, scope: RestoreScope) -> Vec<RestoreScope> {
    match table {
        "tree_node_labels" | "lint_ignored_diagnostics" => vec![scope, RestoreScope::Body],
        _ => vec![scope],
    }
}

/// Set the database up for one case, hostile: the aux rows of `table` of the
/// stored snapshot name `to` instead of `from`. The renderer's plan is made
/// from the same stored rows (it cannot disagree with Native's: both read the
/// snapshot), so only the ownership check is left to refuse it.
fn hostile_db(table: &str, column: &str, from: &str, to: Value) -> Database {
    let db = rich_with_foreign();
    // The other project's own children of `to` would collide on a primary key
    // that contains the column; they play no part in the test.
    if let Some(foreign_parent) = to.as_str().filter(|to| to.starts_with("x-")) {
        exec(
            &db,
            &format!("DELETE FROM \"{table}\" WHERE \"{column}\" = '{foreign_parent}'"),
        );
    }
    snapshot(&db, "S1");
    let (_, changed) = rewrite_aux(&db, "S1", table, column, Some(from), None, to);
    assert!(
        changed > 0,
        "premise: {table}.{column} = {from} has rows to rewrite"
    );
    db
}

/// One database for every case: the snapshot is made once, each case rewrites
/// its stored payload, is refused (and leaves the database as it was), and puts
/// the payload back. At the end the untouched snapshot is restored: the
/// refusals were the ownership check's doing, not something the copy of the
/// other project or the scope choice causes on its own.
///
/// `without_provenance`: the rows of `authorship_spans` (which the restore
/// reshapes and appends at the END of the plan) are removed first, so that the
/// last row of the plan is the last row of the last table of the scope, the
/// one a check that stops one row early would miss.
fn refuse_every_case(
    to_of: &dyn Fn(&str) -> Value,
    premise_parent_exists: bool,
    without_provenance: bool,
) {
    let db = rich_with_foreign();
    if without_provenance {
        exec(&db, "DELETE FROM authorship_spans");
    }
    snapshot(&db, "S1");
    for (table, scope, column, from, parent_table) in PARENT_CASES {
        let to = to_of(from);
        if let Some(parent) = to.as_str().filter(|to| to.starts_with("x-")) {
            if premise_parent_exists {
                assert_eq!(
                    scalar_i64(
                        &db,
                        &format!("SELECT COUNT(*) FROM \"{parent_table}\" WHERE id = '{parent}'")
                    ),
                    1,
                    "premise: {parent} exists in {parent_table}, so no foreign key objects"
                );
            }
            // The other project's own children of that parent would collide on
            // a primary key that holds the column; they play no part here.
            exec(
                &db,
                &format!("DELETE FROM \"{table}\" WHERE \"{column}\" = '{parent}'"),
            );
        }
        let (original, changed) =
            rewrite_aux(&db, "S1", table, column, Some(from), None, to.clone());
        assert!(
            changed > 0,
            "premise: {table}.{column} = {from} has rows to rewrite"
        );
        for scopes in [own_scopes(table, *scope), ALL_SCOPES.to_vec()] {
            let message = refused(&db, "r1", &scopes);
            assert_eq!(
                message,
                not_scoped(table),
                "{table}.{column} -> {to}, scopes {scopes:?}"
            );
        }
        set_aux_payload(&db, "S1", table, &original);
    }
    let result = apply(&db, "r1", &ALL_SCOPES);
    assert!(
        result.is_ok(),
        "control: {:#}",
        result.err().map(|e| format!("{e:#}")).unwrap_or_default()
    );
    assert_clean(&db, "control");
}

#[test]
fn a_row_whose_parent_is_another_projects_is_refused() {
    refuse_every_case(&|from| json!(foreign_id(from)), true, false);
    refuse_every_case(&|from| json!(foreign_id(from)), true, true);
}

#[test]
fn a_row_whose_parent_does_not_exist_is_refused_in_the_same_words() {
    refuse_every_case(&|_| json!("no-such-parent"), false, false);
    refuse_every_case(&|_| json!("no-such-parent"), false, true);
}

// =====================================================================
// 2. Wherever the bad row sits in a long table
// =====================================================================

/// 700 stickies on the main board (and the one the rich seed has: 701).
fn db_with_700_stickies() -> (Database, Vec<String>) {
    let db = new_db();
    seed_rich(&db);
    exec(
        &db,
        &format!(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 699)
             INSERT INTO map_stickies (id, board_id, title)
             SELECT 'st-' || printf('%03d', i), '{BOARD}', 'Sticky ' || i FROM n;"
        ),
    );
    copy_project_for_foreign(&db);
    snapshot(&db, "S1");
    // The restore inserts a table in the order of its primary keys (the
    // canonical plan sorts by the key's JSON text).
    let payload = aux_payload(&db, "S1", "map_stickies");
    let rows: Value = serde_json::from_str(&payload).expect("payload");
    let mut ids: Vec<String> = rows["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["id"].as_str().expect("id").to_string())
        .collect();
    ids.sort_by_key(|id| serde_json::to_string(&[id]).expect("key"));
    assert_eq!(ids.len(), 701, "premise: a table of 701 rows");
    assert_eq!(ids.first().map(String::as_str), Some("st-000"));
    assert_eq!(ids.last().map(String::as_str), Some("st1"));
    (db, ids)
}

#[test]
fn a_bad_row_is_refused_at_the_start_inside_the_edges_and_the_end_of_a_long_table() {
    let (db, ids) = db_with_700_stickies();
    // First, one before and after each multiple of 200 (a chunk edge), the
    // middle of a chunk, and the last row.
    for position in [
        0, 1, 150, 198, 199, 200, 201, 399, 400, 401, 450, 599, 600, 699, 700,
    ] {
        for to in [json!(foreign_id(BOARD)), json!("no-such-board")] {
            let only = [ids[position].clone()];
            let (original, changed) = rewrite_aux(
                &db,
                "S1",
                "map_stickies",
                "board_id",
                None,
                Some(&only),
                to.clone(),
            );
            assert_eq!(changed, 1);
            let message = refused(&db, "r1", &[RestoreScope::Map]);
            assert_eq!(
                message,
                not_scoped("map_stickies"),
                "bad row at position {position} ({}) -> {to}",
                ids[position]
            );
            set_aux_payload(&db, "S1", "map_stickies", &original);
        }
    }
    // Control: with every row sound, the restore goes through.
    let result = apply(&db, "r1", &[RestoreScope::Map]);
    assert!(
        result.is_ok(),
        "{:#}",
        result.err().map(|e| format!("{e:#}")).unwrap_or_default()
    );
    assert_clean(&db, "after the control restore");
    assert_eq!(
        scalar_i64(
            &db,
            &format!("SELECT COUNT(*) FROM map_stickies WHERE board_id = '{BOARD}'")
        ),
        701
    );
}

#[test]
fn several_bad_rows_in_a_long_table_are_refused() {
    let (db, ids) = db_with_700_stickies();
    for positions in [
        vec![150, 450],
        vec![399, 400, 401],
        vec![0, 700],
        vec![650, 5],
        vec![199, 200],
        (0..701).collect::<Vec<_>>(),
    ] {
        let only: Vec<String> = positions.iter().map(|p| ids[*p].clone()).collect();
        let (original, changed) = rewrite_aux(
            &db,
            "S1",
            "map_stickies",
            "board_id",
            None,
            Some(&only),
            json!(foreign_id(BOARD)),
        );
        assert_eq!(changed, only.len());
        let message = refused(&db, "r1", &[RestoreScope::Map]);
        assert_eq!(
            message,
            not_scoped("map_stickies"),
            "bad rows at {:?}",
            &positions[..positions.len().min(8)]
        );
        set_aux_payload(&db, "S1", "map_stickies", &original);
    }
}

#[test]
fn a_bad_row_in_a_composite_key_table_is_refused_wherever_it_sits() {
    // scene_codex_mentions: primary key (scene_id, codex_entry_id), 700 rows.
    let db = new_db();
    seed_rich(&db);
    exec(
        &db,
        &format!(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 69)
             INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
             SELECT 'm-s-' || printf('%02d', i), '{P}', 'scene', 'M ' || i, '{{}}', 't', 't', 0 FROM n;
             WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9)
             INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
             SELECT 'm-c-' || i, '{P}', 'character', 'M' || i, '[]', 's', '{{}}', NULL, 0, 't', 't' FROM n;
             INSERT INTO scene_codex_mentions (scene_id, codex_entry_id, source)
             SELECT s.id, c.id, 'auto' FROM tree_nodes s, codex_entries c
              WHERE s.id LIKE 'm-s-%' AND c.id LIKE 'm-c-%';"
        ),
    );
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT COUNT(*) FROM scene_codex_mentions WHERE scene_id LIKE 'm-s-%'"
        ),
        700
    );
    copy_project_for_foreign(&db);
    snapshot(&db, "S1");
    let payload = aux_payload(&db, "S1", "scene_codex_mentions");
    let rows: Value = serde_json::from_str(&payload).expect("payload");
    let mut keys: Vec<(String, String)> = rows["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| {
            (
                row["scene_id"].as_str().expect("scene").to_string(),
                row["codex_entry_id"].as_str().expect("codex").to_string(),
            )
        })
        .collect();
    keys.sort_by_key(|(scene, codex)| serde_json::to_string(&[scene, codex]).expect("key"));
    let n = keys.len();
    assert!(n >= 701, "premise: more than 700 mention rows ({n})");
    for position in [0, 199, 200, 399, 400, n - 1] {
        let (scene, codex) = keys[position].clone();
        let before = aux_payload(&db, "S1", "scene_codex_mentions");
        let mut value: Value = serde_json::from_str(&before).expect("payload");
        let mut changed = 0;
        for row in value["rows"].as_array_mut().expect("rows") {
            if row["scene_id"] == json!(scene) && row["codex_entry_id"] == json!(codex) {
                row["scene_id"] = json!("x-s1");
                changed += 1;
            }
        }
        assert_eq!(changed, 1);
        set_aux_payload(&db, "S1", "scene_codex_mentions", &value.to_string());
        // x-s1 owns the copy of (s1, c2): the rewritten row of s1 would collide
        // on its key; make room.
        exec(
            &db,
            "DELETE FROM scene_codex_mentions WHERE scene_id = 'x-s1'",
        );
        let message = refused(&db, "r1", &[RestoreScope::Body]);
        assert_eq!(
            message,
            not_scoped("scene_codex_mentions"),
            "bad mention at position {position} of {n}: ({scene}, {codex})"
        );
        set_aux_payload(&db, "S1", "scene_codex_mentions", &before);
    }
}

// =====================================================================
// 2b. Two bad tables: the first in plan order names itself
// =====================================================================

#[test]
fn when_two_tables_are_bad_the_first_in_plan_order_is_named() {
    // Each pair is listed in the order the restore inserts them (Codex, then
    // Body, Snippet, Labels, Foreshadow, Map, Lint; inside a scope as the
    // canonical plan lists the tables). Alphabetical order differs from this
    // for several pairs, so that a check that walks the tables in another
    // order is noticed.
    type ParentCase = (&'static str, &'static str, &'static str);
    let pairs: &[(ParentCase, ParentCase)] = &[
        (
            ("map_stickies", "board_id", BOARD),
            ("map_edges", "board_id", BOARD),
        ),
        (
            ("map_node_positions", "board_id", BOARD),
            ("map_edges", "board_id", BOARD),
        ),
        (
            ("codex_entry_tags", "entry_id", "c1"),
            ("scene_codex_mentions", "scene_id", "s1"),
        ),
        (
            ("scene_codex_pins", "scene_id", "s1"),
            ("scene_codex_mentions", "scene_id", "s1"),
        ),
        (
            ("post_effect_annotations", "scene_id", "s1"),
            ("scene_events", "event_id", "e1"),
        ),
        (
            ("snippet_entry_tags", "snippet_id", "sn1"),
            ("foreshadow_setups", "foreshadow_id", "fs1"),
        ),
        (
            ("tree_node_labels", "node_id", "s1"),
            ("map_stickies", "board_id", BOARD),
        ),
        (
            ("foreshadow_setups", "foreshadow_id", "fs1"),
            ("map_stickies", "board_id", BOARD),
        ),
        (
            ("map_stickies", "board_id", BOARD),
            ("lint_ignored_diagnostics", "scene_id", "s1"),
        ),
        (
            ("event_participants", "event_id", "e1"),
            ("snippet_entry_tags", "snippet_id", "sn1"),
        ),
    ];
    for ((first_table, first_column, first_from), (second_table, second_column, second_from)) in
        pairs
    {
        for flip in [false, true] {
            // Hostile in both tables; whichever order the tampering is made.
            let db = rich_with_foreign();
            for (table, column, from) in [
                (first_table, first_column, first_from),
                (second_table, second_column, second_from),
            ] {
                exec(
                    &db,
                    &format!(
                        "DELETE FROM \"{table}\" WHERE \"{column}\" = '{}'",
                        foreign_id(from)
                    ),
                );
            }
            snapshot(&db, "S1");
            let order = if flip {
                [
                    (second_table, second_column, second_from),
                    (first_table, first_column, first_from),
                ]
            } else {
                [
                    (first_table, first_column, first_from),
                    (second_table, second_column, second_from),
                ]
            };
            for (table, column, from) in order {
                let (_, changed) = rewrite_aux(
                    &db,
                    "S1",
                    table,
                    column,
                    Some(from),
                    None,
                    json!(foreign_id(from)),
                );
                assert!(changed > 0, "premise: {table}");
            }
            let message = refused(&db, "r1", &ALL_SCOPES);
            assert_eq!(
                message,
                not_scoped(first_table),
                "{first_table} comes before {second_table} (tampered in {} order)",
                if flip { "reverse" } else { "plan" }
            );
        }
    }
}

// =====================================================================
// 3. What goes through
// =====================================================================

/// Tables whose restored rows are exactly what was snapshotted (no regenerated
/// token or timestamp), compared without rowid.
const STABLE_TABLES: &[&str] = &[
    "codex_tags",
    "codex_entry_tags",
    "codex_detail_values",
    "codex_entry_phases",
    "event_participants",
    "snippet_entry_tags",
    "labels",
    "tree_node_labels",
    "foreshadows",
    "foreshadow_setups",
    "foreshadow_payoffs",
    "foreshadow_setup_payoff_links",
    "foreshadow_codex_links",
    "map_stickies",
    "map_node_positions",
    "map_edges",
    "editor_stickies",
    "scene_codex_pins",
    "scene_codex_mentions",
    "post_effect_annotations",
    "lint_term_dictionary",
    "lint_ignored_diagnostics",
];

fn stable_rows(db: &Database) -> BTreeMap<&'static str, Vec<String>> {
    STABLE_TABLES
        .iter()
        .map(|t| (*t, dump_sql(db, &format!("SELECT * FROM \"{t}\""))))
        .collect()
}

#[test]
fn a_restore_of_every_scope_goes_through_and_puts_every_aux_row_back() {
    let db = new_db();
    seed_rich(&db);
    copy_project_for_foreign(&db);
    snapshot(&db, "S1");
    let at_snapshot = stable_rows(&db);
    for scope in ALL_SCOPES {
        change_after_snapshot(&db, scope);
    }
    exec(
        &db,
        "DELETE FROM scene_codex_mentions WHERE scene_id = 's1';
         DELETE FROM map_edges WHERE id = 'edge1';
         DELETE FROM codex_entry_tags WHERE entry_id = 'c1';
         DELETE FROM event_participants WHERE event_id = 'e1';",
    );
    assert_ne!(at_snapshot, stable_rows(&db), "premise: the work moved on");
    let foreign_before = dump_sql(
        &db,
        &format!("SELECT * FROM map_stickies WHERE board_id IN (SELECT id FROM map_boards WHERE project_id = '{FOREIGN}')"),
    );
    let r = restore(&db, "r1", "S1", &ALL_SCOPES);
    assert!(!r.no_op, "the changes make the restore real");
    assert_eq!(
        r.notices, r.dropped,
        "what the confirmation said would fall away is what fell away"
    );
    assert_clean(&db, "after the every-scope restore");
    for scope in ALL_SCOPES {
        selected_scope_is_back(&db, scope);
    }
    assert_eq!(
        at_snapshot,
        stable_rows(&db),
        "every aux row is back as it was"
    );
    // The other project's copy is exactly what it was.
    assert_eq!(
        foreign_before,
        dump_sql(
            &db,
            &format!("SELECT * FROM map_stickies WHERE board_id IN (SELECT id FROM map_boards WHERE project_id = '{FOREIGN}')")
        )
    );
}

#[test]
fn a_restore_of_each_single_scope_goes_through() {
    for scope in ALL_SCOPES {
        let db = new_db();
        seed_rich(&db);
        copy_project_for_foreign(&db);
        snapshot(&db, "S1");
        change_after_snapshot(&db, scope);
        let r = restore(&db, "r1", "S1", &[scope]);
        assert!(!r.no_op, "{scope:?}");
        assert_clean(&db, &format!("{scope:?}"));
        selected_scope_is_back(&db, scope);
    }
}

#[test]
fn a_table_longer_than_one_chunk_is_restored() {
    // 701 stickies (a table longer than 200 rows), and 700 mentions with a
    // composite key, restored together after the work lost half of them.
    let (db, _ids) = db_with_700_stickies();
    exec(
        &db,
        &format!(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 69)
             INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
             SELECT 'm-s-' || printf('%02d', i), '{P}', 'scene', 'M ' || i, '{{}}', 't', 't', 0 FROM n;"
        ),
    );
    // (The snapshot above was taken before these scenes; take a new one.)
    exec(
        &db,
        &format!(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9)
             INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
             SELECT 'm-c-' || i, '{P}', 'character', 'M' || i, '[]', 's', '{{}}', NULL, 0, 't', 't' FROM n;
             INSERT INTO scene_codex_mentions (scene_id, codex_entry_id, source)
             SELECT s.id, c.id, 'auto' FROM tree_nodes s, codex_entries c
              WHERE s.id LIKE 'm-s-%' AND c.id LIKE 'm-c-%';"
        ),
    );
    snapshot(&db, "S2");
    let stickies_at_snapshot = dump_sql(&db, "SELECT * FROM map_stickies");
    let mentions_at_snapshot = dump_sql(&db, "SELECT * FROM scene_codex_mentions");
    assert!(stickies_at_snapshot.len() > 700);
    assert!(mentions_at_snapshot.len() > 700);
    exec(
        &db,
        "DELETE FROM map_stickies WHERE id LIKE 'st-3%' OR id LIKE 'st-4%' OR id LIKE 'st-6%';
         DELETE FROM scene_codex_mentions WHERE scene_id LIKE 'm-s-3%' OR scene_id LIKE 'm-s-5%';
         UPDATE map_stickies SET title = 'changed' WHERE id = 'st-000';",
    );
    let r = must(
        apply_project_snapshot_restore(
            &db,
            payload(&db, "r2", "S2", &[RestoreScope::Map, RestoreScope::Body]),
        ),
        "the long tables are restored",
    );
    assert!(!r.no_op);
    assert_clean(&db, "after restoring long tables");
    assert_eq!(
        stickies_at_snapshot,
        dump_sql(&db, "SELECT * FROM map_stickies")
    );
    assert_eq!(
        mentions_at_snapshot,
        dump_sql(&db, "SELECT * FROM scene_codex_mentions")
    );
}

#[test]
fn composite_key_rows_are_restored_and_their_ownership_column_is_checked() {
    let db = new_db();
    seed_rich(&db);
    copy_project_for_foreign(&db);
    snapshot(&db, "S1");
    exec(
        &db,
        "DELETE FROM scene_codex_mentions WHERE scene_id = 's1';
         DELETE FROM tree_node_labels WHERE node_id = 's1';",
    );
    restore(&db, "r1", "S1", &[RestoreScope::Body, RestoreScope::Labels]);
    assert_eq!(
        dump_sql(
            &db,
            "SELECT * FROM scene_codex_mentions WHERE scene_id = 's1'"
        )
        .len(),
        1,
        "the composite-key mention is back"
    );
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT COUNT(*) FROM tree_node_labels WHERE node_id = 's1' AND label_id = 'lab1'"
        ),
        1,
        "the composite-key label is back"
    );
    // The ownership column of each is what the check looks at.
    for (table, scope, column, from) in [
        ("scene_codex_mentions", RestoreScope::Body, "scene_id", "s1"),
        ("tree_node_labels", RestoreScope::Labels, "node_id", "s1"),
    ] {
        let db = hostile_db(table, column, from, json!(foreign_id(from)));
        assert_eq!(
            refused(&db, "r1", &own_scopes(table, scope)),
            not_scoped(table),
            "{table}"
        );
    }
}

/// The restore that keeps a row whose second parent is in another scope: that
/// scope is restored too (otherwise the plan drops the row, and the plan check
/// refuses a plan that still carries it).
fn second_parent_scopes(table: &str, scope: RestoreScope) -> Vec<RestoreScope> {
    match table {
        "tree_node_labels" => vec![scope, RestoreScope::Body],
        _ => vec![scope, RestoreScope::Codex],
    }
}

/// KNOWN GAP, pinned as it is today (DR-RIP-8; the user decided in 確認 134
/// N4 not to close it in this change). The ownership predicate of a
/// composite-key table looks at ONE parent column. A row whose OTHER parent
/// column names another project's row is let through. A change that makes this
/// refuse is a change of what the restore refuses: it has to be made on
/// purpose, with the decision record, and this test updated with it.
#[test]
fn known_gap_a_composite_key_rows_second_parent_is_not_ownership_checked() {
    // (table, scope, the column that is NOT the ownership column, its value
    // in P, the table it points to, the ownership column, its value)
    for (table, scope, column, from, parent, owner_column, owner) in [
        (
            "scene_codex_mentions",
            RestoreScope::Body,
            "codex_entry_id",
            "c2",
            "codex_entries",
            "scene_id",
            "s1",
        ),
        (
            "tree_node_labels",
            RestoreScope::Labels,
            "label_id",
            "lab1",
            "labels",
            "node_id",
            "s1",
        ),
        (
            "event_participants",
            RestoreScope::Body,
            "codex_entry_id",
            "c1",
            "codex_entries",
            "event_id",
            "e1",
        ),
        (
            "scene_codex_pins",
            RestoreScope::Body,
            "entry_id",
            "c1",
            "codex_entries",
            "scene_id",
            "s1",
        ),
    ] {
        let to = foreign_id(from);
        let db = hostile_db(table, column, from, json!(to));
        assert_eq!(
            scalar_i64(
                &db,
                &format!("SELECT COUNT(*) FROM \"{parent}\" WHERE id = '{to}' AND project_id = '{FOREIGN}'")
            ),
            1,
            "premise: {to} is another project's"
        );
        let result = apply(&db, "r1", &second_parent_scopes(table, scope));
        assert!(
            result.is_ok(),
            "{table}.{column} -> another project's row is let through today: {:#}",
            result.err().map(|e| format!("{e:#}")).unwrap_or_default()
        );
        assert_eq!(
            scalar_i64(
                &db,
                &format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\" = '{to}' AND \"{owner_column}\" = '{owner}'")
            ),
            1,
            "{table}: the row holds the foreign parent after the restore"
        );
    }
}

/// The same column naming nothing at all is not the ownership check's: the
/// deferred foreign key stops it when the transaction would commit.
#[test]
fn a_composite_key_rows_second_parent_that_does_not_exist_stops_at_the_foreign_key() {
    let db = hostile_db(
        "scene_codex_mentions",
        "codex_entry_id",
        "c2",
        json!("no-such-entry"),
    );
    let message = refused(&db, "r1", &[RestoreScope::Body, RestoreScope::Codex]);
    assert!(
        message.contains("constraint failed") && !message.contains("not scoped"),
        "{message}"
    );
}

#[test]
fn a_table_that_does_not_exist_is_skipped() {
    // Older databases may lack a table. The snapshot then has no rows for it
    // and the restore has nothing to insert there.
    let db = new_db();
    seed_rich(&db);
    exec(&db, "DROP TABLE lint_term_dictionary");
    snapshot(&db, "S1");
    exec(
        &db,
        "UPDATE lint_ignored_diagnostics SET rule_id = 'changed' WHERE id = 'li1'",
    );
    let result = apply(&db, "r1", &[RestoreScope::Lint]);
    assert!(
        result.is_ok(),
        "{:#}",
        result.err().map(|e| format!("{e:#}")).unwrap_or_default()
    );
    assert_eq!(
        one_string(
            &db,
            "SELECT rule_id FROM lint_ignored_diagnostics WHERE id = 'li1'",
            &[]
        )
        .as_deref(),
        Some("r1"),
        "the tables that exist are restored"
    );
}

#[test]
fn a_plan_row_for_a_table_that_does_not_exist_is_refused() {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    // The table is gone after the snapshot; the renderer still sends its row.
    exec(&db, "DROP TABLE lint_term_dictionary");
    let message = refused(&db, "r1", &[RestoreScope::Lint]);
    assert_eq!(
        message,
        "project snapshot restore plan contains unavailable table 'lint_term_dictionary'"
    );
}

#[test]
fn a_table_without_a_primary_key_is_refused() {
    let db = new_db();
    seed_rich(&db);
    exec(
        &db,
        "DROP TABLE lint_term_dictionary;
         CREATE TABLE lint_term_dictionary (
             id TEXT NOT NULL, project_id TEXT NOT NULL, preferred TEXT NOT NULL,
             variants TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    );
    exec(
        &db,
        &format!(
            "INSERT INTO lint_term_dictionary (id, project_id, preferred, variants, created_at, updated_at)
             VALUES ('lt1', '{P}', 'p', 'v', 1, 1)"
        ),
    );
    snapshot(&db, "S1");
    let message = refused(&db, "r1", &[RestoreScope::Lint]);
    assert_eq!(
        message,
        "project snapshot restore table 'lint_term_dictionary' has no primary key"
    );
}

#[test]
fn a_table_the_restore_does_not_know_is_not_a_restore_table() {
    // A table with no ownership rule cannot be named: the names are a closed
    // set, so a plan cannot reach a table `AUX_SPECS` (and the core tables)
    // do not own.
    for name in [
        "chat_sessions",
        "trash_items",
        "project_snapshots",
        "no_such_table",
        "",
    ] {
        assert!(
            serde_json::from_value::<SnapshotRestoreTable>(Value::String(name.to_string()))
                .is_err(),
            "'{name}' is not a restore table"
        );
    }
    for name in ["map_stickies", "tree_nodes", "codex_entries", "snippets"] {
        assert!(
            serde_json::from_value::<SnapshotRestoreTable>(Value::String(name.to_string())).is_ok(),
            "'{name}' is"
        );
    }
}

// =====================================================================
// 4. The plan checks (`ensure_restore_plan_is_snapshot_derived`)
// =====================================================================

fn sticky_plan(db: &Database) -> ApplyProjectSnapshotRestorePayload {
    payload(db, "r1", "S1", &[RestoreScope::Map])
}

fn snapshot_db() -> Database {
    let db = new_db();
    seed_rich(&db);
    snapshot(&db, "S1");
    db
}

#[test]
fn a_plan_that_omits_a_snapshot_row_is_refused() {
    let db = snapshot_db();
    let mut p = sticky_plan(&db);
    let at = p
        .inserts
        .iter()
        .position(|i| i.table == table("map_stickies"))
        .expect("a sticky row");
    p.inserts.remove(at);
    assert_eq!(
        refused_plan(&db, p),
        "project snapshot restore plan omits owned snapshot rows: map_stickies:[\"st1\"]"
    );
}

#[test]
fn a_plan_with_a_row_outside_the_snapshot_is_refused() {
    let db = snapshot_db();
    let mut p = sticky_plan(&db);
    p.inserts.push(SnapshotInsertPlan {
        table: table("map_stickies"),
        row: json!({"id": "zz-st", "board_id": BOARD, "title": "smuggled"})
            .as_object()
            .cloned()
            .expect("row"),
        mode: SnapshotInsertMode::Insert,
    });
    assert_eq!(
        refused_plan(&db, p),
        "project snapshot restore plan contains rows outside the owned snapshot: map_stickies:[\"zz-st\"]"
    );
}

#[test]
fn a_plan_row_that_differs_from_the_snapshot_is_refused() {
    let db = snapshot_db();
    let mut p = sticky_plan(&db);
    let at = p
        .inserts
        .iter()
        .position(|i| i.table == table("map_stickies"))
        .expect("a sticky row");
    p.inserts[at]
        .row
        .insert("title".to_string(), json!("not what was snapshotted"));
    assert_eq!(
        refused_plan(&db, p),
        "project snapshot restore row 'map_stickies:[\"st1\"]' does not match the owned snapshot"
    );
}

#[test]
fn a_plan_with_a_row_twice_is_refused() {
    let db = snapshot_db();
    let mut p = sticky_plan(&db);
    let at = p
        .inserts
        .iter()
        .position(|i| i.table == table("map_stickies"))
        .expect("a sticky row");
    let again = SnapshotInsertPlan {
        table: p.inserts[at].table,
        row: p.inserts[at].row.clone(),
        mode: p.inserts[at].mode,
    };
    p.inserts.push(again);
    assert_eq!(
        refused_plan(&db, p),
        "project snapshot restore plan contains a duplicate 'map_stickies' row"
    );
}

#[test]
fn a_snapshot_that_holds_a_row_twice_is_refused() {
    let db = snapshot_db();
    let before = aux_payload(&db, "S1", "map_stickies");
    let mut value: Value = serde_json::from_str(&before).expect("payload");
    let first = value["rows"][0].clone();
    value["rows"].as_array_mut().expect("rows").push(first);
    set_aux_payload(&db, "S1", "map_stickies", &value.to_string());
    assert_eq!(
        refused(&db, "r1", &[RestoreScope::Map]),
        "owned project snapshot contains duplicate canonical rows"
    );
}

#[test]
fn the_plan_checks_run_in_the_order_missing_extra_mismatch() {
    // Several faults at once: the message names the first of the three, then
    // the second, ...: missing rows, rows outside, a row that differs.
    let db = snapshot_db();
    let sticky = |p: &ApplyProjectSnapshotRestorePayload| {
        p.inserts
            .iter()
            .position(|i| i.table == table("map_stickies"))
            .expect("a sticky row")
    };
    let extra_row = || SnapshotInsertPlan {
        table: table("map_stickies"),
        row: json!({"id": "zz-st", "board_id": BOARD, "title": "smuggled"})
            .as_object()
            .cloned()
            .expect("row"),
        mode: SnapshotInsertMode::Insert,
    };
    // omitted + extra -> omitted is named
    let mut p = sticky_plan(&db);
    let at = sticky(&p);
    p.inserts.remove(at);
    p.inserts.push(extra_row());
    assert!(
        refused_plan(&db, p).starts_with("project snapshot restore plan omits owned snapshot rows")
    );
    // extra + a differing row -> extra is named
    let mut p = sticky_plan(&db);
    let at = sticky(&p);
    p.inserts[at]
        .row
        .insert("title".to_string(), json!("different"));
    p.inserts.push(extra_row());
    assert!(refused_plan(&db, p)
        .starts_with("project snapshot restore plan contains rows outside the owned snapshot"));
}

// =====================================================================
// 5. The column and value checks of the insert (`insert_record`)
// =====================================================================

/// The stored sticky `st1` gets one more key, or a value of another kind. The
/// plan is made from the stored rows, so the plan checks agree and only the
/// insert's own checks can stop it.
fn db_with_sticky_key(key: &str, value: Value) -> Database {
    let db = snapshot_db();
    let before = aux_payload(&db, "S1", "map_stickies");
    let mut payload: Value = serde_json::from_str(&before).expect("payload");
    payload["rows"][0][key] = value;
    set_aux_payload(&db, "S1", "map_stickies", &payload.to_string());
    db
}

#[test]
fn a_column_the_table_does_not_have_is_refused() {
    let db = db_with_sticky_key("no_such_column", json!(1));
    assert_eq!(
        refused(&db, "r1", &[RestoreScope::Map]),
        "project snapshot insert has invalid map_stickies column 'no_such_column'"
    );
}

#[test]
fn a_column_name_that_would_inject_sql_is_refused() {
    for name in [
        "title\"); DROP TABLE map_stickies; --",
        "title\" ) VALUES (1); DELETE FROM labels; --",
        "x\" = 1, \"title",
        "title; DELETE FROM map_stickies",
        "",
    ] {
        let db = db_with_sticky_key(name, json!("x"));
        let message = refused(&db, "r1", &[RestoreScope::Map]);
        assert_eq!(
            message,
            format!("project snapshot insert has invalid map_stickies column '{name}'"),
            "column name {name:?}"
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'map_stickies'"
            ),
            1,
            "the table is still there"
        );
    }
}

#[test]
fn a_value_that_is_not_a_scalar_is_refused() {
    for (label, value) in [
        ("array", json!(["a"])),
        ("object", json!({"a": 1})),
        ("bool", json!(true)),
    ] {
        let db = db_with_sticky_key("title", value);
        assert_eq!(
            refused(&db, "r1", &[RestoreScope::Map]),
            "project snapshot row field 'title' is not a SQLite scalar",
            "{label}"
        );
    }
}

#[test]
fn a_column_check_comes_before_a_value_check() {
    // Two faults in one row: the column is named first.
    let db = snapshot_db();
    let before = aux_payload(&db, "S1", "map_stickies");
    let mut payload: Value = serde_json::from_str(&before).expect("payload");
    payload["rows"][0]["title"] = json!(["not a scalar"]);
    payload["rows"][0]["no_such_column"] = json!(1);
    set_aux_payload(&db, "S1", "map_stickies", &payload.to_string());
    assert_eq!(
        refused(&db, "r1", &[RestoreScope::Map]),
        "project snapshot insert has invalid map_stickies column 'no_such_column'"
    );
}

#[test]
fn an_insert_fault_comes_before_an_ownership_fault() {
    // A row with an unknown column in `map_edges` and a foreign parent in
    // `map_stickies`: every row is inserted before any is checked, so the
    // insert's message wins even though the sticky comes first.
    let db = rich_with_foreign();
    exec(
        &db,
        &format!(
            "DELETE FROM map_stickies WHERE board_id = '{}'",
            foreign_id(BOARD)
        ),
    );
    snapshot(&db, "S1");
    rewrite_aux(
        &db,
        "S1",
        "map_stickies",
        "board_id",
        Some(BOARD),
        None,
        json!(foreign_id(BOARD)),
    );
    rewrite_aux(
        &db,
        "S1",
        "map_edges",
        "no_such_column",
        None,
        None,
        json!(1),
    );
    assert_eq!(
        refused(&db, "r1", &[RestoreScope::Map]),
        "project snapshot insert has invalid map_edges column 'no_such_column'"
    );
}

// =====================================================================
// 6. Core tables: the check cannot be reached with another project's row
// =====================================================================

#[test]
fn a_plan_row_of_another_projects_is_refused_before_the_insert() {
    // The `project_id` of a row is checked at the door (apply's first loop),
    // with its own words, not by the ownership check.
    let db = snapshot_db();
    let mut p = payload(&db, "r1", "S1", &[RestoreScope::Labels]);
    let at = p
        .inserts
        .iter()
        .position(|i| i.table == table("labels"))
        .expect("a label row");
    p.inserts[at]
        .row
        .insert("project_id".to_string(), json!(FOREIGN));
    assert_eq!(
        refused_plan(&db, p),
        "project snapshot insert for 'labels' has a foreign project_id"
    );
}

#[test]
fn the_context_of_a_restore_is_unchanged_by_the_hostile_rows() {
    // `project_snapshot_restore_context` reads the stored snapshot; a hostile
    // aux row must not make it fail in a way that hides the restore's refusal.
    let db = hostile_db("map_stickies", "board_id", BOARD, json!(foreign_id(BOARD)));
    let context = project_snapshot_restore_context(
        &db,
        P.to_string(),
        "S1".to_string(),
        vec![RestoreScope::Map],
    );
    assert!(context.is_ok(), "the confirmation can still be shown");
    assert_eq!(
        refused(&db, "r1", &[RestoreScope::Map]),
        not_scoped("map_stickies")
    );
}

// =====================================================================
// 8. The binding of every scene of a long table, and its order against the
//    ownership check
// =====================================================================

#[test]
fn every_scene_of_a_table_longer_than_one_chunk_gets_its_scene_binding() {
    // 450 scenes (more than two chunks of 200) restored with a changed
    // `updated_at` each: every restored scene is bound again, and carries the
    // restored `updated_at`, wherever it sits in the table (the first and last
    // row of every chunk included).
    let db = new_db();
    seed_rich(&db);
    exec(
        &db,
        &format!(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 449)
             INSERT INTO tree_nodes (id, project_id, node_type, title, content, created_at, updated_at, version)
             SELECT 'b-s-' || printf('%03d', i), '{P}', 'scene', 'B ' || i, '{{}}', 't',
                    'u-' || printf('%03d', i), 0 FROM n;"
        ),
    );
    snapshot(&db, "S1");
    let scenes = scalar_i64(
        &db,
        &format!(
            "SELECT COUNT(*) FROM tree_nodes WHERE project_id = '{P}' AND node_type = 'scene'"
        ),
    );
    assert_eq!(scenes, 452, "premise: 450 new scenes and the 2 of the seed");
    // The work moves on: half of the scenes are gone, the others changed.
    exec(
        &db,
        "DELETE FROM tree_nodes WHERE id LIKE 'b-s-1%' OR id LIKE 'b-s-3%';
         UPDATE tree_nodes SET updated_at = 'moved-on' WHERE id LIKE 'b-s-%';",
    );
    let r = restore(&db, "r1", "S1", &[RestoreScope::Body]);
    assert!(!r.no_op);
    assert_clean(&db, "after restoring 450 scenes");
    assert_eq!(
        scalar_i64(
            &db,
            &format!(
                "SELECT COUNT(*) FROM tree_nodes WHERE project_id = '{P}' AND node_type = 'scene'"
            )
        ),
        scenes,
        "every scene is back"
    );
    let unbound: Vec<String> = dump_sql(
        &db,
        &format!(
            "SELECT t.id FROM tree_nodes t
              WHERE t.project_id = '{P}' AND t.node_type = 'scene'
                AND NOT EXISTS (
                    SELECT 1 FROM narrative_scene_scope_bindings b
                     WHERE b.project_id = t.project_id AND b.scene_id = t.id
                       AND b.updated_at = t.updated_at AND b.source_token <> '')"
        ),
    );
    assert_eq!(
        unbound,
        Vec::<String>::new(),
        "every restored scene is bound, with the restored updated_at"
    );
    // The same version for all of them: each binding was made once and its
    // source refreshed once.
    assert_eq!(
        scalar_i64(
            &db,
            &format!(
                "SELECT COUNT(DISTINCT version) FROM narrative_scene_scope_bindings WHERE project_id = '{P}'"
            )
        ),
        1,
        "every binding went through the same steps"
    );
}

#[test]
fn a_scene_binding_that_cannot_be_made_is_refused_before_a_later_tables_bad_row() {
    // Rows are checked and bound table by table in plan order, a scene's
    // binding after its own check and before the next table is looked at. With
    // the binding table gone, the first scene's binding fails: that is the
    // refusal, though `map_stickies` (a later table) also holds a bad row.
    let db = rich_with_foreign();
    snapshot(&db, "S1");
    let (_, changed) = rewrite_aux(
        &db,
        "S1",
        "map_stickies",
        "board_id",
        Some(BOARD),
        None,
        json!(foreign_id(BOARD)),
    );
    assert!(changed > 0, "premise: a sticky is rewritten");
    // Control: with the binding table in place, the bad row is what is refused.
    assert_eq!(
        refused(&db, "r0", &[RestoreScope::Body, RestoreScope::Map]),
        not_scoped("map_stickies")
    );
    exec(&db, "DROP TABLE narrative_scene_scope_bindings");
    let message = refused(&db, "r1", &[RestoreScope::Body, RestoreScope::Map]);
    assert_eq!(
        message, "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing",
        "the scene binding fails before the later table is judged"
    );
}
