//! Differential tests of the ownership check of a project snapshot restore
//! (`docs/plans/nir1-lane-decisions/restore-insert-perf-decisions.md`,
//! DR-RIP-1..9). `#[ignore]`: they run thousands of restores. Run them with
//! `cargo test -p grimodex-db --test snapshot_restore_scope_equivalence -- --ignored`.
//!
//! The ownership check used to be one `SELECT EXISTS` per inserted row
//! (`ensure_inserted_row_is_project_scoped`, run after all rows were inserted
//! with `insert_record`). It is now one query per chunk of rows of a table.
//! The rule is that nothing observable changes: the same rows are refused, for
//! the same reason, in the same words and the same order.
//!
//! The previous check and the previous `insert_record` are copied below
//! (`old_ensure_row_scoped`, `old_insert_record`, from the file at git
//! `master 7a0b64976`, with the ownership rules of `AUX_SPECS` restated as
//! data). For each hostile input the test
//!   1. runs the real, public `apply_project_snapshot_restore` on a copy of the
//!      database, and
//!   2. replays what the old code did on another copy of the same database
//!      (delete the rows the plan replaces, insert every plan row with the old
//!      `insert_record`, then check every row in plan order with the old check).
//!
//! The two verdicts must agree: a refusal by the ownership check names the
//! same table in the same words, a refusal by the insert carries the same
//! message, and a restore the old check lets through is not refused by the new
//! one (and the stable tables hold the same rows afterwards).
#![allow(dead_code)]

use std::collections::BTreeMap;

use grimodex_db::change_events::{append_change_events_in_tx, AppendChangeEvent};
use grimodex_db::project_snapshots::{
    apply_project_snapshot_restore, create_project_snapshot, ApplyProjectSnapshotRestorePayload,
    CreateProjectSnapshotPayload, RestoreScope, SnapshotInsertMode, SnapshotInsertPlan,
    SnapshotRestoreTable,
};
use grimodex_db::Database;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, OptionalExtension};
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
    if scopes.contains(&RestoreScope::Labels) {
        aux(&mut plans, "labels", SnapshotInsertMode::Insert);
        aux(&mut plans, "tree_node_labels", SnapshotInsertMode::Insert);
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

fn foreign_key_violations(db: &Database) -> usize {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
        let n = stmt.query_map([], |_| Ok(()))?.count();
        Ok(n)
    })
    .expect("foreign_key_check")
}
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
/// `(table, predicate, binds)` of every ownership rule (`AUX_SPECS`).
const AUX_RULES: &[(&str, &str, usize)] = &[
    ("codex_types", "project_id = ?", 1),
    ("codex_tags", "project_id = ?", 1),
    ("codex_entry_tags", "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", 1),
    ("codex_detail_definitions", "project_id = ?", 1),
    ("codex_detail_semantic_bindings", "project_id = ?", 1),
    ("codex_detail_values", "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", 1),
    ("codex_entry_phases", "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", 1),
    ("codex_phase_detail_overrides", "phase_id IN (SELECT id FROM codex_entry_phases WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?))", 1),
    ("codex_quick_pins", "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", 1),
    ("codex_dismissed_relations", "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", 1),
    ("codex_relations", "project_id = ?", 1),
    ("snippet_entry_tags", "snippet_id IN (SELECT id FROM snippets WHERE project_id = ?)", 1),
    ("labels", "project_id = ?", 1),
    ("tree_node_labels", "node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", 1),
    ("foreshadows", "project_id = ?", 1),
    ("foreshadow_setups", "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)", 1),
    ("foreshadow_payoffs", "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)", 1),
    ("foreshadow_setup_payoff_links", "setup_id IN (SELECT id FROM foreshadow_setups WHERE foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?))", 1),
    ("foreshadow_codex_links", "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)", 1),
    ("map_boards", "project_id = ?", 1),
    ("map_ai_branches", "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", 1),
    ("map_stickies", "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", 1),
    ("editor_stickies", "project_id = ?", 1),
    ("map_node_positions", "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", 1),
    ("map_edges", "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", 1),
    ("map_frames", "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", 1),
    ("lint_ignored_diagnostics", "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", 1),
    ("lint_term_dictionary", "project_id = ?", 1),
    ("authorship_spans", "(node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?) OR codex_entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?) OR snippet_id IN (SELECT id FROM snippets WHERE project_id = ?) OR detail_value_id IN (SELECT id FROM codex_detail_values WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)) OR sticky_id IN (SELECT id FROM map_stickies WHERE board_id IN (SELECT id FROM map_boards WHERE project_id = ?)))", 5),
    ("generation_logs", "project_id = ?", 1),
    ("post_effect_annotations", "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", 1),
    ("post_effect_annotation_relations", "annotation_a_id IN (SELECT id FROM post_effect_annotations WHERE scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?))", 1),
    ("scene_codex_pins", "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", 1),
    ("scene_codex_mentions", "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", 1),
    ("scene_beat_pov_cache", "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", 1),
    ("plot_threads", "project_id = ?", 1),
    ("plot_thread_scene_links", "thread_id IN (SELECT id FROM plot_threads WHERE project_id = ?)", 1),
    ("plot_thread_branches", "project_id = ?", 1),
    ("events", "project_id = ?", 1),
    ("event_relations", "project_id = ?", 1),
    ("scene_events", "event_id IN (SELECT id FROM events WHERE project_id = ?)", 1),
    ("event_participants", "event_id IN (SELECT id FROM events WHERE project_id = ?)", 1),
    ("project_calendar", "project_id = ?", 1),
];

