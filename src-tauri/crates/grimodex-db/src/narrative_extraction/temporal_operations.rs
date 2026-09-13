//! Temporal Constraint Graph (TCG) projections onto existing Scene / Event
//! aggregates: Chronicle metadata patches and story-order materialization.
//!
//! These operations do not own new rows; they patch `tree_nodes` / `events`
//! Chronicle columns under the aggregate's own OCC (`version`), the same
//! invariant every other narrative apply commit patch already enforces.

use grimodex_core::chronicle_time::{
    validate_canonical_chronicle_date_range, ChronicleDateRange, ChronicleTimestamp,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::change_feed::{NarrativeChangeEventInput, NarrativeChangeOrigin};

pub(crate) const OP_KIND_SCENE_METADATA_PATCH: &str = "temporal.scene.metadata.patch";
pub(crate) const OP_KIND_EVENT_METADATA_PATCH: &str = "temporal.event.metadata.patch";
pub(crate) const OP_KIND_STORY_ORDER_MATERIALIZE: &str = "temporal.story-order.materialize";

fn default_granularity() -> String {
    "none".to_string()
}

fn default_precision() -> String {
    "exact".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporalChronicleMetadataPatchPayload {
    pub target_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default)]
    pub start_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub start_granularity: String,
    #[serde(default)]
    pub end_time: Option<i64>,
    #[serde(default)]
    pub end_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub end_granularity: String,
    #[serde(default = "default_precision")]
    pub precision: String,
}

pub(crate) fn parse_scene_metadata_patch_payload(
    payload: &Value,
) -> anyhow::Result<TemporalChronicleMetadataPatchPayload> {
    let mut value = payload.clone();
    rename_scene_id_to_target_id(&mut value);
    serde_json::from_value(value)
        .map_err(|err| anyhow::anyhow!("invalid temporal.scene.metadata.patch payload: {err}"))
}

pub(crate) fn parse_event_metadata_patch_payload(
    payload: &Value,
) -> anyhow::Result<TemporalChronicleMetadataPatchPayload> {
    let mut value = payload.clone();
    rename_event_id_to_target_id(&mut value);
    serde_json::from_value(value)
        .map_err(|err| anyhow::anyhow!("invalid temporal.event.metadata.patch payload: {err}"))
}

fn rename_scene_id_to_target_id(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        if let Some(scene_id) = obj.remove("sceneId") {
            obj.insert("targetId".to_string(), scene_id);
        }
    }
}

fn rename_event_id_to_target_id(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        if let Some(event_id) = obj.remove("eventId") {
            obj.insert("targetId".to_string(), event_id);
        }
    }
}

fn validate_range(payload: &TemporalChronicleMetadataPatchPayload) -> anyhow::Result<()> {
    validate_canonical_chronicle_date_range(ChronicleDateRange {
        start: ChronicleTimestamp {
            day: payload.start_time,
            minute: payload.start_minute,
            granularity: &payload.start_granularity,
        },
        end: ChronicleTimestamp {
            day: payload.end_time,
            minute: payload.end_minute,
            granularity: &payload.end_granularity,
        },
    })
    .map_err(|err| anyhow::anyhow!("NEX_TEMPORAL_CHRONICLE_INVALID: {err}"))
}

#[derive(Debug, Clone)]
pub(crate) struct TemporalPatchTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    pub before_snapshot: Value,
    pub scope_refresh_event: Option<NarrativeChangeEventInput>,
}

