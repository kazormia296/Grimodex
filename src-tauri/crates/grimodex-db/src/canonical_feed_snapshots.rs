//! Canonical, deterministic snapshots used to digest Narrative Change Feed roots.
//!
//! A root must have exactly one snapshot shape, independent of the writer that
//! changed it. Otherwise two valid sequential writes look like a discontinuous
//! history to freshness consumers.

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::Database;

fn canonical_raw_row(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[Value],
    description: &str,
) -> anyhow::Result<Value> {
    Database::execute_with_conn(conn, sql, params, "get")?
        .into_iter()
        .next()
        .map(Value::Object)
        .ok_or_else(|| anyhow::anyhow!("{description} not found"))
}

pub(crate) fn canonical_scene_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<Value> {
    let root = canonical_tree_node_snapshot(conn, project_id, scene_id)?;
    anyhow::ensure!(
        root.get("nodeType").and_then(Value::as_str) == Some("scene"),
        "tree node '{scene_id}' is not a scene in project '{project_id}'"
    );
    Ok(root)
}

pub(crate) fn canonical_tree_node_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    node_id: &str,
) -> anyhow::Result<Value> {
    let root = Database::execute_with_conn(
        conn,
        "SELECT id, project_id AS projectId, parent_id AS parentId,
                node_type AS nodeType, title, synopsis, intent,
                sort_order AS sortOrder, story_time_order AS storyTimeOrder,
                story_time_label AS storyTimeLabel,
                pov_character_id AS povCharacterId, location_id AS locationId,
                chronicle_start_time AS chronicleStartTime,
                chronicle_start_minute AS chronicleStartMinute,
                chronicle_start_granularity AS chronicleStartGranularity,
                chronicle_end_time AS chronicleEndTime,
                chronicle_end_minute AS chronicleEndMinute,
                chronicle_end_granularity AS chronicleEndGranularity,
                chronicle_precision AS chroniclePrecision, status, content,
                unplaced_beats_doc AS unplacedBeatsDoc,
                char_count AS charCount,
                unplaced_beat_preview AS unplacedBeatPreview,
                placed_beat_preview AS placedBeatPreview,
                source_uri AS sourceUri, source_mtime AS sourceMtime,
                archived_at AS archivedAt, context_mode AS contextMode,
                aliases, excluded_aliases AS excludedAliases,
                created_at AS createdAt, updated_at AS updatedAt, version
           FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(node_id.to_string()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?
    .into_iter()
    .next()
    .ok_or_else(|| anyhow::anyhow!("tree node '{node_id}' not found in project '{project_id}'"))?;
    Ok(Value::Object(root))
}

pub(crate) fn canonical_foreshadow_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    foreshadow_id: &str,
) -> anyhow::Result<Value> {
    crate::narrative_extraction::collect_aggregate_snapshot(conn, project_id, foreshadow_id)
}

pub(crate) fn canonical_codex_entry_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
) -> anyhow::Result<Value> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM codex_entries WHERE id = ?1",
            params![entry_id],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        owner.as_deref() == Some(project_id),
        "codex entry '{entry_id}' not found in project '{project_id}'"
    );
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'type', type, 'name', name,
            'summary', summary, 'content', content, 'aliases', aliases,
            'excludedAliases', excluded_aliases, 'readings', readings,
            'tagsCache', tags_cache, 'parentId', parent_id, 'icon', icon,
            'contextMode', context_mode, 'childrenBudget', children_budget,
            'sourceChatMessageId', source_chat_message_id, 'notes', notes,
            'createdAt', created_at, 'version', version
         ) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![entry_id, project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn canonical_codex_relation_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    relation_key: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id,
            'fromCodexId', from_codex_id, 'toCodexId', to_codex_id,
            'relationType', relation_type, 'label', label,
            'directionality', directionality, 'inverseLabel', inverse_label,
            'semanticKey', semantic_key, 'depthHint', depth_hint,
            'sourceMapEdgeId', source_map_edge_id, 'version', version,
            'createdAt', created_at, 'updatedAt', updated_at
         ) FROM codex_relations WHERE id = ?1 AND project_id = ?2",
        params![relation_key, project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn canonical_snippet_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snippet_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'title', title,
            'content', content, 'tagsCache', tags_cache,
            'contentSource', content_source, 'sceneId', scene_id,
            'sourceChatMessageId', source_chat_message_id,
            'createdAt', created_at,
            'updatedAt', updated_at, 'version', version
         ) FROM snippets WHERE id = ?1 AND project_id = ?2",
        params![snippet_id, project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn canonical_codex_detail_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    definition_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', value.id, 'entryId', value.entry_id,
            'definitionId', value.definition_id, 'value', value.value,
            'version', value.version, 'createdAt', value.created_at,
            'updatedAt', value.updated_at
         )
           FROM codex_detail_values value
           JOIN codex_entries entry ON entry.id = value.entry_id
           JOIN codex_detail_definitions definition
             ON definition.id = value.definition_id
          WHERE value.entry_id = ?1 AND value.definition_id = ?2
            AND entry.project_id = ?3 AND definition.project_id = ?3",
        params![entry_id, definition_id, project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn canonical_codex_type_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    type_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'slug', slug, 'label', label,
            'color', color, 'paletteIndex', palette_index, 'icon', icon,
            'isBuiltin', is_builtin, 'sortOrder', sort_order,
            'createdAt', created_at
         ) FROM codex_types WHERE id = ?1 AND project_id = ?2",
        params![type_id, project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn canonical_codex_tag_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    tag_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'name', name,
            'color', color, 'typeFilter', type_filter, 'createdAt', created_at
         ) FROM codex_tags WHERE id = ?1 AND project_id = ?2",
        params![tag_id, project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn canonical_codex_detail_definition_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    definition_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'typeSlug', type_slug,
            'name', name, 'fieldType', field_type, 'fieldConfig', field_config,
            'sortOrder', sort_order, 'includeInContext', include_in_context,
            'version', version, 'createdAt', created_at, 'updatedAt', updated_at
         ) FROM codex_detail_definitions WHERE id = ?1 AND project_id = ?2",
        params![definition_id, project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn canonical_semantic_binding_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    binding_id: &str,
) -> anyhow::Result<Value> {
    let owner: String = conn.query_row(
        "SELECT project_id FROM codex_detail_semantic_bindings WHERE id = ?1",
        params![binding_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(owner == project_id, "semantic binding escaped its project");
    crate::narrative_extraction::collect_semantic_binding_snapshot(conn, binding_id)
}

pub(crate) fn canonical_plot_thread_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    thread_id: &str,
) -> anyhow::Result<Value> {
    canonical_raw_row(
        conn,
        "SELECT * FROM plot_threads WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(thread_id.to_string()),
            Value::String(project_id.to_string()),
        ],
        "plot thread",
    )
}