// =====================================================================
// The previous implementation, copied (git master 7a0b64976)
// =====================================================================

fn table_name(table: SnapshotRestoreTable) -> String {
    serde_json::to_value(table)
        .expect("table name")
        .as_str()
        .expect("string")
        .to_string()
}

fn old_table_exists(conn: &rusqlite::Connection, table: &str) -> anyhow::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn old_table_columns(
    conn: &rusqlite::Connection,
    table: &str,
) -> anyhow::Result<std::collections::HashSet<String>> {
    let sql = format!("PRAGMA table_info(\"{table}\")");
    let mut statement = conn.prepare(&sql)?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(columns.collect::<Result<std::collections::HashSet<_>, _>>()?)
}

fn old_sql_value(value: &Value, field: &str) -> anyhow::Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                SqlValue::Integer(value)
            } else if let Some(value) = value.as_f64() {
                SqlValue::Real(value)
            } else {
                anyhow::bail!("project snapshot row field '{field}' is outside SQLite range");
            }
        }
        Value::Bool(_) | Value::Array(_) | Value::Object(_) => {
            anyhow::bail!("project snapshot row field '{field}' is not a SQLite scalar");
        }
    })
}

fn old_primary_key_columns(
    conn: &rusqlite::Connection,
    table: &str,
) -> anyhow::Result<Vec<String>> {
    let sql = format!("PRAGMA table_info(\"{table}\")");
    let mut statement = conn.prepare(&sql)?;
    let mut columns = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    columns.retain(|(_, ordinal)| *ordinal > 0);
    columns.sort_by_key(|(_, ordinal)| *ordinal);
    let columns = columns
        .into_iter()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    anyhow::ensure!(
        !columns.is_empty(),
        "project snapshot restore table '{table}' has no primary key"
    );
    Ok(columns)
}

/// `insert_record` as it was: the table information is read again for every
/// row.
fn old_insert_record(
    conn: &rusqlite::Connection,
    table: &str,
    row: &serde_json::Map<String, Value>,
    replace: bool,
) -> anyhow::Result<()> {
    if row.is_empty() {
        anyhow::bail!("project snapshot insert for '{table}' must not be empty");
    }
    if !old_table_exists(conn, table)? {
        return Ok(());
    }
    let actual_columns = old_table_columns(conn, table)?;
    let mut columns: Vec<&String> = row.keys().collect();
    columns.sort_unstable();
    for column in &columns {
        if !actual_columns.contains(column.as_str()) {
            anyhow::bail!("project snapshot insert has invalid {table} column '{column}'");
        }
    }
    let values = columns
        .iter()
        .map(|column| old_sql_value(&row[*column], column))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let column_sql = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let verb = if replace {
        "INSERT OR REPLACE"
    } else {
        "INSERT"
    };
    let sql = format!("{verb} INTO \"{table}\" ({column_sql}) VALUES ({placeholders})");
    conn.execute(&sql, params_from_iter(values.iter()))?;
    Ok(())
}