pub(crate) fn collect_scene_chronicle_snapshot(
    conn: &Connection,
    scene_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'startTime', chronicle_start_time,
            'startMinute', chronicle_start_minute,
            'startGranularity', chronicle_start_granularity,
            'endTime', chronicle_end_time,
            'endMinute', chronicle_end_minute,
            'endGranularity', chronicle_end_granularity,
            'precision', chronicle_precision,
            'version', version
         ) FROM tree_nodes WHERE id = ?1",
        params![scene_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

/// Patch one Scene's Chronicle range (exact-after replace) under `tree_nodes.version` OCC.
pub(crate) fn apply_scene_metadata_patch_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &TemporalChronicleMetadataPatchPayload,
    now: &str,
) -> anyhow::Result<TemporalPatchTxResult> {
    let live_version: Option<i64> = conn
        .query_row(
            "SELECT version FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![payload.target_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(live_version) = live_version else {
        anyhow::bail!(
            "scene '{}' not found in project '{}'",
            payload.target_id,
            project_id
        );
    };
    if live_version != payload.base_version {
        anyhow::bail!(
            "NEX_TEMPORAL_SCENE_VERSION_MISMATCH: scene '{}' expected version {}, found {}",
            payload.target_id,
            payload.base_version,
            live_version
        );
    }
    validate_range(payload)?;

    let before_snapshot = collect_scene_chronicle_snapshot(conn, &payload.target_id)?;
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("scene version overflow"))?;
    let updated = conn.execute(
        "UPDATE tree_nodes
            SET chronicle_start_time = ?1,
                chronicle_start_minute = ?2,
                chronicle_start_granularity = ?3,
                chronicle_end_time = ?4,
                chronicle_end_minute = ?5,
                chronicle_end_granularity = ?6,
                chronicle_precision = ?7,
                version = ?8,
                updated_at = ?9
          WHERE id = ?10 AND version = ?11",
        params![
            payload.start_time,
            payload.start_minute,
            payload.start_granularity,
            payload.end_time,
            payload.end_minute,
            payload.end_granularity,
            payload.precision,
            next_version,
            now,
            payload.target_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_TEMPORAL_SCENE_VERSION_MISMATCH: scene '{}' patch conflict",
        payload.target_id
    );
    let scope_refresh_event =
        super::refresh_scene_scope_source_token_in_tx(conn, project_id, &payload.target_id, now)?;
    let after_snapshot = collect_scene_chronicle_snapshot(conn, &payload.target_id)?;
    Ok(TemporalPatchTxResult {
        entity_id: payload.target_id.clone(),
        version: next_version,
        after_snapshot,
        before_snapshot,
        scope_refresh_event: Some(scope_refresh_event),
    })
}

pub(crate) fn restore_scene_chronicle_patch(
    conn: &Connection,
    scene_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<(i64, NarrativeChangeEventInput)> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM tree_nodes WHERE id = ?1",
        params![scene_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!("NEX_COMMIT_SCENE_EDITED: scene '{scene_id}' was modified after commit");
    }
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("scene version overflow during undo"))?;
    let updated = conn.execute(
        "UPDATE tree_nodes
            SET chronicle_start_time = ?1,
                chronicle_start_minute = ?2,
                chronicle_start_granularity = ?3,
                chronicle_end_time = ?4,
                chronicle_end_minute = ?5,
                chronicle_end_granularity = ?6,
                chronicle_precision = ?7,
                version = ?8,
                updated_at = ?9
          WHERE id = ?10 AND version = ?11",
        params![
            before_snapshot.get("startTime").and_then(Value::as_i64),
            before_snapshot.get("startMinute").and_then(Value::as_i64),
            before_snapshot
                .get("startGranularity")
                .and_then(Value::as_str)
                .unwrap_or("none"),
            before_snapshot.get("endTime").and_then(Value::as_i64),
            before_snapshot.get("endMinute").and_then(Value::as_i64),
            before_snapshot
                .get("endGranularity")
                .and_then(Value::as_str)
                .unwrap_or("none"),
            before_snapshot
                .get("precision")
                .and_then(Value::as_str)
                .unwrap_or("exact"),
            next_version,
            now,
            scene_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_SCENE_EDITED: scene '{scene_id}' restore conflict"
    );
    let scope_refresh_event =
        super::refresh_scene_scope_source_token_for_scene_in_tx(conn, scene_id, now)?;
    Ok((next_version, scope_refresh_event))
}

