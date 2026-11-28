//! Acceptance tests for the Change Feed continuity check after a project
//! snapshot restore (DR-SRC-1..10, `docs/plans/nir1-lane-decisions/
//! snapshot-restore-feed-continuity-decisions.md`).
//!
//! A restore deletes and re-inserts rows but writes only one project-level
//! marker; the per-object heads of `narrative_change_object_heads` stay where
//! they were. The next write to an object the snapshot changed then used to
//! fail with `NARRATIVE_CHANGE_FEED_DISCONTINUITY` for good, and a Body
//! restore could not be applied a second time. These tests pin what must be
//! repaired and, as important, what must keep failing closed.

use grimodex_db::agent_writes::{
    agent_codex_create_impl, agent_codex_delete_impl, agent_codex_update_impl,
    agent_event_create_with_authority_impl, agent_event_delete_with_authority_impl,
    agent_event_set_participants_with_authority_impl, agent_event_update_with_authority_impl,
    agent_scene_event_mutate_with_authority_impl, agent_undo_journal_impl, AgentCodexCreatePayload,
    AgentCodexDeletePayload, AgentCodexUpdatePayload, AgentEventCreatePayload, AgentEventIdPayload,
    AgentEventParticipantsPayload, AgentEventUpdatePayload, AgentSceneEventPayload,
    AgentUndoJournalPayload, RendererCanonicalWriteContext,
};
use grimodex_db::chronicle_bulk::{
    agent_chronicle_bulk_mutate_with_authority_impl, AgentChronicleBulkPayload,
};
use grimodex_db::domain_writes::{
    tree_node_create, tree_node_delete, tree_node_patch, TreeNodeCreatePayload,
    TreeNodeDeletePayload, TreeNodePatchPayload,
};
use grimodex_db::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};
use grimodex_db::narrative_extraction::{
    read_narrative_scene_scope, update_narrative_scene_scope, NarrativeSceneScopeUpdatePayload,
};
use grimodex_db::project_snapshots::{
    apply_project_snapshot_restore, create_project_snapshot, ApplyProjectSnapshotRestorePayload,
    CreateProjectSnapshotPayload, RestoreScope, SnapshotInsertMode, SnapshotInsertPlan,
    SnapshotRestoreTable,
};
use grimodex_db::scene_body::{save_scene_body_bundle, SaveSceneBodyBundlePayload};
use grimodex_db::{foreshadow, plot_threads, snippet_writes, Database};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

const P: &str = "probe-p1";
const SESSION: &str = "probe-session";
const DISCONTINUITY: &str = "NARRATIVE_CHANGE_FEED_DISCONTINUITY";
const SUPERSEDED: &str = "NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE";

fn de<T: DeserializeOwned>(value: Value) -> anyhow::Result<T> {
    Ok(serde_json::from_value(value)?)
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

fn ver(db: &Database, table: &str, id: &str) -> i64 {
    one_string(
        db,
        &format!("SELECT CAST(version AS TEXT) FROM {table} WHERE id = ?1"),
        &[id],
    )
    .and_then(|v| v.parse().ok())
    .unwrap_or(-1)
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

/// Snapshot of the live tree / codex / snippet rows (body_version_id = NULL).
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

/// Re-derive the canonical restore plan (the crate-private
/// `build_canonical_restore_plan`) for the scopes used here.
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
    plans
}

fn restore(
    db: &Database,
    request_id: &str,
    snapshot_id: &str,
    scopes: Vec<RestoreScope>,
) -> anyhow::Result<String> {
    let inserts = plan(db, snapshot_id, &scopes);
    let r = apply_project_snapshot_restore(
        db,
        ApplyProjectSnapshotRestorePayload {
            request_id: request_id.to_string(),
            session_id: SESSION.to_string(),
            project_id: P.to_string(),
            snapshot_id: snapshot_id.to_string(),
            scopes,
            inserts,
        },
    )?;
    Ok(format!("no_op={}", r.no_op))
}

// ---------- kind: scene (tree_nodes, object_key kind=scene) ----------

fn scene_create(db: &Database, id: &str) -> anyhow::Result<Value> {
    tree_node_create(
        db,
        de::<TreeNodeCreatePayload>(json!({
            "id": id, "projectId": P, "requestId": format!("create-{id}"),
            "sessionId": SESSION, "eventUid": format!("uid-create-{id}"),
            "origin": "human", "parentId": null, "nodeType": "scene",
            "title": "Scene original", "sortOrder": "a0", "synopsis": null,
            "status": null, "sourceUri": null, "sourceMtime": null,
            "content": null
        }))?,
    )
}

fn scene_patch(db: &Database, id: &str, req: &str, title: &str) -> anyhow::Result<Value> {
    tree_node_patch(
        db,
        de::<TreeNodePatchPayload>(json!({
            "projectId": P, "requestId": req, "sessionId": SESSION,
            "eventUid": format!("uid-{req}"), "nodeId": id,
            "patch": { "title": title }, "baseVersion": null, "bumpVersion": false,
            "updatedAt": "2026-08-24T00:00:00.000Z", "changeEvent": null,
            "origin": "human"
        }))?,
    )
}

fn scene_delete(db: &Database, id: &str, req: &str) -> anyhow::Result<Value> {
    tree_node_delete(
        db,
        de::<TreeNodeDeletePayload>(json!({
            "projectId": P, "requestId": req, "sessionId": SESSION,
            "eventUid": format!("uid-{req}"), "origin": "human", "nodeId": id
        }))?,
    )
}

// ---------- kind: codex-entry ----------

fn codex_create(db: &Database, id: &str) -> anyhow::Result<Value> {
    agent_codex_create_impl(
        db,
        de::<AgentCodexCreatePayload>(json!({
            "requestId": format!("create-{id}"), "entryId": id, "projectId": P,
            "sessionId": SESSION, "surface": "manual", "typeSlug": "character",
            "name": "Codex original", "summary": "s", "content": "{}", "aliases": null,
            "parentId": null, "sourceChatMessageId": null, "model": null,
            "chatMessageId": null, "traceId": null, "authorshipSpans": []
        }))?,
    )
}

fn codex_update(db: &Database, id: &str, summary: &str) -> anyhow::Result<Value> {
    let v = ver(db, "codex_entries", id);
    agent_codex_update_impl(
        db,
        de::<AgentCodexUpdatePayload>(json!({
            "projectId": P, "sessionId": SESSION, "surface": "codex-editor",
            "entryId": id, "baseVersion": v, "summary": summary, "name": null,
            "content": null, "aliases": null, "model": null, "chatMessageId": null,
            "traceId": null, "authorshipSpans": null, "authorshipSpanLanes": null
        }))?,
    )
}

fn codex_delete(db: &Database, id: &str) -> anyhow::Result<Value> {
    let v = ver(db, "codex_entries", id);
    agent_codex_delete_impl(
        db,
        de::<AgentCodexDeletePayload>(json!({
            "projectId": P, "sessionId": SESSION, "surface": "codex-editor",
            "entryId": id, "baseVersion": v
        }))?,
    )
}

// ---------- kind: snippet (component snippet:<id>) ----------

fn snippet_ctx(req: &str) -> Value {
    json!({
        "requestId": req, "sessionId": format!("session:{req}"),
        "eventUid": format!("event:{req}"), "origin": "human",
        "authorityRoute": "human-direct", "caller": "human-ui",
        "controls": ["runtime-policy","actor-context","typed-writer","occ","change-event","change-feed"],
        "writesAuthorityProtectedField": false, "originalTransactionId": null,
        "undoJournalId": null, "projectId": P
    })
}

fn snippet_merge(mut ctx: Value, extra: Value) -> Value {
    ctx.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    ctx
}

fn snippet_create(db: &Database, id: &str) -> anyhow::Result<Value> {
    snippet_writes::create(
        db,
        de(snippet_merge(
            snippet_ctx(&format!("create-{id}")),
            json!({"snippetId": id, "title": "Snippet original", "content": "{\"type\":\"doc\"}",
                   "tagsCache": null, "contentSource": "human", "sceneId": null,
                   "sourceChatMessageId": null,
                   "canonicalPayload": {"title": "Snippet original"}}),
        ))?,
    )
}

fn snippet_update(db: &Database, id: &str, req: &str, title: &str) -> anyhow::Result<Value> {
    let v = ver(db, "snippets", id);
    snippet_writes::update(
        db,
        de(snippet_merge(
            snippet_ctx(req),
            json!({"snippetId": id, "baseVersion": v, "title": title,
                   "canonicalPayload": {"fields": ["title"]}}),
        ))?,
    )
}

fn snippet_delete(db: &Database, id: &str, req: &str) -> anyhow::Result<Value> {
    let v = ver(db, "snippets", id);
    snippet_writes::delete(
        db,
        de(snippet_merge(
            snippet_ctx(req),
            json!({"snippetId": id, "baseVersion": v, "canonicalPayload": {"title": "x"}}),
        ))?,
    )
}

// ---------- kind: plot-thread ----------

fn renderer_ctx(req: &str) -> Value {
    json!({"requestId": req, "sessionId": "renderer-session",
           "eventUid": format!("uid-{req}"), "origin": "human", "projectId": P})
}

fn plot_create(db: &Database, id: &str) -> anyhow::Result<Value> {
    let mut v = renderer_ctx(&format!("create-{id}"));
    v.as_object_mut().unwrap().extend(
        json!({"id": id, "name": "Thread original", "sortOrder": "a0"})
            .as_object()
            .unwrap()
            .clone(),
    );
    plot_threads::create(db, de(v)?)
}

fn plot_update(db: &Database, id: &str, req: &str, name: &str) -> anyhow::Result<Value> {
    let bv = ver(db, "plot_threads", id);
    let mut v = renderer_ctx(req);
    v.as_object_mut().unwrap().extend(
        json!({"baseVersion": bv, "name": name})
            .as_object()
            .unwrap()
            .clone(),
    );
    plot_threads::update(db, id.to_string(), de(v)?)
}

fn plot_delete(db: &Database, id: &str, req: &str) -> anyhow::Result<Value> {
    let bv = ver(db, "plot_threads", id);
    let mut v = renderer_ctx(req);
    v.as_object_mut().unwrap().extend(
        json!({"id": id, "baseVersion": bv})
            .as_object()
            .unwrap()
            .clone(),
    );
    plot_threads::delete(db, de(v)?)
}

// ---------- kind: foreshadow ----------

fn fs_create(db: &Database, id: &str) -> anyhow::Result<Value> {
    let mut v = renderer_ctx(&format!("create-{id}"));
    v.as_object_mut().unwrap().extend(
        json!({"id": id, "title": "Foreshadow original"})
            .as_object()
            .unwrap()
            .clone(),
    );
    foreshadow::create(db, de(v)?)
}

fn fs_update(db: &Database, id: &str, req: &str, title: &str) -> anyhow::Result<Value> {
    let bv = ver(db, "foreshadows", id);
    let mut v = renderer_ctx(req);
    v.as_object_mut().unwrap().extend(
        json!({"baseVersion": bv, "title": title})
            .as_object()
            .unwrap()
            .clone(),
    );
    foreshadow::update(db, id.to_string(), de(v)?)
}

fn fs_delete(db: &Database, id: &str, req: &str) -> anyhow::Result<Value> {
    let bv = ver(db, "foreshadows", id);
    let mut v = renderer_ctx(req);
    v.as_object_mut().unwrap().extend(
        json!({"id": id, "baseVersion": bv})
            .as_object()
            .unwrap()
            .clone(),
    );
    foreshadow::delete(db, de(v)?)
}

// ---------- kind: chronicle-event with participants / scene links ----------

fn ev_create(db: &Database, id: &str, scene: &str, codex: &str) -> anyhow::Result<Value> {
    agent_event_create_with_authority_impl(
        db,
        de::<AgentEventCreatePayload>(json!({
            "startTime": 0, "startGranularity": "day",
            "requestId": format!("create-{id}"), "eventId": id, "projectId": P,
            "sessionId": SESSION, "surface": "manual", "title": "Event original",
            "ordinal": "a0", "kind": "generic",
            "participantCodexIds": [codex], "sceneIds": [scene]
        }))?,
        Some(human_context(&format!("create-{id}"))),
    )
}

fn ev_update(db: &Database, id: &str, req: &str, title: &str) -> anyhow::Result<Value> {
    let bv = ver(db, "events", id);
    agent_event_update_with_authority_impl(
        db,
        de::<AgentEventUpdatePayload>(json!({
            "projectId": P, "sessionId": SESSION, "surface": "manual",
            "eventId": id, "baseVersion": bv, "title": title
        }))?,
        human_context(req),
    )
}

fn ev_delete(db: &Database, id: &str, req: &str) -> anyhow::Result<Value> {
    let bv = ver(db, "events", id);
    agent_event_delete_with_authority_impl(
        db,
        de::<AgentEventIdPayload>(json!({
            "projectId": P, "sessionId": SESSION, "surface": "manual",
            "eventId": id, "baseVersion": bv
        }))?,
        human_context(req),
    )
}

fn ev_participants(db: &Database, id: &str, req: &str, codex: &[&str]) -> anyhow::Result<Value> {
    let bv = ver(db, "events", id);
    agent_event_set_participants_with_authority_impl(
        db,
        de::<AgentEventParticipantsPayload>(json!({
            "projectId": P, "sessionId": SESSION, "surface": "manual",
            "eventId": id, "baseVersion": bv, "codexEntryIds": codex
        }))?,
        human_context(req),
    )
}

fn ev_scene_link(
    db: &Database,
    id: &str,
    scene: &str,
    req: &str,
    link: bool,
) -> anyhow::Result<Value> {
    // mutate payload has no explicit link/unlink flag; the writer toggles by
    // presence. Print which op it does through the result.
    agent_scene_event_mutate_with_authority_impl(
        db,
        de::<AgentSceneEventPayload>(json!({
            "requestId": req, "projectId": P, "sessionId": SESSION, "surface": "manual",
            "sceneId": scene, "eventId": id
        }))?,
        link,
        Some(human_context(req)),
    )
}

fn scene_scope_edit(db: &Database, scene: &str, req: &str) -> anyhow::Result<Value> {
    let current = db.with_read_transaction(|conn| read_narrative_scene_scope(conn, P, scene))?;
    let mut scope = json!({
        "schemaVersion": current.binding.schema_version,
        "compatibilityMarker": current.binding.compatibility_marker,
        "queryIdentity": current.binding.query_identity,
        "materialConstraint": current.binding.material_constraint,
        "knowledgeHolder": current.binding.knowledge_holder,
        "audience": current.binding.audience,
    });
    scope["compatibilityMarker"] = json!("unknown");
    let unresolved = json!({"kind":"unresolved","reason":"legacy-axis-unknown"});
    for axis in ["timeline", "worldline", "narrativeLayer"] {
        scope["queryIdentity"][axis] = unresolved.clone();
    }
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: P.to_string(),
            scene_id: scene.to_string(),
            request_id: req.to_string(),
            session_id: SESSION.to_string(),
            event_uid: format!("uid-{req}"),
            base_version: current.binding.version,
            updated_at: "2026-08-24T00:00:00.000Z".to_string(),
            scope: serde_json::from_value(scope)?,
        },
    )
}