/// `ensure_inserted_row_is_project_scoped` as it was: one `SELECT EXISTS` per
/// row, run after every row of the plan had been inserted.
fn old_ensure_row_scoped(
    conn: &rusqlite::Connection,
    project_id: &str,
    table: &str,
    row: &serde_json::Map<String, Value>,
) -> anyhow::Result<()> {
    if !old_table_exists(conn, table)? {
        return Ok(());
    }
    let primary_keys = old_primary_key_columns(conn, table)?;
    let (predicate, project_binds) = match table {
        "tree_nodes" | "codex_entries" | "snippets" => ("project_id = ?", 1),
        other => {
            let spec = AUX_RULES
                .iter()
                .find(|(name, _, _)| *name == other)
                .ok_or_else(|| {
                    anyhow::anyhow!("project snapshot table '{other}' has no ownership rule")
                })?;
            (spec.1, spec.2)
        }
    };
    let key_predicate = primary_keys
        .iter()
        .map(|column| format!("\"{column}\" = ?"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT EXISTS(
            SELECT 1 FROM \"{table}\"
             WHERE {key_predicate} AND ({predicate})
         )"
    );
    let mut values = primary_keys
        .iter()
        .map(|column| {
            let value = row.get(column).ok_or_else(|| {
                anyhow::anyhow!("project snapshot insert for '{table}' is missing '{column}'")
            })?;
            old_sql_value(value, column)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    values.extend((0..project_binds).map(|_| SqlValue::Text(project_id.to_string())));
    let owned: bool = conn.query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))?;
    anyhow::ensure!(
        owned,
        "project snapshot insert for '{table}' is not scoped to project '{project_id}'"
    );
    Ok(())
}

// =====================================================================
// Replaying the old restore on a copy of the database
// =====================================================================

/// What the old restore would have done with a plan.
#[derive(Debug)]
enum Old {
    /// `insert_record` refused row `index` (message of the root cause).
    Insert(String),
    /// The old check refused row `index` of `table`, in these words.
    Refused {
        table: String,
        index: usize,
        message: String,
    },
    /// Every row went in and was found owned. `fk_violations` is the number of
    /// rows `PRAGMA foreign_key_check` then reports (the commit would refuse).
    Passed { fk_violations: usize },
}

fn copy_db(template: &Database) -> Database {
    let copy = Database::new(std::path::Path::new(":memory:")).expect("open copy");
    template
        .with_conn(|src| {
            copy.with_conn_mut(|dst| {
                let backup = rusqlite::backup::Backup::new(src, dst)?;
                backup.run_to_completion(1000, std::time::Duration::ZERO, None)?;
                Ok(())
            })
        })
        .expect("copy the database");
    copy
}

/// Replay, on `db` (a copy, which this changes), what the old
/// `apply_project_snapshot_restore` did with the rows of `hostile`: the rows
/// the plan replaces (`original`, which the database still holds) go, every
/// row of the plan is inserted with the old `insert_record`, and then every
/// row, in plan order, is held to the old check.
fn replay_old(
    db: &Database,
    original: &[SnapshotInsertPlan],
    hostile: &[SnapshotInsertPlan],
) -> Old {
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        for insert in original {
            let table = table_name(insert.table);
            if !old_table_exists(conn, &table)? {
                continue;
            }
            let keys = old_primary_key_columns(conn, &table)?;
            let predicate = keys
                .iter()
                .map(|key| format!("\"{key}\" IS ?"))
                .collect::<Vec<_>>()
                .join(" AND ");
            let values = keys
                .iter()
                .map(|key| old_sql_value(&insert.row[key], key))
                .collect::<anyhow::Result<Vec<_>>>()?;
            conn.execute(
                &format!("DELETE FROM \"{table}\" WHERE {predicate}"),
                params_from_iter(values.iter()),
            )?;
        }
        for (index, insert) in hostile.iter().enumerate() {
            let table = table_name(insert.table);
            let mut row = insert.row.clone();
            if table == "scene_events" {
                // The restore does not trust the captured token: it writes a
                // new one for every row.
                row.insert(
                    "incarnation_token".to_string(),
                    json!(format!("replay-token-{index}")),
                );
            }
            if let Err(error) = old_insert_record(
                conn,
                &table,
                &row,
                insert.mode == SnapshotInsertMode::Replace,
            ) {
                return Ok(Old::Insert(error.root_cause().to_string()));
            }
        }
        for (index, insert) in hostile.iter().enumerate() {
            let table = table_name(insert.table);
            if let Err(error) = old_ensure_row_scoped(conn, P, &table, &insert.row) {
                return Ok(Old::Refused {
                    table,
                    index,
                    message: error.root_cause().to_string(),
                });
            }
        }
        // (Not the provenance rows, which are not replayed: one that names a
        // document whose key was rewritten is dropped by the real restore.)
        let fk_violations = conn
            .prepare("PRAGMA foreign_key_check")?
            .query_map([], |row| row.get::<_, String>(0))?
            .filter(|table| {
                table
                    .as_ref()
                    .is_ok_and(|table| table != "authorship_spans")
            })
            .count();
        Ok(Old::Passed { fk_violations })
    })
    .expect("replay the old restore")
}