pub(crate) fn canonical_plot_marker_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    marker_id: &str,
) -> anyhow::Result<Value> {
    canonical_raw_row(
        conn,
        "SELECT marker.* FROM plot_thread_scene_links marker
          JOIN plot_threads thread ON thread.id = marker.thread_id
         WHERE marker.id = ?1 AND thread.project_id = ?2",
        &[
            Value::String(marker_id.to_string()),
            Value::String(project_id.to_string()),
        ],
        "plot marker",
    )
}

pub(crate) fn canonical_plot_branch_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    branch_id: &str,
) -> anyhow::Result<Value> {
    canonical_raw_row(
        conn,
        "SELECT * FROM plot_thread_branches WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(branch_id.to_string()),
            Value::String(project_id.to_string()),
        ],
        "plot branch",
    )
}

pub(crate) fn canonical_calendar_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'projectId', project_id, 'daysPerYear', days_per_year,
            'seasonBoundaries', season_boundaries, 'startYear', start_year,
            'months', months, 'weekdayNames', weekday_names,
            'weekdayStartIndex', weekday_start_index, 'leapRule', leap_rule,
            'ageReckoning', age_reckoning, 'eras', eras, 'reform', reform,
            'timezone', timezone, 'lunarTzMinutes', lunar_tz_minutes,
            'version', version, 'createdAt', created_at, 'updatedAt', updated_at
         ) FROM project_calendar WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