fn undo_replay(db: &Database, journal_id: &str, direction: &str) -> anyhow::Result<Value> {
    agent_undo_journal_impl(
        db,
        AgentUndoJournalPayload {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: P.to_string(),
            session_id: SESSION.to_string(),
            journal_id: journal_id.to_string(),
            direction: direction.to_string(),
            authority_route: "history-replay".to_string(),
            origin: direction.to_string(),
            caller: "undo-redo-command".to_string(),
            controls: [
                "original-transaction",
                "journal-lineage",
                "typed-writer",
                "occ",
                "change-event",
                "change-feed",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
    )
}

fn bare_event_create(db: &Database, rid: &str, eid: &str, title: &str) -> anyhow::Result<Value> {
    agent_event_create_with_authority_impl(
        db,
        de::<AgentEventCreatePayload>(json!({
            "startTime": 0, "startGranularity": "day",
            "requestId": rid, "eventId": eid, "projectId": P,
            "sessionId": SESSION, "surface": "manual", "title": title,
            "ordinal": "a0", "kind": "generic",
        }))?,
        Some(human_context(rid)),
    )
}

fn calendar_upsert(
    db: &Database,
    req: &str,
    base: Option<i64>,
    days: i64,
) -> anyhow::Result<Option<grimodex_db::chronicle::ProjectCalendarRow>> {
    grimodex_db::chronicle::upsert_project_calendar(
        db,
        de(json!({
            "projectId": P, "requestId": req, "sessionId": SESSION, "eventUid": format!("uid-{req}"),
            "daysPerYear": days, "seasonBoundaries": "[]", "startYear": 1, "months": "[]",
            "weekdayNames": "[]", "weekdayStartIndex": 0, "leapRule": "none",
            "ageReckoning": "birthday", "eras": "[]", "reform": "none", "timezone": "UTC",
            "lunarTzMinutes": 0, "baseVersion": base, "updatedAt": "2026-08-24T00:00:00.000Z"
        }))?,
    )
}

// =====================================================================
// Helpers of this test
// =====================================================================

fn must<T>(r: anyhow::Result<T>, what: &str) -> T {
    r.unwrap_or_else(|e| panic!("{what}: unexpected error: {e}"))
}

fn must_fail_with<T>(r: anyhow::Result<T>, code: &str, what: &str) {
    match r {
        Ok(_) => panic!("{what}: unexpectedly succeeded (expected {code})"),
        Err(e) => assert!(
            e.to_string().contains(code),
            "{what}: expected {code}, got: {e}"
        ),
    }
}

fn body(db: &Database, rid: &str, snap: &str) -> anyhow::Result<String> {
    restore(db, rid, snap, vec![RestoreScope::Body])
}

fn scalar(db: &Database, sql: &str) -> Option<i64> {
    use rusqlite::OptionalExtension;
    db.with_conn(|conn| {
        Ok(conn
            .query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .optional()?
            .flatten())
    })
    .expect("scalar")
}

const MARKER_TXN: &str = "SELECT t.source_change_event_sequence
       FROM narrative_change_transactions t
      WHERE t.origin = 'restore' AND t.source_domain = 'project.snapshot.restore'
        AND EXISTS (SELECT 1 FROM narrative_change_events m
                     WHERE m.transaction_id = t.id
                       AND json_extract(m.object_key_json, '$.kind') = 'project'
                       AND json_extract(m.structural_impact_json, '$.event') = 'project-restored')";

/// Sequence of the newest project-restored marker written by a real restore.
fn latest_marker(db: &Database) -> Option<i64> {
    scalar(
        db,
        &format!("SELECT max(source_change_event_sequence) FROM ({MARKER_TXN})"),
    )
}

fn marker_count(db: &Database) -> i64 {
    scalar(db, &format!("SELECT count(*) FROM ({MARKER_TXN})")).unwrap_or(0)
}

/// `canonical_sequence` of the head of the object whose identity contains
/// `needle`.
fn head_sequence(db: &Database, needle: &str) -> i64 {
    head_seq(db, needle).unwrap_or_else(|| panic!("no head for {needle}"))
}

fn head_seq(db: &Database, needle: &str) -> Option<i64> {
    use rusqlite::OptionalExtension;
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT canonical_sequence FROM narrative_change_object_heads
                  WHERE project_id = ?1 AND object_identity LIKE ?2
                  ORDER BY canonical_sequence DESC LIMIT 1",
                rusqlite::params![P, format!("%{needle}%")],
                |r| r.get::<_, i64>(0),
            )
            .optional()?)
    })
    .expect("head seq")
}