// =====================================================================
// Hostile inputs
// =====================================================================

/// Picks the aux rows to rewrite: `(index of the row in the payload, the row)`.
type RowSelector = Box<dyn Fn(usize, &Value) -> bool>;

/// Which aux rows of `table` to rewrite, and how.
struct Tamper {
    table: String,
    select: RowSelector,
    set: Vec<(String, Value)>,
}

/// Rewrite the stored aux payloads of `db`. Returns how many rows changed.
fn tamper_db(db: &Database, tampers: &[Tamper]) -> usize {
    let mut changed = 0;
    for tamper in tampers {
        let before = aux_payload(db, "S1", &tamper.table);
        let mut value: Value = serde_json::from_str(&before).expect("aux payload");
        for (index, row) in value["rows"]
            .as_array_mut()
            .expect("rows")
            .iter_mut()
            .enumerate()
        {
            if (tamper.select)(index, row) {
                for (column, to) in &tamper.set {
                    row[column] = to.clone();
                }
                changed += 1;
            }
        }
        set_aux_payload(db, "S1", &tamper.table, &value.to_string());
    }
    changed
}

fn by_value(column: &'static str, from: &str) -> RowSelector {
    let from = from.to_string();
    Box::new(move |_, row| row.get(column).and_then(Value::as_str) == Some(from.as_str()))
}

fn by_ids(ids: Vec<String>) -> RowSelector {
    Box::new(move |_, row| {
        row.get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| ids.iter().any(|wanted| wanted == id))
    })
}

/// Values a column may be rewritten to: a parent of another project, one that
/// does not exist, NULL, and values of another type or that differ only in
/// spelling (SQLite compares text exactly, but applies affinity to numbers).
fn hostile_values(from: &Value) -> Vec<(&'static str, Value)> {
    let mut values = vec![
        ("null", Value::Null),
        ("missing", json!("no-such-parent")),
        ("empty", json!("")),
        ("int-1", json!(1)),
        ("text-1", json!("1")),
        ("real", json!(1.5)),
        ("neg", json!(-1)),
        ("bool", json!(true)),
        ("array", json!(["x"])),
    ];
    if let Some(from) = from.as_str() {
        // A sibling of the same project: the row stays inside the chain.
        match from {
            "c1" => values.push(("sibling", json!("c2"))),
            "s1" => values.push(("sibling", json!("s2"))),
            _ => {}
        }
        values.push(("foreign", json!(foreign_id(from))));
        values.push(("trailing-space", json!(format!("{from} "))));
        values.push(("upper", json!(from.to_uppercase())));
        values.push(("prefix", json!(format!("x{from}"))));
    }
    values
}

#[derive(Default)]
struct Report {
    cases: usize,
    classes: BTreeMap<String, usize>,
    early: BTreeMap<String, usize>,
    later: BTreeMap<String, usize>,
    mismatches: Vec<String>,
    stable_compared: usize,
}

impl Report {
    fn print(&self, name: &str) {
        eprintln!(
            "[{name}] cases = {}, mismatches = {}, stable tables compared after passing restores = {}",
            self.cases,
            self.mismatches.len(),
            self.stable_compared
        );
        for (class, n) in &self.classes {
            eprintln!("[{name}]   {class}: {n}");
        }
        for (message, n) in &self.later {
            eprintln!("[{name}]   later-stage refusal ({n}x): {message}");
        }
        for (message, n) in &self.early {
            eprintln!("[{name}]   early refusal ({n}x): {message}");
        }
    }

    fn assert_clean(&self, name: &str) {
        self.print(name);
        assert!(
            self.mismatches.is_empty(),
            "[{name}] {} mismatches, first: {:#?}",
            self.mismatches.len(),
            &self.mismatches[..self.mismatches.len().min(60)]
        );
    }
}