fn canonical_map_component_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    component_kind: &str,
    id: &str,
) -> anyhow::Result<Value> {
    let sql = match component_kind {
        "map-board" => "SELECT * FROM map_boards WHERE id = ?1 AND project_id = ?2",
        "map-ai-branch" => "SELECT branch.* FROM map_ai_branches branch JOIN map_boards board ON board.id = branch.board_id WHERE branch.id = ?1 AND board.project_id = ?2",
        "map-sticky" => "SELECT sticky.* FROM map_stickies sticky JOIN map_boards board ON board.id = sticky.board_id WHERE sticky.id = ?1 AND board.project_id = ?2",
        "map-frame" => "SELECT frame.* FROM map_frames frame JOIN map_boards board ON board.id = frame.board_id WHERE frame.id = ?1 AND board.project_id = ?2",
        "map-position" => "SELECT position.* FROM map_node_positions position JOIN map_boards board ON board.id = position.board_id WHERE position.id = ?1 AND board.project_id = ?2",
        "map-edge" => "SELECT edge.* FROM map_edges edge JOIN map_boards board ON board.id = edge.board_id WHERE edge.id = ?1 AND board.project_id = ?2",
        _ => anyhow::bail!("unsupported canonical Map component '{component_kind}'"),
    };
    canonical_raw_row(
        conn,
        sql,
        &[
            Value::String(id.to_string()),
            Value::String(project_id.to_string()),
        ],
        component_kind,
    )
}