/// The restore wrote its marker but left the object's head behind: the state
/// the product is in right after a restore (and the broken state of a work
/// that was restored by an earlier version).
fn assert_head_is_stale(db: &Database, needle: &str) {
    let marker = latest_marker(db).expect("the restore wrote its marker");
    assert!(
        head_sequence(db, needle) < marker,
        "head of {needle} must predate the restore marker (precondition)"
    );
}

/// After a write that went through the exemption the head follows the row and
/// is newer than the marker, so the exemption no longer applies.
fn assert_head_is_fresh(db: &Database, needle: &str) {
    let marker = latest_marker(db).expect("the restore wrote its marker");
    assert!(
        head_sequence(db, needle) > marker,
        "head of {needle} must be newer than the restore marker after the write"
    );
}

type State = (Option<i64>, Option<String>);

/// (binding version, digest) of the live Scene Scope row, computed as the
/// ordinary Scope writer does.
fn live_state(db: &Database, scene: &str) -> Option<State> {
    db.with_read_transaction(|conn| {
        Ok(read_narrative_scene_scope(conn, P, scene).ok().map(|read| {
            let version = read.binding.version;
            let value = serde_json::to_value(&read).expect("scope snapshot");
            (
                Some(version),
                Some(narrative_snapshot_digest(&value).expect("digest")),
            )
        }))
    })
    .expect("live state")
}

fn scope_head(db: &Database, scene: &str) -> Option<State> {
    use rusqlite::OptionalExtension;
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT after_version, after_digest FROM narrative_change_object_heads
                  WHERE project_id = ?1
                    AND json_extract(object_identity,'$.kind') = 'scene-scope'
                    AND json_extract(object_identity,'$.sceneId') = ?2",
                rusqlite::params![P, scene],
                |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?)
    })
    .expect("scope head")
}

fn tamper_event_row(db: &Database, id: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE events SET title = 'changed outside the Change Feed' WHERE id = ?1",
            [id],
        )?;
        Ok(())
    })
    .expect("tamper");
}

fn fake_digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

/// A restore-shaped (or any other) feed transaction appended through the
/// public API in `project`.
fn append_batch(
    db: &Database,
    project: &str,
    tag: &str,
    origin: NarrativeChangeOrigin,
    source_domain: &str,
    events: Vec<NarrativeChangeEventInput>,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let uid = format!("uid-{project}-{tag}");
        let r = append_canonical_and_narrative_change_in_tx(
            conn,
            project,
            &session_of(project),
            &grimodex_db::change_events::AppendChangeEvent {
                event_uid: uid.clone(),
                scene_id: None,
                domain: "revision".to_string(),
                op_type: source_domain.to_string(),
                entity_type: Some("project_snapshot".to_string()),
                entity_id: Some(tag.to_string()),
                payload: "{\"scopes\":[\"body\"]}".to_string(),
                timestamp: 1_786_000_000_000,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: project.to_string(),
                request_id: format!("req-{project}-{tag}"),
                source_domain: source_domain.to_string(),
                source_change_event_uid: uid,
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: vec![],
                occurred_at: "2026-11-22T00:00:00.000Z".to_string(),
                events,
            },
        );
        match r {
            Ok(_) => {
                conn.execute_batch("COMMIT")?;
                Ok(Ok(()))
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK")?;
                Ok(Err(e))
            }
        }
    })
    .expect("with_conn")
}

fn marker_event(project: &str, event: &str) -> NarrativeChangeEventInput {
    NarrativeChangeEventInput {
        object_key: json!({ "kind": "project", "projectId": project }),
        change_kind: "schema".to_string(),
        mutation_kind: "update".to_string(),
        before_version: None,
        before_digest: Some(fake_digest('a')),
        after_version: None,
        after_digest: Some(fake_digest('b')),
        changed_paths: vec!["/".to_string()],
        text_impact: None,
        structural_impact: Some(json!({ "event": event, "requiresFullRebuild": true })),
    }
}

/// An object kind that no restore scope owns: a Scope registry of the project.
fn registry_event(project: &str, before: Option<char>, after: char) -> NarrativeChangeEventInput {
    NarrativeChangeEventInput {
        object_key: json!({ "kind": "scope-registry", "projectId": project }),
        change_kind: "metadata".to_string(),
        mutation_kind: "update".to_string(),
        before_version: None,
        before_digest: before.map(fake_digest),
        after_version: None,
        after_digest: Some(fake_digest(after)),
        changed_paths: vec!["/".to_string()],
        text_impact: None,
        structural_impact: None,
    }
}

fn scope_event(
    scene: &str,
    before: Option<&State>,
    after: (i64, &str),
) -> NarrativeChangeEventInput {
    NarrativeChangeEventInput {
        object_key: json!({ "kind": "scene-scope", "sceneId": scene }),
        change_kind: "metadata".to_string(),
        mutation_kind: "update".to_string(),
        before_version: before.and_then(|b| b.0),
        before_digest: before.and_then(|b| b.1.clone()),
        after_version: Some(after.0),
        after_digest: Some(after.1.to_string()),
        changed_paths: vec!["/binding/version".to_string()],
        text_impact: None,
        structural_impact: Some(json!({
            "changedPaths": ["/binding/version"],
            "scopeAuthorityChanged": true,
        })),
    }
}

const SYNTHETIC: &str = "test.synthetic";

fn seed_registry_head(db: &Database, project: &str) {
    must(
        append_batch(
            db,
            project,
            "seed",
            NarrativeChangeOrigin::Human,
            SYNTHETIC,
            vec![NarrativeChangeEventInput {
                mutation_kind: "create".to_string(),
                ..registry_event(project, None, 'c')
            }],
        ),
        "seed the synthetic head",
    );
}

/// A mismatching write of the synthetic object: its before is not the head.
fn stale_registry_write(db: &Database, project: &str, tag: &str) -> anyhow::Result<()> {
    append_batch(
        db,
        project,
        tag,
        NarrativeChangeOrigin::Human,
        SYNTHETIC,
        vec![registry_event(project, Some('z'), 'd')],
    )
}

fn forge_marker(
    db: &Database,
    project: &str,
    tag: &str,
    origin: NarrativeChangeOrigin,
    source_domain: &str,
    marker: &str,
) -> anyhow::Result<()> {
    append_batch(
        db,
        project,
        tag,
        origin,
        source_domain,
        vec![marker_event(project, marker)],
    )
}

fn session_of(project: &str) -> String {
    if project == P {
        SESSION.to_string()
    } else {
        format!("{project}-session")
    }
}

fn add_second_project(db: &Database, project: &str) {
    db.with_conn(|conn| {
        conn.execute_batch(&format!(
            "INSERT INTO projects (id, title) VALUES ('{project}', 'Two');
             INSERT INTO chat_sessions (id, project_id, title)
               VALUES ('{}', '{project}', 'Second');",
            session_of(project)
        ))?;
        Ok(())
    })
    .expect("second project");
}

// =====================================================================
// Must be repaired: a restore must not leave an object that the snapshot
// changed unwritable
// =====================================================================

#[test]
fn n4a_snapshot_restore_keeps_the_undated_row_until_the_next_forward_edit() {
    let db = new_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO events (id, project_id, title, precision)
                      VALUES ('legacy', ?1, 'before', 'exact')",
            [P],
        )?;
        Ok(())
    })
    .unwrap();
    snapshot(&db, "undated");
    let date = || {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT start_time, precision FROM events WHERE id = 'legacy'",
                [],
                |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?)),
            )?)
        })
        .unwrap()
    };
    must(
        ev_update(&db, "legacy", "date-first", "first"),
        "first edit",
    );
    assert!(date().0.is_some());
    must(body(&db, "restore-undated", "undated"), "restore");
    assert_eq!(date(), (None, "exact".into()));
    must(
        ev_update(&db, "legacy", "date-second", "second"),
        "edit after restore",
    );
    assert!(date().0.is_some());
}