/// A refusal made before any row is inserted (the plan checks, the doorway
/// checks). The old code made the same ones, so a case that stops there is
/// counted, and not compared with the replay of the insert and the check.
fn is_early(message: &str) -> bool {
    message.contains("restore plan")
        || message.contains("does not match the owned snapshot")
        || message.contains("outside the selected scopes")
        || message.contains("snapshot contains duplicate")
        || message.contains("missing primary key")
        || message.contains("must belong to the project")
        || message.contains("has a foreign project_id")
}

/// What a later stage of the restore (the feed, the links, the type
/// conversions of a row) says when it refuses a hostile input. A refusal of
/// the ownership check's own question (a SQL error: too many variables, no
/// such column, a syntax error) is none of these, so it cannot hide among
/// them: an unrecognised message is a mismatch, not a count.
const KNOWN_LATER_REFUSALS: &[&str] = &[
    "Invalid column type",
    "has no identity",
    "not found in project",
    "Query returned no rows",
];

/// Run one hostile input through the real restore and through the replay of the
/// old one, and compare them.
fn run_case(
    report: &mut Report,
    template: &Database,
    label: &str,
    prep: &[String],
    tampers: &[Tamper],
    scopes: &[RestoreScope],
) {
    let live = copy_db(template);
    let replay = copy_db(template);
    for db in [&live, &replay] {
        for sql in prep {
            exec(db, sql);
        }
    }
    let changed = tamper_db(&live, tampers);
    tamper_db(&replay, tampers);
    assert!(changed > 0, "{label}: premise: a row is rewritten");
    // The provenance rows (`authorship_spans`) are not replayed: the restore
    // reshapes them to the documents it replaces before they are inserted
    // (DR-SRX-7, code this change does not touch), so the raw aux rows are not
    // what it inserts. They are left out of the replay and listed in the
    // report as not covered.
    let mut original = plan(template, "S1", scopes);
    original.retain(|insert| table_name(insert.table) != "authorship_spans");
    let mut hostile = plan(&live, "S1", scopes);
    hostile.retain(|insert| table_name(insert.table) != "authorship_spans");
    let new = apply_project_snapshot_restore(&live, payload(&live, "r1", "S1", scopes));
    let old = replay_old(&replay, &original, &hostile);
    report.cases += 1;
    let mut mismatch = |what: String| report.mismatches.push(format!("{label}: {what}"));
    let class;
    match (&old, &new) {
        (_, Err(error)) if is_early(&error.root_cause().to_string()) => {
            let message = error.root_cause().to_string();
            class = "stopped before the insert".to_string();
            *report
                .early
                .entry(message.chars().take(110).collect())
                .or_default() += 1;
        }
        (Old::Refused { table, message, .. }, Ok(_)) => {
            class = "old refuses at the ownership check, new accepts".to_string();
            mismatch(format!("old refused '{table}' ({message}), new restored"));
        }
        (Old::Refused { table, message, .. }, Err(error)) => {
            let new_message = error.root_cause().to_string();
            class = "both refuse at the ownership check".to_string();
            if !(&new_message == message && message == &not_scoped(table)) {
                mismatch(format!(
                    "old refused '{table}' with '{message}', new refused with '{new_message}'"
                ));
            }
        }
        (Old::Insert(message), Err(error)) => {
            let new_message = error.root_cause().to_string();
            class = "both refuse at the insert".to_string();
            if &new_message != message {
                mismatch(format!(
                    "old insert refused with '{message}', new with '{new_message}'"
                ));
            }
        }
        (Old::Insert(message), Ok(_)) => {
            class = "old refuses at the insert, new accepts".to_string();
            mismatch(format!("old insert refused ({message}), new restored"));
        }
        (Old::Passed { fk_violations }, Ok(_)) => {
            class = "both accept".to_string();
            if *fk_violations > 0 {
                mismatch(format!(
                    "old left {fk_violations} foreign key violations but new committed"
                ));
            }
            report.stable_compared += 1;
            let (a, b) = (stable_rows(&live), stable_rows(&replay));
            if a != b {
                let differing = a
                    .iter()
                    .filter(|(table, rows)| b.get(*table) != Some(*rows))
                    .map(|(table, _)| *table)
                    .collect::<Vec<_>>();
                mismatch(format!(
                    "both accept, but the rows of {differing:?} differ after the restore"
                ));
            }
        }
        (Old::Passed { fk_violations }, Err(error)) => {
            let new_message = error.root_cause().to_string();
            let ownership_words = new_message.contains("not scoped")
                || new_message.contains("is missing '")
                || new_message.contains("has no ownership rule")
                || new_message.contains("has no primary key");
            if ownership_words {
                class = "old accepts, new refuses with an ownership message".to_string();
                mismatch(format!("old passed every row, new refused: {new_message}"));
            } else if *fk_violations > 0
                && (new_message.contains("FOREIGN KEY") || new_message.contains("787"))
            {
                class = "both refuse at the foreign key".to_string();
            } else {
                // The ownership check is not what refused: a later stage of
                // the restore (the feed, the links) did.
                class = "both pass the ownership check, a later stage refuses".to_string();
                if !KNOWN_LATER_REFUSALS
                    .iter()
                    .any(|known| new_message.contains(known))
                {
                    mismatch(format!(
                        "old passed every row, new refused with a message no later stage is known to give: {new_message}"
                    ));
                }
                *report
                    .later
                    .entry(new_message.chars().take(100).collect())
                    .or_default() += 1;
            }
        }
    }
    *report.classes.entry(class).or_default() += 1;
}

