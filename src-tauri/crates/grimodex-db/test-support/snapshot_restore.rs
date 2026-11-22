//! Shared source for private test adapters; never compiled into the product.
//!
//! A real project snapshot restore (`apply_project_snapshot_restore`) for
//! integration tests that need one without writing the restore marker by hand
//! (DR-SRC-12 の試験：取り込みの取り消し・やり直しと復元の組み合わせ)。
//! The canonical restore plan is re-derived here because the product's
//! `build_canonical_restore_plan` is crate-private.

#![allow(dead_code)]

use grimodex_db::project_snapshots::{
    apply_project_snapshot_restore, create_project_snapshot, ApplyProjectSnapshotRestorePayload,
    CreateProjectSnapshotPayload, RestoreScope, SnapshotInsertMode, SnapshotInsertPlan,
    SnapshotRestoreTable,
};
use grimodex_db::Database;
use serde_json::Value;

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

/// Make the project restorable: a restore needs a semantic epoch to advance and
/// a chat session to attribute the restore to.
pub(crate) fn seed_restore_prerequisites(db: &Database, project_id: &str, session_id: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO narrative_semantic_epochs
                 (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', '2026-08-23T00:00:00.000Z')",
            rusqlite::params![format!("epoch-{project_id}"), project_id],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO chat_sessions (id, project_id, title)
             VALUES (?1, ?2, 'Local session')",
            rusqlite::params![session_id, project_id],
        )?;
        Ok(())
    })
    .expect("seed restore prerequisites");
}

/// Snapshot of the live tree / codex / snippet rows (body_version_id = NULL).
/// The aux scopes (events, scene_events, event_participants, ...) are captured
/// by `create_project_snapshot` itself.
pub(crate) fn snapshot(db: &Database, project_id: &str, snapshot_id: &str) {
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
        &[snapshot_id, project_id],
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
        &[snapshot_id, project_id],
    );
    let snippet_rows = json_rows(
        db,
        "SELECT json_object(
            'snapshot_id', ?1, 'snippet_id', id, 'title', title, 'scene_id', scene_id,
            'source_chat_message_id', source_chat_message_id, 'body_version_id', NULL,
            'created_at', created_at, 'updated_at', updated_at)
           FROM snippets WHERE project_id = ?2",
        &[snapshot_id, project_id],
    );
    create_project_snapshot(
        db,
        CreateProjectSnapshotPayload {
            project_id: project_id.to_string(),
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

/// Re-derive the canonical restore plan for the Body and Codex scopes.
fn plan(
    db: &Database,
    project_id: &str,
    snapshot_id: &str,
    scopes: &[RestoreScope],
) -> Vec<SnapshotInsertPlan> {
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
        for row in json_rows(db, sql, &[snapshot_id, project_id]) {
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
    plans
}

/// The real restore. Returns the report's `no_op` flag.
pub(crate) fn restore(
    db: &Database,
    project_id: &str,
    session_id: &str,
    request_id: &str,
    snapshot_id: &str,
    scopes: Vec<RestoreScope>,
) -> anyhow::Result<bool> {
    let inserts = plan(db, project_id, snapshot_id, &scopes);
    let report = apply_project_snapshot_restore(
        db,
        ApplyProjectSnapshotRestorePayload {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            project_id: project_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            scopes,
            inserts,
        },
    )?;
    Ok(report.no_op)
}

/// Write a real restore marker without touching anything a commit made: add a
/// Codex entry, snapshot, edit that entry directly, and restore the Codex scope
/// (the restore changes the edited row back and writes its marker). For the
/// tests that need "a restore happened after this commit" and nothing else
/// (DR-SRC-12 の確かめていない種類の試験)。
pub(crate) fn restore_a_codex_entry_after_snapshot(
    db: &Database,
    project_id: &str,
    session_id: &str,
    tag: &str,
) {
    let entry_id = format!("restore-marker-entry-{tag}");
    let snapshot_id = format!("snap-marker-{tag}");
    seed_restore_prerequisites(db, project_id, session_id);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries
                (id, project_id, type, name, aliases, summary, content, parent_id,
                 version, created_at, updated_at)
             VALUES (?1, ?2, 'character', 'Marker', '[]', 'before', '{}', NULL, 0, 't', 't')",
            rusqlite::params![entry_id, project_id],
        )?;
        Ok(())
    })
    .expect("seed the Codex entry the restore will change");
    snapshot(db, project_id, &snapshot_id);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entries SET summary = 'after the snapshot' WHERE id = ?1",
            rusqlite::params![entry_id],
        )?;
        Ok(())
    })
    .expect("edit the entry after the snapshot");
    let no_op = restore(
        db,
        project_id,
        session_id,
        &format!("restore-marker-{tag}"),
        &snapshot_id,
        vec![RestoreScope::Codex],
    )
    .expect("restore the Codex scope");
    assert!(!no_op, "the restore must change rows and write its marker");
}

/// The same, through the Body scope, for a commit whose rows the Codex scope
/// would also reset (a Codex entry's version goes back to 0 on a Codex
/// restore). Adds a Scene of its own, snapshots, renames it, and restores the
/// Body scope.
pub(crate) fn restore_a_scene_after_snapshot(
    db: &Database,
    project_id: &str,
    session_id: &str,
    tag: &str,
) {
    let scene_id = format!("restore-marker-scene-{tag}");
    let snapshot_id = format!("snap-marker-scene-{tag}");
    seed_restore_prerequisites(db, project_id, session_id);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES (?1, ?2, 'scene', 'before')",
            rusqlite::params![scene_id, project_id],
        )?;
        Ok(())
    })
    .expect("seed the Scene the restore will change");
    snapshot(db, project_id, &snapshot_id);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET title = 'after the snapshot' WHERE id = ?1",
            rusqlite::params![scene_id],
        )?;
        Ok(())
    })
    .expect("rename the scene after the snapshot");
    let no_op = restore(
        db,
        project_id,
        session_id,
        &format!("restore-marker-scene-{tag}"),
        &snapshot_id,
        vec![RestoreScope::Body],
    )
    .expect("restore the Body scope");
    assert!(!no_op, "the restore must change rows and write its marker");
}