#[test]
fn event_edited_after_the_snapshot_can_be_updated_and_deleted_after_the_restore() {
    for last in ["update", "delete"] {
        let db = new_db();
        must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
        snapshot(&db, "S1");
        must(ev_update(&db, "e1", "edit-1", "edited"), "edit");
        must(body(&db, "r1", "S1"), "restore");
        assert_head_is_stale(&db, "e1");
        match last {
            "update" => {
                must(
                    ev_update(&db, "e1", "post-1", "after"),
                    "update after restore",
                );
                assert_head_is_fresh(&db, "e1");
                // The next write needs no exemption: the head now follows the row.
                must(ev_update(&db, "e1", "post-2", "again"), "second update");
            }
            _ => {
                must(ev_delete(&db, "e1", "post-del"), "delete after restore");
                assert_head_is_fresh(&db, "e1");
            }
        }
    }
}

#[test]
fn event_deleted_after_the_snapshot_can_be_updated_and_deleted_after_the_restore() {
    for last in ["update", "delete"] {
        let db = new_db();
        must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
        snapshot(&db, "S1");
        must(ev_delete(&db, "e1", "del-1"), "delete");
        must(body(&db, "r1", "S1"), "restore brings the event back");
        assert_eq!(ver(&db, "events", "e1"), 1, "the event is back");
        match last {
            "update" => {
                must(
                    ev_update(&db, "e1", "post-1", "after"),
                    "update after restore",
                );
                must(ev_update(&db, "e1", "post-2", "again"), "second update");
            }
            _ => {
                must(ev_delete(&db, "e1", "post-del"), "delete after restore");
            }
        }
    }
}

#[test]
fn event_with_participants_and_scene_links_is_writable_after_the_restore() {
    let db = new_db();
    must(codex_create(&db, "c1"), "codex");
    must(scene_create(&db, "s1"), "scene");
    must(ev_create(&db, "e1", "s1", "c1"), "event with links");
    snapshot(&db, "S1");
    must(ev_update(&db, "e1", "edit-1", "edited"), "edit");
    must(body(&db, "r1", "S1"), "restore");
    must(ev_update(&db, "e1", "post-1", "after"), "update");
    must(
        ev_participants(&db, "e1", "post-2", &["c1"]),
        "set participants",
    );
    must(
        ev_scene_link(&db, "e1", "s1", "post-3", false),
        "unlink the scene",
    );
    must(
        ev_scene_link(&db, "e1", "s1", "post-4", true),
        "link the scene",
    );
    must(ev_delete(&db, "e1", "post-5"), "delete");
}

#[test]
fn event_stays_writable_across_snapshot_restore_snapshot_restore() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    snapshot(&db, "S1");
    must(ev_update(&db, "e1", "edit-1", "edited"), "edit");
    must(body(&db, "r1", "S1"), "first restore");
    snapshot(&db, "S2");
    must(
        ev_update(&db, "e1", "edit-2", "edited again"),
        "edit after the first restore",
    );
    must(body(&db, "r2", "S2"), "second restore");
    assert_head_is_stale(&db, "e1");
    must(
        ev_update(&db, "e1", "edit-3", "after the second restore"),
        "edit after the second",
    );
    assert_eq!(marker_count(&db), 2);
}

#[test]
fn only_the_object_the_snapshot_changed_needs_the_exemption() {
    let db = new_db();
    must(
        bare_event_create(&db, "create-e1", "e1", "orig"),
        "create e1",
    );
    must(
        bare_event_create(&db, "create-e2", "e2", "orig"),
        "create e2",
    );
    snapshot(&db, "S1");
    must(ev_update(&db, "e1", "edit-1", "edited"), "edit e1 only");
    must(body(&db, "r1", "S1"), "restore");
    // e2 was not touched since the snapshot: its head already matches.
    must(ev_update(&db, "e2", "post-2", "after"), "update e2");
    must(ev_update(&db, "e1", "post-1", "after"), "update e1");
}

#[test]
fn scene_edited_or_deleted_after_the_snapshot_is_writable_after_the_restore() {
    // Edited after the snapshot.
    let db = new_db();
    must(scene_create(&db, "s1"), "create");
    snapshot(&db, "S1");
    must(scene_patch(&db, "s1", "edit-1", "edited"), "edit");
    must(body(&db, "r1", "S1"), "restore");
    must(scene_patch(&db, "s1", "post-1", "after"), "patch the title");
    must(scene_patch(&db, "s1", "post-2", "again"), "patch again");
    must(scene_delete(&db, "s1", "post-del"), "delete");
    // Deleted after the snapshot.
    let db = new_db();
    must(scene_create(&db, "s1"), "create");
    snapshot(&db, "S1");
    must(scene_delete(&db, "s1", "del-1"), "delete");
    must(body(&db, "r1", "S1"), "restore brings the scene back");
    must(scene_patch(&db, "s1", "post-1", "after"), "patch");
    must(scene_delete(&db, "s1", "post-del"), "delete");
}

#[test]
fn codex_entry_edited_or_deleted_after_the_snapshot_is_writable_after_the_restore() {
    let db = new_db();
    must(codex_create(&db, "c1"), "create");
    snapshot(&db, "S1");
    must(codex_update(&db, "c1", "edited"), "edit");
    must(
        restore(&db, "r1", "S1", vec![RestoreScope::Codex]),
        "restore",
    );
    must(codex_update(&db, "c1", "after"), "update");
    must(codex_update(&db, "c1", "again"), "update again");
    must(codex_delete(&db, "c1"), "delete");
    let db = new_db();
    must(codex_create(&db, "c1"), "create");
    snapshot(&db, "S1");
    must(codex_delete(&db, "c1"), "delete");
    must(
        restore(&db, "r1", "S1", vec![RestoreScope::Codex]),
        "restore brings it back",
    );
    must(codex_update(&db, "c1", "after"), "update");
    must(codex_delete(&db, "c1"), "delete");
}

#[test]
fn snippet_edited_or_deleted_after_the_snapshot_is_writable_after_the_restore() {
    let db = new_db();
    must(snippet_create(&db, "sn1"), "create");
    snapshot(&db, "S1");
    must(snippet_update(&db, "sn1", "edit-1", "edited"), "edit");
    must(
        restore(&db, "r1", "S1", vec![RestoreScope::Snippet]),
        "restore",
    );
    must(snippet_update(&db, "sn1", "post-1", "after"), "update");
    must(
        snippet_update(&db, "sn1", "post-2", "again"),
        "update again",
    );
    must(snippet_delete(&db, "sn1", "post-del"), "delete");
    let db = new_db();
    must(snippet_create(&db, "sn1"), "create");
    snapshot(&db, "S1");
    must(snippet_delete(&db, "sn1", "del-1"), "delete");
    must(
        restore(&db, "r1", "S1", vec![RestoreScope::Snippet]),
        "restore brings it back",
    );
    must(snippet_update(&db, "sn1", "post-1", "after"), "update");
    must(snippet_delete(&db, "sn1", "post-del"), "delete");
}

#[test]
fn project_calendar_edited_after_the_snapshot_is_writable_after_the_restore() {
    let db = new_db();
    must(calendar_upsert(&db, "cal-create", None, 360), "create");
    snapshot(&db, "S1");
    must(calendar_upsert(&db, "cal-edit", Some(1), 365), "edit");
    must(body(&db, "r1", "S1"), "restore");
    let version = scalar(&db, "SELECT version FROM project_calendar").expect("calendar row");
    must(
        calendar_upsert(&db, "cal-post", Some(version), 400),
        "update after restore",
    );
}

// ---- scope-crossing cascades: the exemption must not be narrowed by the
// restored scope ----

#[test]
fn codex_only_restore_keeps_the_participants_and_leaves_the_event_writable() {
    let db = new_db();
    must(codex_create(&db, "c1"), "codex c1");
    must(codex_create(&db, "c2"), "codex c2");
    must(
        agent_event_create_with_authority_impl(
            &db,
            de::<AgentEventCreatePayload>(json!({
                "startTime": 0, "startGranularity": "day",
                "requestId": "create-e1", "eventId": "e1", "projectId": P,
                "sessionId": SESSION, "surface": "manual", "title": "orig",
                "ordinal": "a0", "kind": "generic", "participantCodexIds": ["c1", "c2"],
            }))
            .unwrap(),
            Some(human_context("create-e1")),
        ),
        "event with participants",
    );
    snapshot(&db, "S1");
    must(codex_update(&db, "c1", "edited"), "edit codex");
    must(
        restore(&db, "r1", "S1", vec![RestoreScope::Codex]),
        "codex-only restore",
    );
    // DR-SRX-14: the restore used to delete the participants (the foreign key
    // cascades from the Codex rows it replaces). The links of the Body scope
    // are set aside and put back now, so both participants are still there.
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM event_participants WHERE event_id = 'e1'"
        ),
        Some(2),
        "the participants survive a Codex-only restore"
    );
    assert_head_is_stale(&db, "e1");
    must(
        ev_update(&db, "e1", "post-1", "after"),
        "event update after the codex restore",
    );
}