const STABLE: &[&str] = &[
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
    STABLE
        .iter()
        .map(|t| (*t, dump_sql(db, &format!("SELECT * FROM \"{t}\""))))
        .collect()
}

fn template_with_snapshot() -> Database {
    let db = rich_with_foreign();
    snapshot(&db, "S1");
    db
}

/// The SQL that makes room for a rewritten row in the other project's copy
/// (its children of that parent would collide on a primary key).
fn make_room(table: &str, column: &str, to: &Value) -> Vec<String> {
    match to.as_str() {
        Some(to) if to.starts_with("x-") => vec![format!(
            "DELETE FROM \"{table}\" WHERE \"{column}\" = '{to}'"
        )],
        _ => Vec::new(),
    }
}

// =====================================================================
// 1. A parent column of every table, rewritten in every way
// =====================================================================

#[test]
#[ignore]
fn parent_columns_rewritten_in_every_way() {
    let template = template_with_snapshot();
    let mut report = Report::default();
    for (table, scope, column, from, _) in PARENT_CASES {
        for (kind, to) in hostile_values(&json!(from)) {
            let prep = make_room(table, column, &to);
            for scopes in [own_scopes(table, *scope), ALL_SCOPES.to_vec()] {
                let tampers = [Tamper {
                    table: table.to_string(),
                    select: by_value(column, from),
                    set: vec![(column.to_string(), to.clone())],
                }];
                run_case(
                    &mut report,
                    &template,
                    &format!("{table}.{column} {from} -> {kind} ({scopes:?})"),
                    &prep,
                    &tampers,
                    &scopes,
                );
            }
        }
    }
    report.assert_clean("parent columns");
    assert!(report.cases >= 400, "{}", report.cases);
    assert!(
        report
            .classes
            .get("both refuse at the ownership check")
            .copied()
            .unwrap_or(0)
            >= 60,
        "the inputs must exercise the ownership check"
    );
}

// =====================================================================
// 2. Every column of the first row of every table, rewritten in every way
// =====================================================================

#[test]
#[ignore]
fn every_column_of_every_table_rewritten_in_every_way() {
    let template = template_with_snapshot();
    let mut report = Report::default();
    let original = plan(&template, "S1", &ALL_SCOPES);
    let mut seen = std::collections::BTreeSet::new();
    for insert in &original {
        let table = table_name(insert.table);
        // Aux tables only: the three core tables are made from rows the
        // plan fixes to the project.
        if matches!(
            table.as_str(),
            "tree_nodes" | "codex_entries" | "snippets" | "authorship_spans"
        ) {
            continue;
        }
        if !seen.insert(table.clone()) {
            continue;
        }
        if std::env::var("EQUIV_ONLY").is_ok_and(|only| !only.split(',').any(|t| t == table)) {
            continue;
        }
        let first_row = Value::Object(insert.row.clone());
        for column in insert.row.keys() {
            for (kind, to) in hostile_values(&first_row[column]) {
                let prep = make_room(&table, column, &to);
                let tampers = [Tamper {
                    table: table.clone(),
                    select: Box::new(|index, _| index == 0),
                    set: vec![(column.clone(), to.clone())],
                }];
                run_case(
                    &mut report,
                    &template,
                    &format!("{table}.{column} (first row) -> {kind}"),
                    &prep,
                    &tampers,
                    &ALL_SCOPES,
                );
            }
        }
    }
    report.assert_clean("every column");
    assert!(report.cases >= 1000, "{}", report.cases);
}