pub(crate) fn canonical_snapshot_for_object_key(
    conn: &rusqlite::Connection,
    project_id: &str,
    object_key: &Value,
) -> anyhow::Result<Option<Value>> {
    let kind = object_key.get("kind").and_then(Value::as_str);
    let result = match kind {
        Some("scene") => canonical_scene_snapshot(
            conn,
            project_id,
            object_key
                .get("sceneId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("scene object key has no sceneId"))?,
        ),
        Some("foreshadow") => canonical_foreshadow_snapshot(
            conn,
            project_id,
            object_key
                .get("foreshadowId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("foreshadow object key has no foreshadowId"))?,
        ),
        Some("codex-entry") => canonical_codex_entry_snapshot(
            conn,
            project_id,
            object_key
                .get("entryId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("codex-entry object key has no entryId"))?,
        ),
        Some("codex-relation") => canonical_codex_relation_snapshot(
            conn,
            project_id,
            object_key
                .get("relationId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("codex-relation object key has no relationId"))?,
        ),
        Some("codex-phase") => {
            let phase_id = object_key
                .get("phaseId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("codex-phase object key has no phaseId"))?;
            let owned = conn
                .query_row(
                    "SELECT 1
                       FROM codex_entry_phases phase
                       JOIN codex_entries entry ON entry.id = phase.entry_id
                      WHERE phase.id = ?1 AND entry.project_id = ?2",
                    params![phase_id, project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                owned,
                "Codex phase '{phase_id}' escaped project '{project_id}'"
            );
            crate::narrative_extraction::collect_phase_snapshot(conn, phase_id)
        }
        Some("plot-thread") => canonical_plot_thread_snapshot(
            conn,
            project_id,
            object_key
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("plot-thread object key has no threadId"))?,
        ),
        Some("calendar") => {
            let calendar_ref = object_key
                .get("calendarRef")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("calendar object key has no calendarRef"))?;
            anyhow::ensure!(calendar_ref == project_id, "calendar escaped its project");
            canonical_calendar_snapshot(conn, project_id)
        }
        Some("chronicle-event") => {
            let event_id = object_key
                .get("eventId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("chronicle-event object key has no eventId"))?;
            let owned = conn
                .query_row(
                    "SELECT 1 FROM events WHERE id = ?1 AND project_id = ?2",
                    params![event_id, project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                owned,
                "chronicle event '{event_id}' not found in project '{project_id}'"
            );
            crate::agent_writes::collect_event_snapshot(conn, event_id)
        }
        Some("component") => {
            let component_id = object_key
                .get("componentId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("component object key has no componentId"))?;
            if let Some(snippet_id) = component_id.strip_prefix("snippet:") {
                canonical_snippet_snapshot(conn, project_id, snippet_id)
            } else if let Some(type_id) = component_id.strip_prefix("codex-type:") {
                canonical_codex_type_snapshot(conn, project_id, type_id)
            } else if let Some(tag_id) = component_id.strip_prefix("codex-tag:") {
                canonical_codex_tag_snapshot(conn, project_id, tag_id)
            } else if let Some(definition_id) =
                component_id.strip_prefix("codex-detail-definition:")
            {
                canonical_codex_detail_definition_snapshot(conn, project_id, definition_id)
            } else if let Some(detail_key) = component_id.strip_prefix("codex-detail-value:") {
                let (entry_id, definition_id) = detail_key.split_once(':').ok_or_else(|| {
                    anyhow::anyhow!("Codex detail component has no definition id")
                })?;
                canonical_codex_detail_snapshot(conn, project_id, entry_id, definition_id)
            } else if let Some(binding_id) = component_id.strip_prefix("codex_semantic_binding:") {
                canonical_semantic_binding_snapshot(conn, project_id, binding_id)
            } else if let Some(marker_id) = component_id.strip_prefix("plot_thread_marker:") {
                canonical_plot_marker_snapshot(conn, project_id, marker_id)
            } else if let Some(branch_id) = component_id.strip_prefix("plot_thread_branch:") {
                canonical_plot_branch_snapshot(conn, project_id, branch_id)
            } else if let Some(node_id) = component_id.strip_prefix("tree-node:") {
                canonical_tree_node_snapshot(conn, project_id, node_id)
            } else if let Some((component_kind, id)) = component_id.split_once(':') {
                canonical_map_component_snapshot(conn, project_id, component_kind, id)
            } else {
                anyhow::bail!("no canonical snapshot loader for component '{component_id}'")
            }
        }
        _ => anyhow::bail!("no canonical snapshot loader for object key {object_key}"),
    };
    result.map(Some)
}

pub(crate) fn object_key_identity(object_key: &Value) -> anyhow::Result<String> {
    let kind = object_key
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Narrative object key has no kind"))?;
    let normalized = match kind {
        "scene" => json!({ "kind": kind, "sceneId": required(object_key, "sceneId")? }),
        "codex-entry" => json!({ "kind": kind, "entryId": required(object_key, "entryId")? }),
        "codex-relation" => {
            json!({ "kind": kind, "relationId": required(object_key, "relationId")? })
        }
        "codex-phase" => json!({ "kind": kind, "phaseId": required(object_key, "phaseId")? }),
        "chronicle-event" => json!({ "kind": kind, "eventId": required(object_key, "eventId")? }),
        "plot-thread" => json!({ "kind": kind, "threadId": required(object_key, "threadId")? }),
        "foreshadow" => {
            json!({ "kind": kind, "foreshadowId": required(object_key, "foreshadowId")? })
        }
        "calendar" => json!({ "kind": kind, "calendarRef": required(object_key, "calendarRef")? }),
        "component" => json!({ "kind": kind, "componentId": required(object_key, "componentId")? }),
        "import-source" => json!({
            "kind": kind,
            "sourceSetId": required(object_key, "sourceSetId")?,
            "objectKey": required(object_key, "objectKey")?,
        }),
        _ => anyhow::bail!("unsupported Narrative object key kind '{kind}'"),
    };
    Ok(serde_json::to_string(&normalized)?)
}

fn required(object_key: &Value, field: &str) -> anyhow::Result<Value> {
    object_key
        .get(field)
        .filter(|value| !value.is_null())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Narrative object key has no {field}"))
}