#[test]
fn body_only_restore_that_detaches_a_snippet_leaves_the_snippet_writable() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    must(
        snippet_writes::create(
            &db,
            de(snippet_merge(
                snippet_ctx("create-sn1"),
                json!({"snippetId": "sn1", "title": "Snippet original",
                       "content": "{\"type\":\"doc\"}", "tagsCache": null,
                       "contentSource": "human", "sceneId": "s1",
                       "sourceChatMessageId": null,
                       "canonicalPayload": {"title": "Snippet original"}}),
            ))
            .unwrap(),
        ),
        "snippet attached to the scene",
    );
    snapshot(&db, "S1");
    must(
        scene_patch(&db, "s1", "edit-s1", "edited"),
        "edit the scene",
    );
    must(body(&db, "r1", "S1"), "body-only restore");
    must(
        snippet_update(&db, "sn1", "post-1", "after"),
        "snippet update",
    );
}

// ---- already-broken works repair themselves; the repair is one-shot ----

#[test]
fn an_already_restored_work_is_repaired_by_its_next_write_and_then_strict_again() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    snapshot(&db, "S1");
    must(ev_update(&db, "e1", "edit-1", "edited"), "edit");
    must(
        body(&db, "r1", "S1"),
        "restore (the head stays where it was)",
    );
    assert_head_is_stale(&db, "e1");
    must(
        ev_update(&db, "e1", "post-1", "repairs"),
        "the next write repairs",
    );
    assert_head_is_fresh(&db, "e1");
    // The exemption was used once. A row change that bypassed the feed now
    // stops the next write again.
    tamper_event_row(&db, "e1");
    must_fail_with(
        ev_update(&db, "e1", "post-2", "x"),
        DISCONTINUITY,
        "a mismatch after the exemption was spent",
    );
}

// =====================================================================
// Must keep failing closed
// =====================================================================

#[test]
fn without_a_restore_a_mismatch_still_stops_the_write() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    tamper_event_row(&db, "e1");
    assert_eq!(marker_count(&db), 0);
    must_fail_with(
        ev_update(&db, "e1", "u1", "x"),
        DISCONTINUITY,
        "no restore history",
    );
}

#[test]
fn a_mismatch_after_a_write_that_followed_the_restore_still_stops() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    snapshot(&db, "S1");
    must(ev_update(&db, "e1", "edit-1", "edited"), "edit");
    must(body(&db, "r1", "S1"), "restore");
    must(
        ev_update(&db, "e1", "post-1", "after"),
        "first write after the restore",
    );
    tamper_event_row(&db, "e1");
    must_fail_with(
        ev_update(&db, "e1", "post-2", "x"),
        DISCONTINUITY,
        "object written after the marker",
    );
}

#[test]
fn a_restore_marker_of_another_project_does_not_exempt() {
    let db = new_db();
    add_second_project(&db, "other-p2");
    seed_registry_head(&db, "other-p2");
    // Project P gets a restore-shaped marker newer than the other head.
    must(
        forge_marker(
            &db,
            P,
            "m1",
            NarrativeChangeOrigin::Restore,
            "project.snapshot.restore",
            "project-restored",
        ),
        "marker in P",
    );
    must_fail_with(
        stale_registry_write(&db, "other-p2", "w"),
        DISCONTINUITY,
        "marker of another project",
    );
}

#[test]
fn markers_with_another_origin_domain_or_event_do_not_exempt() {
    let cases = [
        (
            "human",
            NarrativeChangeOrigin::Human,
            "project.snapshot.restore",
            "project-restored",
        ),
        (
            "migration",
            NarrativeChangeOrigin::Migration,
            "project.snapshot.restore",
            "project-restored",
        ),
        (
            "renderer-scene-restore",
            NarrativeChangeOrigin::Restore,
            "revision.scene.restore.renderer",
            "project-restored",
        ),
        (
            "epoch-reset",
            NarrativeChangeOrigin::Restore,
            "project.snapshot.restore",
            "semantic-epoch-reset",
        ),
    ];
    for (tag, origin, domain, marker) in cases {
        let db = new_db();
        seed_registry_head(&db, P);
        // Whatever happens to the append, no transaction of this shape may
        // exempt a stale head afterwards.
        let _ = forge_marker(&db, P, tag, origin, domain, marker);
        must_fail_with(stale_registry_write(&db, P, "w"), DISCONTINUITY, tag);
    }
}

#[test]
fn a_kind_no_scope_owns_is_exempt_only_when_its_head_predates_the_marker() {
    let db = new_db();
    seed_registry_head(&db, P);
    must(
        forge_marker(
            &db,
            P,
            "m1",
            NarrativeChangeOrigin::Restore,
            "project.snapshot.restore",
            "project-restored",
        ),
        "a marker of the shape the restore writes",
    );
    must(
        stale_registry_write(&db, P, "w1"),
        "head older than the marker",
    );
    must_fail_with(
        stale_registry_write(&db, P, "w2"),
        DISCONTINUITY,
        "head newer than the marker",
    );
}

#[test]
fn a_second_mismatching_event_of_the_same_batch_is_not_exempt() {
    let db = new_db();
    seed_registry_head(&db, P);
    must(
        forge_marker(
            &db,
            P,
            "m1",
            NarrativeChangeOrigin::Restore,
            "project.snapshot.restore",
            "project-restored",
        ),
        "marker",
    );
    must_fail_with(
        append_batch(
            &db,
            P,
            "batch-bad",
            NarrativeChangeOrigin::Human,
            SYNTHETIC,
            vec![
                registry_event(P, Some('y'), 'd'),
                registry_event(P, Some('z'), 'e'),
            ],
        ),
        DISCONTINUITY,
        "second event of the batch does not chain from the first",
    );
    must(
        append_batch(
            &db,
            P,
            "batch-ok",
            NarrativeChangeOrigin::Human,
            SYNTHETIC,
            vec![
                registry_event(P, Some('y'), 'd'),
                registry_event(P, Some('d'), 'e'),
            ],
        ),
        "a chained batch passes (the first event used the exemption)",
    );
}

#[test]
fn the_public_append_gives_a_restore_shaped_batch_no_scene_scope_exemption() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    must(scene_scope_edit(&db, "s1", "scope-1"), "scope edit");
    let stale: State = (Some(1), Some(fake_digest('a')));
    must_fail_with(
        append_batch(
            &db,
            P,
            "restore-shaped",
            NarrativeChangeOrigin::Restore,
            "project.snapshot.restore",
            vec![scope_event("s1", Some(&stale), (2, &fake_digest('b')))],
        ),
        DISCONTINUITY,
        "pub append never exempts scene-scope",
    );
}

// =====================================================================
// The second Body restore (DEF-1)
// =====================================================================

fn binding_version(db: &Database, scene: &str) -> i64 {
    live_state(db, scene)
        .and_then(|s| s.0)
        .expect("scene scope binding")
}

#[test]
fn body_restore_of_a_scene_with_a_scope_history_succeeds() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    must(scene_scope_edit(&db, "s1", "scope-1"), "scope edit");
    assert_eq!(binding_version(&db, "s1"), 2);
    snapshot(&db, "S1");
    must(scene_patch(&db, "s1", "edit-1", "edited"), "edit");
    must(body(&db, "r1", "S1"), "restore must not hit DISCONTINUITY");
    assert_eq!(marker_count(&db), 1);
    assert_eq!(binding_version(&db, "s1"), 2);
    assert_eq!(scope_head(&db, "s1"), live_state(&db, "s1"));
    // An ordinary Scope edit chains from the restored state.
    must(
        scene_scope_edit(&db, "s1", "scope-2"),
        "scope edit after the restore",
    );
    assert_eq!(binding_version(&db, "s1"), 3);
}

#[test]
fn a_one_scene_work_can_be_restored_twice() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    snapshot(&db, "S1");
    must(scene_patch(&db, "s1", "edit-1", "edited"), "edit");
    must(body(&db, "r1", "S1"), "first restore");
    // Nothing changed: the second restore is a net no-op for the Body.
    must(
        body(&db, "r2", "S1"),
        "second restore (nothing changed in between)",
    );
    must(scene_patch(&db, "s1", "edit-2", "edited again"), "edit");
    must(body(&db, "r3", "S1"), "third restore after an edit");
    assert_eq!(scope_head(&db, "s1"), live_state(&db, "s1"));
}

#[test]
fn restore_edit_restore_and_scope_edits_around_restores_all_succeed() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    snapshot(&db, "S1");
    must(body(&db, "r1", "S1"), "restore");
    must(
        scene_scope_edit(&db, "s1", "scope-1"),
        "scope edit after a restore",
    );
    must(body(&db, "r2", "S1"), "restore after a scope edit");
    must(scene_patch(&db, "s1", "edit-1", "edited"), "edit");
    must(body(&db, "r3", "S1"), "restore after an edit");
    must(scene_scope_edit(&db, "s1", "scope-2"), "scope edit");
}

#[test]
fn restoring_a_scene_deleted_after_the_snapshot_succeeds_despite_its_scope_history() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    must(scene_scope_edit(&db, "s1", "scope-1"), "scope edit");
    snapshot(&db, "S1");
    // A deleted Scene writes no scene-scope event: its head stays at v2 while
    // the restore re-creates the binding at v1.
    must(scene_delete(&db, "s1", "del-1"), "delete");
    must(body(&db, "r1", "S1"), "restore brings the scene back");
    assert_eq!(scope_head(&db, "s1"), live_state(&db, "s1"));
    must(
        scene_scope_edit(&db, "s1", "scope-2"),
        "scope edit after the restore",
    );
}

// =====================================================================
// Undo / Redo of what predates a restore
// =====================================================================