pub(crate) fn collect_event_chronicle_snapshot(
    conn: &Connection,
    event_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'startTime', start_time,
            'startMinute', start_minute,
            'startGranularity', start_granularity,
            'endTime', end_time,
            'endMinute', end_minute,
            'endGranularity', end_granularity,
            'precision', precision,
            'version', version
         ) FROM events WHERE id = ?1",
        params![event_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

/// Patch one Event's Chronicle range (exact-after replace) under `events.version` OCC.
pub(crate) fn apply_event_metadata_patch_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &TemporalChronicleMetadataPatchPayload,
    now: &str,
) -> anyhow::Result<TemporalPatchTxResult> {
    let live_version: Option<i64> = conn
        .query_row(
            "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
            params![payload.target_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(live_version) = live_version else {
        anyhow::bail!(
            "event '{}' not found in project '{}'",
            payload.target_id,
            project_id
        );
    };
    if live_version != payload.base_version {
        anyhow::bail!(
            "NEX_TEMPORAL_EVENT_VERSION_MISMATCH: event '{}' expected version {}, found {}",
            payload.target_id,
            payload.base_version,
            live_version
        );
    }
    validate_range(payload)?;

    let before_snapshot = collect_event_chronicle_snapshot(conn, &payload.target_id)?;
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("event version overflow"))?;
    let updated = conn.execute(
        "UPDATE events
            SET start_time = ?1,
                start_minute = ?2,
                start_granularity = ?3,
                end_time = ?4,
                end_minute = ?5,
                end_granularity = ?6,
                precision = ?7,
                version = ?8,
                updated_at = ?9
          WHERE id = ?10 AND version = ?11",
        params![
            payload.start_time,
            payload.start_minute,
            payload.start_granularity,
            payload.end_time,
            payload.end_minute,
            payload.end_granularity,
            payload.precision,
            next_version,
            now,
            payload.target_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_TEMPORAL_EVENT_VERSION_MISMATCH: event '{}' patch conflict",
        payload.target_id
    );
    let after_snapshot = collect_event_chronicle_snapshot(conn, &payload.target_id)?;
    Ok(TemporalPatchTxResult {
        entity_id: payload.target_id.clone(),
        version: next_version,
        after_snapshot,
        before_snapshot,
        scope_refresh_event: None,
    })
}

pub(crate) fn restore_event_chronicle_patch(
    conn: &Connection,
    event_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM events WHERE id = ?1",
        params![event_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!("NEX_COMMIT_EVENT_EDITED: event '{event_id}' was modified after commit");
    }
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("event version overflow during undo"))?;
    let updated = conn.execute(
        "UPDATE events
            SET start_time = ?1,
                start_minute = ?2,
                start_granularity = ?3,
                end_time = ?4,
                end_minute = ?5,
                end_granularity = ?6,
                precision = ?7,
                version = ?8,
                updated_at = ?9
          WHERE id = ?10 AND version = ?11",
        params![
            before_snapshot.get("startTime").and_then(Value::as_i64),
            before_snapshot.get("startMinute").and_then(Value::as_i64),
            before_snapshot
                .get("startGranularity")
                .and_then(Value::as_str)
                .unwrap_or("none"),
            before_snapshot.get("endTime").and_then(Value::as_i64),
            before_snapshot.get("endMinute").and_then(Value::as_i64),
            before_snapshot
                .get("endGranularity")
                .and_then(Value::as_str)
                .unwrap_or("none"),
            before_snapshot
                .get("precision")
                .and_then(Value::as_str)
                .unwrap_or("exact"),
            next_version,
            now,
            event_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_EVENT_EDITED: event '{event_id}' restore conflict"
    );
    Ok(next_version)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalScenePatchPayload {
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub project_id: String,
    pub target_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub story_time_order: Option<String>,
    #[serde(default)]
    pub story_time_label: Option<String>,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default)]
    pub start_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub start_granularity: String,
    #[serde(default)]
    pub end_time: Option<i64>,
    #[serde(default)]
    pub end_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub end_granularity: String,
    #[serde(default = "default_precision")]
    pub precision: String,
}

pub(crate) fn collect_scene_temporal_snapshot(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<(Value, NarrativeChangeEventInput)> {
    let raw: String = conn
        .query_row(
            "SELECT json_object(
                'id', id,
                'storyTimeOrder', story_time_order,
                'storyTimeLabel', story_time_label,
                'startTime', chronicle_start_time,
                'startMinute', chronicle_start_minute,
                'startGranularity', chronicle_start_granularity,
                'endTime', chronicle_end_time,
                'endMinute', chronicle_end_minute,
                'endGranularity', chronicle_end_granularity,
                'precision', chronicle_precision,
                'version', version
             ) FROM tree_nodes
             WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("scene '{scene_id}' not found in project '{project_id}'"))?;
    serde_json::from_str(&raw).map_err(Into::into)
}

/// Human scene temporal metadata write. This is the typed Native boundary for
/// UI story-order and Chronicle edits; all protected columns advance together
/// under the scene row's single OCC version.
pub(crate) fn apply_scene_temporal_patch_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &TemporalScenePatchPayload,
    now: &str,
) -> anyhow::Result<Value> {
    let live_version: Option<i64> = conn
        .query_row(
            "SELECT version FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![payload.target_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(live_version) = live_version else {
        anyhow::bail!(
            "scene '{}' not found in project '{}'",
            payload.target_id,
            project_id
        );
    };
    anyhow::ensure!(
        live_version == payload.base_version,
        "NEX_TEMPORAL_SCENE_VERSION_MISMATCH: scene '{}' expected version {}, found {}",
        payload.target_id,
        payload.base_version,
        live_version
    );
    validate_range(&TemporalChronicleMetadataPatchPayload {
        target_id: payload.target_id.clone(),
        base_version: payload.base_version,
        start_time: payload.start_time,
        start_minute: payload.start_minute,
        start_granularity: payload.start_granularity.clone(),
        end_time: payload.end_time,
        end_minute: payload.end_minute,
        end_granularity: payload.end_granularity.clone(),
        precision: payload.precision.clone(),
    })?;
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("scene version overflow"))?;
    let updated = conn.execute(
        "UPDATE tree_nodes
            SET story_time_order = ?1,
                story_time_label = ?2,
                chronicle_start_time = ?3,
                chronicle_start_minute = ?4,
                chronicle_start_granularity = ?5,
                chronicle_end_time = ?6,
                chronicle_end_minute = ?7,
                chronicle_end_granularity = ?8,
                chronicle_precision = ?9,
                version = ?10,
                updated_at = ?11
          WHERE id = ?12 AND project_id = ?13 AND version = ?14",
        params![
            payload.story_time_order,
            payload.story_time_label,
            payload.start_time,
            payload.start_minute,
            payload.start_granularity,
            payload.end_time,
            payload.end_minute,
            payload.end_granularity,
            payload.precision,
            next_version,
            now,
            payload.target_id,
            project_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_TEMPORAL_SCENE_VERSION_MISMATCH: scene '{}' patch conflict",
        payload.target_id
    );
    let scope_refresh_event =
        super::refresh_scene_scope_source_token_in_tx(conn, project_id, &payload.target_id, now)?;
    Ok((
        serde_json::json!({
            "sceneId": payload.target_id,
            "version": next_version,
            "updatedAt": now,
        }),
        scope_refresh_event,
    ))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporalStoryOrderMaterializePayload {
    pub scene_id: String,
    pub base_version: i64,
    pub story_time_order: String,
    #[serde(default)]
    pub story_time_label: Option<String>,
}

pub(crate) fn parse_story_order_materialize_payload(
    payload: &Value,
) -> anyhow::Result<TemporalStoryOrderMaterializePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid temporal.story-order.materialize payload: {err}"))
}