// =====================================================================
// 3. Two and three bad tables at once (plan order)
// =====================================================================

#[test]
#[ignore]
fn several_bad_tables_name_the_first_in_plan_order() {
    let template = template_with_snapshot();
    let mut report = Report::default();
    let kinds: [fn(&str) -> Value; 3] = [
        |from| json!(foreign_id(from)),
        |_| json!("no-such-parent"),
        |_| Value::Null,
    ];
    let make = |indexes: &[usize], kind: fn(&str) -> Value| {
        let mut prep = Vec::new();
        let mut tampers = Vec::new();
        for index in indexes {
            let (table, _, column, from, _) = PARENT_CASES[*index];
            let to = kind(from);
            prep.extend(make_room(table, column, &to));
            tampers.push(Tamper {
                table: table.to_string(),
                select: by_value(column, from),
                set: vec![(column.to_string(), to)],
            });
        }
        (prep, tampers)
    };
    let n = PARENT_CASES.len();
    for (a, case_a) in PARENT_CASES.iter().enumerate() {
        for (b, case_b) in PARENT_CASES.iter().enumerate().skip(a + 1) {
            for kind in kinds {
                let (prep, tampers) = make(&[a, b], kind);
                run_case(
                    &mut report,
                    &template,
                    &format!("{} + {}", case_a.0, case_b.0),
                    &prep,
                    &tampers,
                    &ALL_SCOPES,
                );
            }
        }
    }
    // Triples, drawn by a fixed generator.
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..150 {
        let mut picked = Vec::new();
        while picked.len() < 3 {
            let candidate = (next() % n as u64) as usize;
            if !picked.contains(&candidate) {
                picked.push(candidate);
            }
        }
        let kind = kinds[(next() % 3) as usize];
        let (prep, tampers) = make(&picked, kind);
        run_case(
            &mut report,
            &template,
            &format!(
                "triple {:?}",
                picked
                    .iter()
                    .map(|i| PARENT_CASES[*i].0)
                    .collect::<Vec<_>>()
            ),
            &prep,
            &tampers,
            &ALL_SCOPES,
        );
    }
    report.assert_clean("several tables");
}

// =====================================================================
// 4. Tables longer than a chunk: which rows are bad
// =====================================================================

/// The positions to rewrite: every edge of a chunk of 200 (before, at, after),
/// and sets drawn by a fixed generator, near the edges and anywhere.
fn position_sets(len: usize, random_sets: usize) -> Vec<Vec<usize>> {
    let mut sets: Vec<Vec<usize>> = Vec::new();
    for edge in [0, 199, 200, 399, 400, 599, 600] {
        for delta in [-1_i64, 0, 1] {
            let position = edge as i64 + delta;
            if position >= 0 && (position as usize) < len {
                sets.push(vec![position as usize]);
            }
        }
    }
    sets.push(vec![len - 1]);
    sets.push(vec![len - 2, len - 1]);
    sets.push(vec![199, 200]);
    sets.push(vec![398, 399, 400, 401]);
    sets.push((0..len).collect());
    sets.push((0..len).step_by(2).collect());
    sets.push((0..len / 2).collect());
    sets.push((len / 2..len).collect());
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..random_sets {
        let size = 1 + (next() % 6) as usize;
        let near_edge = next() % 2 == 0;
        let mut set = std::collections::BTreeSet::new();
        for _ in 0..size {
            let position = if near_edge {
                let edge = 200 * (next() % 4) as usize;
                (edge + (next() % 5) as usize).saturating_sub(2)
            } else {
                (next() % len as u64) as usize
            };
            set.insert(position.min(len - 1));
        }
        sets.push(set.into_iter().collect());
    }
    sets
}