fn counts(db: &Database) -> String {
    format!(
        "tx={:?} events={:?} journal={:?} heads={:?}",
        scalar(db, "SELECT count(*) FROM narrative_change_transactions"),
        scalar(db, "SELECT count(*) FROM change_events"),
        scalar(db, "SELECT count(*) FROM undo_journal"),
        scalar(
            db,
            "SELECT sum(canonical_sequence) FROM narrative_change_object_heads"
        ),
    )
}

fn title_of(db: &Database, id: &str) -> String {
    one_string(db, "SELECT title FROM events WHERE id = ?1", &[id]).unwrap_or_default()
}

#[test]
fn undo_and_redo_of_an_edit_that_predates_the_restore_are_refused() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    snapshot(&db, "S1");
    must(
        ev_update(&db, "e1", "J1", "edited before the restore"),
        "edit (journal J1)",
    );
    must(body(&db, "r1", "S1"), "restore");
    must(
        ev_update(&db, "e1", "J2", "edited after the restore"),
        "edit after the restore (J2)",
    );
    // The row is at the version J1 produced, so only the restore tells the
    // two apart (an ABA the optimistic version check cannot see).
    let before = counts(&db);
    must_fail_with(
        undo_replay(&db, "J1", "undo"),
        SUPERSEDED,
        "undo of a journal older than the restore",
    );
    assert_eq!(counts(&db), before, "the refused undo left nothing behind");
    assert_eq!(title_of(&db, "e1"), "edited after the restore");
    // What was done after the restore is undone and redone as usual.
    must(
        undo_replay(&db, "J2", "undo"),
        "undo of the post-restore edit",
    );
    assert_eq!(title_of(&db, "e1"), "orig");
    must(
        undo_replay(&db, "J2", "redo"),
        "redo of the post-restore edit",
    );
    assert_eq!(title_of(&db, "e1"), "edited after the restore");
}

#[test]
fn edit_undo_restore_edit_then_the_old_journal_is_refused_and_the_edit_stays() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    snapshot(&db, "S1");
    must(ev_update(&db, "e1", "X1-upd", "edited"), "edit");
    must(undo_replay(&db, "X1-upd", "undo"), "undo");
    must(body(&db, "r1", "S1"), "restore");
    must(
        ev_update(&db, "e1", "X1-post", "POST-RESTORE EDIT"),
        "edit after the restore",
    );
    let before = counts(&db);
    must_fail_with(
        undo_replay(&db, "X1-upd", "undo"),
        SUPERSEDED,
        "undo of X1-upd",
    );
    assert_eq!(title_of(&db, "e1"), "POST-RESTORE EDIT");
    // One more edit brings the row to the version the undone journal expects
    // for a redo: again only the restore can refuse it.
    must(
        ev_update(&db, "e1", "X1-post-2", "POST-RESTORE EDIT 2"),
        "second edit",
    );
    must_fail_with(
        undo_replay(&db, "X1-upd", "redo"),
        SUPERSEDED,
        "redo of X1-upd",
    );
    assert_eq!(title_of(&db, "e1"), "POST-RESTORE EDIT 2");
    let _ = before;
}

/// 変更の無い restore は marker を書かないので、古い Undo は拒まれない。fixture は、復元が
/// 行を変えない scope（Foreshadow）だけで、実際の no_op=true と marker 0 件を固定する。
/// （出来事に場面の紐づきがあれば、本文が同じでも Body の復元は marker を書く。それは下の
/// `a_body_restore_that_reissues_scene_links_writes_a_marker_even_with_the_same_text`。）
#[test]
fn a_net_no_op_restore_does_not_refuse_the_undo() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    must(ev_update(&db, "e1", "J1", "edited"), "edit");
    snapshot(&db, "S1");
    assert_eq!(
        must(
            restore(&db, "r1", "S1", vec![RestoreScope::Foreshadow]),
            "restore a scope that changes nothing"
        ),
        "no_op=true"
    );
    assert_eq!(marker_count(&db), 0, "a no-op restore writes no marker");
    must(
        undo_replay(&db, "J1", "undo"),
        "no marker, nothing is superseded",
    );
    assert_eq!(title_of(&db, "e1"), "orig");
}

/// 上の逆：出来事に場面の紐づきがあると、本文が同じでも Body の復元は紐づきの
/// incarnation token を振り直して marker を書く（no_op=false）。古い Undo は拒まれる。
#[test]
fn a_body_restore_that_reissues_scene_links_writes_a_marker_even_with_the_same_text() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    must(ev_update(&db, "e1", "J1", "edited"), "edit");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO scene_events (scene_id, event_id, incarnation_token)
             VALUES ('s1', 'e1', 'token-1')",
            [],
        )?;
        Ok(())
    })
    .expect("link the scene and the event");
    snapshot(&db, "S1");
    assert_eq!(
        must(body(&db, "r1", "S1"), "restore"),
        "no_op=false",
        "the links are re-issued, so the restore is not a no-op"
    );
    assert_eq!(marker_count(&db), 1);
    must_fail_with(
        undo_replay(&db, "J1", "undo"),
        SUPERSEDED,
        "the marker was written",
    );
}

#[test]
fn undo_and_redo_without_any_restore_are_unchanged() {
    let db = new_db();
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "create");
    must(ev_update(&db, "e1", "J1", "edited"), "edit");
    must(undo_replay(&db, "J1", "undo"), "undo");
    assert_eq!(title_of(&db, "e1"), "orig");
    must(undo_replay(&db, "J1", "redo"), "redo");
    assert_eq!(title_of(&db, "e1"), "edited");
}

// =====================================================================
// The first write after a restore through the other writers
// (Chronicle bulk, Scene body bundle) also chains from the restored state
// =====================================================================

fn bulk(db: &Database, req: &str, operations: Value) -> anyhow::Result<Value> {
    agent_chronicle_bulk_mutate_with_authority_impl(
        db,
        de::<AgentChronicleBulkPayload>(json!({
            "requestId": req, "projectId": P, "sessionId": SESSION,
            "surface": "manual", "operations": operations
        }))?,
        Some(human_context(req)),
    )
}

fn scene_updated_at(db: &Database, id: &str) -> String {
    one_string(db, "SELECT updated_at FROM tree_nodes WHERE id = ?1", &[id]).expect("updated_at")
}

fn save_body(db: &Database, scene: &str, req: &str, text: &str) -> anyhow::Result<()> {
    save_scene_body_bundle(
        db,
        SaveSceneBodyBundlePayload {
            scene_id: scene.to_string(),
            project_id: P.to_string(),
            request_id: req.to_string(),
            session_id: SESSION.to_string(),
            event_uid: format!("uid-{req}"),
            origin: NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            timelapse_doc_step_coverage: None,
            include_sidecars: false,
            base_version: Some(ver(db, "tree_nodes", scene)),
            updated_at: "2026-11-22T00:00:00.000Z".to_string(),
            content_json: format!(
                "{{\"type\":\"doc\",\"content\":[{{\"type\":\"paragraph\",\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}]}}"
            ),
            char_count: text.chars().count() as i64,
            placed_beat_preview: None,
            unplaced_beats_doc: "[]".to_string(),
            unplaced_beat_preview: None,
            authorship_spans: vec![],
            foreshadow_setups: vec![],
            foreshadow_payoffs: vec![],
            foreshadow_base_versions: std::collections::HashMap::new(),
            annotation_anchors: vec![],
            beat_mentions: vec![],
            beat_pov_overrides: vec![],
            doc_content_size: 2 + text.chars().count() as i64,
        },
    )
    .map(|_| ())
}

#[test]
fn chronicle_bulk_writes_after_a_restore_succeed_twice() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    must(bare_event_create(&db, "create-e1", "e1", "orig"), "event");
    snapshot(&db, "S1");
    must(ev_update(&db, "e1", "edit-e1", "edited"), "edit the event");
    must(
        scene_patch(&db, "s1", "edit-s1", "edited scene"),
        "edit the scene",
    );
    must(body(&db, "r1", "S1"), "restore");
    assert_eq!(marker_count(&db), 1);

    // The first write to each object after the restore.
    must(
        bulk(
            &db,
            "bulk-lane",
            json!([{ "kind": "eventSetLane", "eventId": "e1",
                     "baseVersion": ver(&db, "events", "e1"),
                     "primaryCodexId": null, "laneGroup": "lane-a" }]),
        ),
        "eventSetLane as the first write after the restore",
    );
    must(
        bulk(
            &db,
            "bulk-pov",
            json!([{ "kind": "sceneSetPov", "sceneId": "s1",
                     "baseUpdatedAt": scene_updated_at(&db, "s1"),
                     "povCharacterId": null }]),
        ),
        "sceneSetPov as the first write after the restore",
    );
    // And the second write chains from the first.
    must(
        bulk(
            &db,
            "bulk-lane-2",
            json!([{ "kind": "eventSetLane", "eventId": "e1",
                     "baseVersion": ver(&db, "events", "e1"),
                     "primaryCodexId": null, "laneGroup": "lane-b" }]),
        ),
        "the second eventSetLane",
    );
    must(
        bulk(
            &db,
            "bulk-delete",
            json!([{ "kind": "eventDelete", "eventId": "e1",
                     "baseVersion": ver(&db, "events", "e1") }]),
        ),
        "eventDelete after the restore",
    );
}