pub(crate) fn collect_scene_story_order_snapshot(
    conn: &Connection,
    scene_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'storyTimeOrder', story_time_order,
            'storyTimeLabel', story_time_label,
            'version', version
         ) FROM tree_nodes WHERE id = ?1",
        params![scene_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

/// Materialize the solver's derived reading-order projection onto
/// `tree_nodes.story_time_order` / `story_time_label` under OCC. The STN
/// solver itself is out of scope; this only persists its output.
pub(crate) fn apply_story_order_materialize_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &TemporalStoryOrderMaterializePayload,
    now: &str,
) -> anyhow::Result<TemporalPatchTxResult> {
    let live_version: Option<i64> = conn
        .query_row(
            "SELECT version FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![payload.scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(live_version) = live_version else {
        anyhow::bail!(
            "scene '{}' not found in project '{}'",
            payload.scene_id,
            project_id
        );
    };
    if live_version != payload.base_version {
        anyhow::bail!(
            "NEX_TEMPORAL_SCENE_VERSION_MISMATCH: scene '{}' expected version {}, found {}",
            payload.scene_id,
            payload.base_version,
            live_version
        );
    }

    let before_snapshot = collect_scene_story_order_snapshot(conn, &payload.scene_id)?;
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("scene version overflow"))?;
    let updated = conn.execute(
        "UPDATE tree_nodes
            SET story_time_order = ?1,
                story_time_label = ?2,
                version = ?3,
                updated_at = ?4
          WHERE id = ?5 AND version = ?6",
        params![
            payload.story_time_order,
            payload.story_time_label,
            next_version,
            now,
            payload.scene_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_TEMPORAL_SCENE_VERSION_MISMATCH: scene '{}' story-order conflict",
        payload.scene_id
    );
    let scope_refresh_event =
        super::refresh_scene_scope_source_token_in_tx(conn, project_id, &payload.scene_id, now)?;
    let after_snapshot = collect_scene_story_order_snapshot(conn, &payload.scene_id)?;
    Ok(TemporalPatchTxResult {
        entity_id: payload.scene_id.clone(),
        version: next_version,
        after_snapshot,
        before_snapshot,
        scope_refresh_event: Some(scope_refresh_event),
    })
}