#[test]
#[ignore]
fn bad_rows_anywhere_in_a_long_table() {
    let (template, ids) = db_with_700_stickies();
    let mut report = Report::default();
    // The restore inserts a table in the order of the keys' JSON text; `ids`
    // is in that order.
    for set in position_sets(ids.len(), 70) {
        let only: Vec<String> = set.iter().map(|position| ids[*position].clone()).collect();
        for (kind, to) in [
            ("foreign", json!(foreign_id(BOARD))),
            ("missing", json!("no-such-board")),
            ("text-1", json!("1")),
        ] {
            let tampers = [Tamper {
                table: "map_stickies".to_string(),
                select: by_ids(only.clone()),
                set: vec![("board_id".to_string(), to.clone())],
            }];
            let prep = make_room("map_stickies", "board_id", &to);
            run_case(
                &mut report,
                &template,
                &format!("stickies at {:?} -> {kind}", &set[..set.len().min(6)]),
                &prep,
                &tampers,
                &[RestoreScope::Map],
            );
        }
    }
    // Control: nothing rewritten but one row to a sound sibling board. The
    // restore must go through in both.
    report.assert_clean("long table");
    assert!(
        report
            .classes
            .get("both refuse at the ownership check")
            .copied()
            .unwrap_or(0)
            >= 100
    );
}

fn db_with_700_mentions() -> (Database, Vec<(String, String)>) {
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
    (db, keys)
}

#[test]
#[ignore]
fn bad_rows_anywhere_in_a_long_composite_key_table() {
    let (template, keys) = db_with_700_mentions();
    let mut report = Report::default();
    for set in position_sets(keys.len(), 40) {
        let wanted: Vec<(String, String)> = set.iter().map(|p| keys[*p].clone()).collect();
        // (the parent column is the first key column, the entry the second)
        for (column, kind, to) in [
            ("scene_id", "foreign-scene", json!("x-s1")),
            ("scene_id", "missing-scene", json!("no-such-scene")),
            ("scene_id", "int-scene", json!(7)),
            ("codex_entry_id", "foreign-entry", json!("x-c2")),
            ("codex_entry_id", "missing-entry", json!("no-such-entry")),
        ] {
            let wanted = wanted.clone();
            let tampers = [Tamper {
                table: "scene_codex_mentions".to_string(),
                select: Box::new(move |_, row| {
                    wanted.iter().any(|(scene, codex)| {
                        row["scene_id"] == json!(scene) && row["codex_entry_id"] == json!(codex)
                    })
                }),
                set: vec![(column.to_string(), to.clone())],
            }];
            let mut prep = make_room("scene_codex_mentions", column, &to);
            if to == json!("x-s1") {
                // x-s1 owns the copy of (s1, c2); room for the rewritten rows
                // is made by `make_room` above.
                prep.clear();
                prep.push("DELETE FROM scene_codex_mentions WHERE scene_id = 'x-s1'".to_string());
            }
            run_case(
                &mut report,
                &template,
                &format!(
                    "mentions at {:?}, {column} -> {kind}",
                    &set[..set.len().min(6)]
                ),
                &prep,
                &tampers,
                &[RestoreScope::Body],
            );
        }
    }
    report.assert_clean("long composite key table");
    assert!(
        report
            .classes
            .get("both refuse at the ownership check")
            .copied()
            .unwrap_or(0)
            >= 50
    );
}

// =====================================================================
// 5. Restores that go through: nothing is changed by being checked
// =====================================================================

#[test]
#[ignore]
fn sound_restores_give_the_same_rows() {
    let template = template_with_snapshot();
    let mut report = Report::default();
    for scopes in [
        ALL_SCOPES.to_vec(),
        vec![RestoreScope::Codex],
        vec![RestoreScope::Body],
        vec![RestoreScope::Map],
        vec![RestoreScope::Body, RestoreScope::Labels],
        vec![RestoreScope::Body, RestoreScope::Lint],
        vec![RestoreScope::Foreshadow],
        vec![RestoreScope::Snippet],
    ] {
        // A "rewrite" that changes nothing that matters: a text column.
        let tampers = [Tamper {
            table: "labels".to_string(),
            select: Box::new(|_, _| true),
            set: vec![("name".to_string(), json!("Renamed"))],
        }];
        run_case(
            &mut report,
            &template,
            &format!("sound restore {scopes:?}"),
            &[],
            &tampers,
            &scopes,
        );
    }
    report.assert_clean("sound restores");
    assert_eq!(
        report.classes.get("both accept").copied().unwrap_or(0),
        report.cases,
        "every sound restore is accepted by both"
    );
}