#[test]
fn scene_body_saves_after_a_restore_succeed_twice() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    snapshot(&db, "S1");
    must(
        scene_patch(&db, "s1", "edit-s1", "edited scene"),
        "edit the scene",
    );
    must(body(&db, "r1", "S1"), "restore");
    assert_eq!(marker_count(&db), 1);
    must(
        save_body(&db, "s1", "body-1", "first save"),
        "the first Scene body save after the restore",
    );
    must(
        save_body(&db, "s1", "body-2", "second save"),
        "the second Scene body save",
    );
}

#[test]
fn scene_body_save_after_the_scene_was_deleted_and_restored_succeeds() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    snapshot(&db, "S1");
    must(scene_delete(&db, "s1", "del-s1"), "delete the scene");
    must(body(&db, "r1", "S1"), "restore brings the scene back");
    assert_eq!(marker_count(&db), 1);
    must(
        save_body(&db, "s1", "body-1", "first save"),
        "the first Scene body save after delete + restore",
    );
    must(
        save_body(&db, "s1", "body-2", "second save"),
        "the second Scene body save",
    );
}

// =====================================================================
// Plot and Foreshadow keep today's behaviour (out of scope, pinned)
// =====================================================================

#[test]
fn plot_thread_behaviour_around_a_restore_is_pinned_as_it_is_today() {
    // The writer takes its before from the head, so an edit after a restore
    // passes (a continuity that only looks continuous).
    let db = new_db();
    must(plot_create(&db, "thread-a"), "create");
    snapshot(&db, "S1");
    must(plot_update(&db, "thread-a", "edit-1", "edited"), "edit");
    must(body(&db, "r1", "S1"), "restore");
    must(
        plot_update(&db, "thread-a", "post-1", "after"),
        "edit after the restore",
    );
    // Deleted, then restored: the next edit fails for a different reason, and
    // this change does not repair it.
    let db = new_db();
    must(plot_create(&db, "thread-a"), "create");
    snapshot(&db, "S1");
    must(plot_delete(&db, "thread-a", "del-1"), "delete");
    must(body(&db, "r1", "S1"), "restore brings it back");
    must_fail_with(
        plot_update(&db, "thread-a", "post-1", "after"),
        "update events require before and after states",
        "plot update after delete + restore",
    );
}

#[test]
fn foreshadow_edit_after_a_restore_is_pinned_as_it_is_today() {
    let db = new_db();
    must(fs_create(&db, "fs-a"), "create");
    snapshot(&db, "S1");
    must(fs_update(&db, "fs-a", "edit-1", "edited"), "edit");
    must(
        restore(&db, "r1", "S1", vec![RestoreScope::Foreshadow]),
        "foreshadow restore",
    );
    must(
        fs_update(&db, "fs-a", "post-1", "after"),
        "edit after the restore",
    );
    must(fs_delete(&db, "fs-a", "post-del"), "delete");
}

// =====================================================================
// Trust boundary: the restore-only entry is crate-private and the single
// production writer of the restore transaction is project_snapshots.rs
// =====================================================================

/// Build output and vendored code: never scanned.
const SKIPPED_DIRS: &[&str] = &["target", "node_modules"];
/// Cargo integration-test and test-support directories. They are skipped only
/// when they sit directly under a crate root (a directory with a `Cargo.toml`),
/// where they are never part of the shipped library or binary. A `tests`
/// directory below `src` is decided by the `#[cfg(test)] mod` declaration that
/// points at it, not by its name.
const CRATE_TEST_DIRS: &[&str] = &["tests", "test", "test-support"];

fn all_rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let is_crate_root = dir.join("Cargo.toml").is_file();
    for entry in std::fs::read_dir(dir).expect("read dir") {
        let path = entry.expect("entry").path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            let skipped = SKIPPED_DIRS.contains(&name.as_str())
                || (is_crate_root && CRATE_TEST_DIRS.contains(&name.as_str()));
            if !skipped {
                all_rust_files(&path, out);
            }
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Paths (files and directories) that `file` declares as test-only modules:
/// `#[cfg(test)] mod name;`, optionally with `#[path = "..."]` and a
/// visibility. A `mod name;` without that exact `cfg(test)` attribute is not
/// returned, so a production module is never excused by its file name. A
/// compound cfg such as `cfg(all(test, ...))` is not read either; that leaves
/// the file in the scan, which only makes the scan stricter.
fn cfg_test_module_paths(file: &std::path::Path, text: &str) -> Vec<std::path::PathBuf> {
    let dir = file.parent().expect("source file has a parent");
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = if matches!(stem.as_str(), "lib" | "main" | "mod") {
        dir.to_path_buf()
    } else {
        dir.join(&stem)
    };
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("#[cfg(test)]") {
        rest = &rest[at + "#[cfg(test)]".len()..];
        let mut cur = rest;
        let mut path_attr: Option<String> = None;
        loop {
            cur = cur.trim_start();
            if let Some(attr) = cur.strip_prefix("#[") {
                let Some(end) = attr.find(']') else { break };
                if let Some(value) = attr[..end].trim_start().strip_prefix("path") {
                    let mut parts = value.split('"');
                    if let (Some(_), Some(literal)) = (parts.next(), parts.next()) {
                        path_attr = Some(literal.to_string());
                    }
                }
                cur = &attr[end + 1..];
            } else if cur.starts_with("//") {
                cur = cur.find('\n').map_or("", |n| &cur[n..]);
            } else {
                break;
            }
        }
        if let Some(after_pub) = cur.strip_prefix("pub") {
            let after_pub = after_pub.trim_start();
            cur = match after_pub
                .strip_prefix('(')
                .and_then(|r| r.find(')').map(|n| &r[n + 1..]))
            {
                Some(after_vis) => after_vis,
                None => after_pub,
            };
        }
        let Some(after_mod) = cur.trim_start().strip_prefix("mod ") else {
            continue;
        };
        let after_mod = after_mod.trim_start();
        let name_len = after_mod
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        if name_len == 0 || !after_mod[name_len..].trim_start().starts_with(';') {
            continue; // an inline module: its body is dropped by `without_cfg_test_items`
        }
        let name = &after_mod[..name_len];
        match &path_attr {
            Some(literal) => found.push(dir.join(literal)),
            None => {
                found.push(base.join(format!("{name}.rs")));
                found.push(base.join(name).join("mod.rs"));
                found.push(base.join(name));
            }
        }
    }
    found
}

/// Every `.rs` file below `dir` except build output, the crate-level test
/// directories, and the files that a `#[cfg(test)] mod x;` declaration names.
/// A file's name never excuses it.
fn production_rust_sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let mut all = Vec::new();
    all_rust_files(dir, &mut all);
    let mut test_only: Vec<std::path::PathBuf> = Vec::new();
    for file in &all {
        let text = std::fs::read_to_string(file).expect("read source");
        test_only.extend(cfg_test_module_paths(file, &text));
    }
    out.extend(
        all.into_iter()
            .filter(|file| !test_only.iter().any(|t| file.starts_with(t))),
    );
}