pub(crate) fn restore_scene_story_order_patch(
    conn: &Connection,
    scene_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<(i64, NarrativeChangeEventInput)> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM tree_nodes WHERE id = ?1",
        params![scene_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!("NEX_COMMIT_SCENE_EDITED: scene '{scene_id}' was modified after commit");
    }
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("scene version overflow during undo"))?;
    let updated = conn.execute(
        "UPDATE tree_nodes
            SET story_time_order = ?1,
                story_time_label = ?2,
                version = ?3,
                updated_at = ?4
          WHERE id = ?5 AND version = ?6",
        params![
            before_snapshot
                .get("storyTimeOrder")
                .and_then(Value::as_str),
            before_snapshot
                .get("storyTimeLabel")
                .and_then(Value::as_str),
            next_version,
            now,
            scene_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_SCENE_EDITED: scene '{scene_id}' restore conflict"
    );
    let scope_refresh_event =
        super::refresh_scene_scope_source_token_for_scene_in_tx(conn, scene_id, now)?;
    Ok((next_version, scope_refresh_event))
}

/// OCC for `project_calendar.version`, checked once at commit start whenever
/// the plan carries a calendar-dependent Temporal operation. A missing
/// calendar row reads as version 0 (its `DEFAULT`).
pub(crate) fn ensure_calendar_version(
    conn: &Connection,
    project_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let live_version: i64 = conn
        .query_row(
            "SELECT version FROM project_calendar WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if live_version != expected_version {
        anyhow::bail!(
            "NEX_TEMPORAL_CALENDAR_VERSION_MISMATCH: project '{project_id}' expected calendar version {expected_version}, found {live_version}"
        );
    }
    Ok(())
}