#[test]
fn the_source_scan_excuses_test_files_only_by_cfg_test_declarations() {
    let root = std::env::temp_dir().join(format!(
        "grimodex-scan-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let write = |rel: &str, text: &str| {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    write("krate/Cargo.toml", "");
    write(
        "krate/src/lib.rs",
        "#[cfg(test)]\nmod tests;\n#[cfg(test)]\n#[path = \"custom_check.rs\"]\nmod renamed;\n\
         mod sneaky_tests;\n#[cfg(all(test, unix))]\nmod compound;\nmod prod;\n",
    );
    write("krate/src/tests.rs", "");
    write("krate/src/tests/deep.rs", "");
    write("krate/src/custom_check.rs", "");
    write("krate/src/sneaky_tests.rs", "");
    write("krate/src/compound.rs", "");
    write(
        "krate/src/prod.rs",
        "#[cfg(test)]\npub(crate) mod prod_tests;\n",
    );
    write("krate/src/prod/prod_tests.rs", "");
    write("krate/src/prod/other_tests.rs", "");
    write("krate/tests/integration.rs", "");
    write("krate/test-support/support.rs", "");
    write("krate/target/built.rs", "");
    let mut found = Vec::new();
    production_rust_sources(&root, &mut found);
    let mut names: Vec<String> = found
        .iter()
        .map(|f| {
            f.strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    names.sort();
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(
        names,
        [
            "krate/src/compound.rs",
            "krate/src/lib.rs",
            "krate/src/prod.rs",
            "krate/src/prod/other_tests.rs",
            "krate/src/sneaky_tests.rs",
        ],
        "only cfg(test)-declared modules and crate-level test directories are excused"
    );
}

/// `text` without its `#[cfg(test)]` items. A braced item is skipped up to its
/// matching brace; strings, raw strings, char literals and comments are read
/// so a brace inside them does not unbalance the count.
fn without_cfg_test_items(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let mut copied_to = 0;
    while let Some(found) = text[i..].find("#[cfg(test)]") {
        let attr = i + found;
        out.push_str(&text[copied_to..attr]);
        let mut j = attr + "#[cfg(test)]".len();
        // The item runs to a `;` (a `mod x;`) or through its braced body.
        let mut depth = 0usize;
        let mut opened = false;
        while j < bytes.len() {
            match bytes[j] {
                b'/' if bytes.get(j + 1) == Some(&b'/') => {
                    j = text[j..].find('\n').map_or(bytes.len(), |n| j + n);
                    continue;
                }
                b'/' if bytes.get(j + 1) == Some(&b'*') => {
                    j = text[j + 2..]
                        .find("*/")
                        .map_or(bytes.len(), |n| j + 2 + n + 2);
                    continue;
                }
                b'"' => {
                    j += 1;
                    while j < bytes.len() && bytes[j] != b'"' {
                        j += if bytes[j] == b'\\' { 2 } else { 1 };
                    }
                }
                b'r' if matches!(bytes.get(j + 1), Some(b'"') | Some(b'#'))
                    && (j == 0
                        || !(bytes[j - 1].is_ascii_alphanumeric() || bytes[j - 1] == b'_')) =>
                {
                    let hashes = text[j + 1..].bytes().take_while(|b| *b == b'#').count();
                    if bytes.get(j + 1 + hashes) == Some(&b'"') {
                        let close = format!("\"{}", "#".repeat(hashes));
                        j = text[j + 2 + hashes..]
                            .find(&close)
                            .map_or(bytes.len(), |n| j + 2 + hashes + n + close.len() - 1);
                    }
                }
                b'\'' => {
                    // A char literal (`'{'`, `'\n'`); a lifetime has no closing quote.
                    if bytes.get(j + 1) == Some(&b'\\') {
                        // Skip the escaped character, then read up to the closing quote.
                        j += 2 + text[j + 3..].find('\'').map_or(0, |n| n + 1);
                    } else if bytes.get(j + 2) == Some(&b'\'') {
                        j += 2;
                    }
                }
                b'{' => {
                    depth += 1;
                    opened = true;
                }
                b'}' => {
                    depth = depth.saturating_sub(1);
                    if opened && depth == 0 {
                        j += 1;
                        break;
                    }
                }
                b';' if !opened => {
                    j += 1;
                    break;
                }
                _ => {}
            }
            j += 1;
        }
        copied_to = j.min(bytes.len());
        i = copied_to;
    }
    out.push_str(&text[copied_to..]);
    out
}

#[test]
fn the_cfg_test_scanner_drops_test_items_and_only_those() {
    let text = r##"
fn keep_a() { let _ = "append_snapshot_restore_in_tx"; }
#[cfg(test)]
mod tests {
    fn braces_in_literals() { let _ = "}}"; let _ = '}'; let _ = r#"}"#; /* } */ }
    fn t() { let _ = "project.snapshot.restore"; }
}
fn keep_b<'a>(_: &'a str) { let _ = "SNAPSHOT_RESTORE_SOURCE_DOMAIN"; }
#[cfg(test)]
mod external_tests;
fn keep_c() {}
"##;
    let kept = without_cfg_test_items(text);
    assert!(kept.contains("keep_a") && kept.contains("keep_b") && kept.contains("keep_c"));
    assert!(kept.contains("append_snapshot_restore_in_tx"));
    assert!(kept.contains("SNAPSHOT_RESTORE_SOURCE_DOMAIN"));
    assert!(!kept.contains("project.snapshot.restore"));
    assert!(!kept.contains("braces_in_literals") && !kept.contains("external_tests"));
}

/// The restore transaction can only be forged by code that spells the entry,
/// its source domain constant or the domain string. Every production `.rs` of
/// the Rust workspace crates and of the Electron binding is scanned for each
/// of the three spellings (`snapshot.restore` also catches a split literal's
/// tail); the allowed files are exactly the definition and the restore.
/// Limit: a name built at run time from unrelated pieces is not caught; the
/// entry stays `pub(crate)`, so only this crate's own code can reach it.
#[test]
fn the_restore_only_append_entry_is_crate_private_and_called_from_one_place() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repository root");
    let mut files = Vec::new();
    production_rust_sources(&repo.join("src-tauri/crates"), &mut files);
    production_rust_sources(&repo.join("electron/native"), &mut files);
    assert!(
        files.len() > 50,
        "the scan must cover the workspace crates and the Electron binding, found {}",
        files.len()
    );
    let spellings = [
        "append_snapshot_restore_in_tx",
        "SNAPSHOT_RESTORE_SOURCE_DOMAIN",
        "snapshot.restore",
    ];
    let mut hits: std::collections::BTreeMap<&str, Vec<String>> =
        spellings.iter().map(|s| (*s, Vec::new())).collect();
    let mut change_feed = String::new();
    for file in files {
        let name = file
            .strip_prefix(repo)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let text = without_cfg_test_items(&std::fs::read_to_string(&file).expect("read source"));
        for spelling in spellings {
            if text.contains(spelling) {
                hits.get_mut(spelling).unwrap().push(name.clone());
            }
        }
        if name == "src-tauri/crates/grimodex-db/src/narrative_extraction/change_feed.rs" {
            change_feed = text;
        }
    }
    let change_feed_file = "src-tauri/crates/grimodex-db/src/narrative_extraction/change_feed.rs";
    let snapshots_file = "src-tauri/crates/grimodex-db/src/project_snapshots.rs";
    let both = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
    for (spelling, expected) in [
        (
            "append_snapshot_restore_in_tx",
            both(change_feed_file, snapshots_file),
        ),
        (
            "SNAPSHOT_RESTORE_SOURCE_DOMAIN",
            vec![change_feed_file.to_string()],
        ),
        ("snapshot.restore", both(change_feed_file, snapshots_file)),
    ] {
        let mut found = hits[spelling].clone();
        found.sort();
        let mut expected = expected;
        expected.sort();
        assert_eq!(
            found, expected,
            "`{spelling}` may appear only in the definition and in the restore"
        );
    }
    assert!(
        change_feed.contains("pub(crate) fn append_snapshot_restore_in_tx"),
        "the restore-only entry must stay pub(crate)"
    );
    assert!(
        !change_feed.contains("pub fn append_snapshot_restore_in_tx"),
        "the restore-only entry must not become public"
    );
}

// ---- the exemption still carries a restore that DOES drop a link ----
//
// Since DR-SRX the links of the scopes that were not restored survive a
// restore, so the two tests above ("keeps the participants", "detaches a
// snippet") no longer reach the exemption: nothing about the object changes and
// its head is still right. These two restore the other way round: the parent
// of the link is created after the snapshot, so the restore really removes it
// and the link falls away, the object's state moves off its feed head, and the
// next write passes only because of the exemption (DR-SRC-3, DR-SRX-14).

#[test]
fn codex_only_restore_that_removes_the_primary_character_leaves_the_event_writable() {
    let db = new_db();
    must(codex_create(&db, "c1"), "codex c1");
    must(
        agent_event_create_with_authority_impl(
            &db,
            de::<AgentEventCreatePayload>(json!({
                "startTime": 0, "startGranularity": "day",
                "requestId": "create-e1", "eventId": "e1", "projectId": P,
                "sessionId": SESSION, "surface": "manual", "title": "orig",
                "ordinal": "a0", "kind": "generic", "participantCodexIds": ["c1"],
            }))
            .unwrap(),
            Some(human_context("create-e1")),
        ),
        "event",
    );
    snapshot(&db, "S1");
    // After the snapshot a new entry becomes the event's primary character,
    // through the writer (so the event and its feed head agree).
    must(codex_create(&db, "c3"), "codex c3 after the snapshot");
    let bv = ver(&db, "events", "e1");
    must(
        agent_event_update_with_authority_impl(
            &db,
            de::<AgentEventUpdatePayload>(json!({
                "projectId": P, "sessionId": SESSION, "surface": "manual",
                "eventId": "e1", "baseVersion": bv, "primaryCodexId": "c3"
            }))
            .unwrap(),
            human_context("primary-c3"),
        ),
        "primary character c3",
    );
    must(
        restore(&db, "r1", "S1", vec![RestoreScope::Codex]),
        "codex-only restore removes c3",
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM events WHERE id = 'e1' AND primary_codex_id IS NULL"
        ),
        Some(1),
        "the link to the removed entry fell away"
    );
    assert_head_is_stale(&db, "e1");
    must(
        ev_update(&db, "e1", "post-1", "after"),
        "event update after its primary character was removed by the restore",
    );
}

#[test]
fn body_only_restore_that_removes_the_snippets_scene_leaves_the_snippet_writable() {
    let db = new_db();
    must(scene_create(&db, "s1"), "scene");
    snapshot(&db, "S1");
    must(scene_create(&db, "s2"), "scene created after the snapshot");
    must(
        snippet_writes::create(
            &db,
            de(snippet_merge(
                snippet_ctx("create-sn1"),
                json!({"snippetId": "sn1", "title": "Snippet original",
                       "content": "{\"type\":\"doc\"}", "tagsCache": null,
                       "contentSource": "human", "sceneId": "s2",
                       "sourceChatMessageId": null,
                       "canonicalPayload": {"title": "Snippet original"}}),
            ))
            .unwrap(),
        ),
        "snippet attached to the scene made after the snapshot",
    );
    must(body(&db, "r1", "S1"), "body-only restore removes s2");
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM snippets WHERE id = 'sn1' AND scene_id IS NULL"
        ),
        Some(1),
        "the snippet's link to the removed scene fell away"
    );
    must(
        snippet_update(&db, "sn1", "post-1", "after"),
        "snippet update after its scene was removed by the restore",
    );
}
