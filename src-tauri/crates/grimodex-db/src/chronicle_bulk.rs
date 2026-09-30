//! Atomic Chronicle selection mutations shared by Electron renderer commands.
//!
//! A single user action can target both `events` and scene projections stored
//! in `tree_nodes`. Keeping this implementation below the N-API boundary gives
//! the mixed selection one SQLite transaction, one undo journal entry, and one
//! change event instead of renderer-side writes with partial commits.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use grimodex_core::chronicle_time::{
    validate_canonical_chronicle_date_range, ChronicleDateRange, ChronicleTimestamp,
};

use crate::agent_writes::canonical_payload_with_authority_context;
use crate::agent_writes::{
    apply_event_snapshot, chronicle_event_transition_input, collect_event_snapshot,
    delete_event_cascade, validate_renderer_chronicle_context, RendererCanonicalWriteContext,
};
use crate::canonical_feed_snapshots::canonical_scene_snapshot;
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, payload_fingerprint, IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_narrative_change_transaction_in_tx, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::Database;

const BULK_ENTITY_KIND: &str = "chronicle_bulk";
const BULK_IDEMPOTENCY_DOMAIN: &str = "agent_chronicle_bulk_mutate";
const MAX_CHRONICLE_BULK_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHRONICLE_BULK_JOURNAL_BYTES: usize = 16 * 1024 * 1024;
const SQLITE_READ_CHUNK_ROWS: usize = 400;

fn narrative_origin_for_surface(surface: Option<&str>) -> NarrativeChangeOrigin {
    match surface.unwrap_or("manual") {
        "in-app-agent" | "mcp" => NarrativeChangeOrigin::AiApply,
        "import" => NarrativeChangeOrigin::Import,
        _ => NarrativeChangeOrigin::Human,
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChronicleBulkOperation {
    EventDelete {
        event_id: String,
        base_version: i64,
    },
    EventClearDate {
        event_id: String,
        base_version: i64,
    },
    EventSetLane {
        event_id: String,
        base_version: i64,
        primary_codex_id: Option<String>,
        lane_group: Option<String>,
    },
    EventSetDate {
        event_id: String,
        base_version: i64,
        start_time: i64,
        start_minute: Option<i64>,
        start_granularity: String,
        end_time: Option<i64>,
        end_minute: Option<i64>,
        end_granularity: String,
    },
    SceneClearDate {
        scene_id: String,
        base_updated_at: String,
    },
    SceneSetPov {
        scene_id: String,
        base_updated_at: String,
        pov_character_id: Option<String>,
    },
    SceneSetDate {
        scene_id: String,
        base_updated_at: String,
        start_time: i64,
        start_minute: Option<i64>,
        start_granularity: String,
        end_time: Option<i64>,
        end_minute: Option<i64>,
        end_granularity: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChronicleBulkPayload {
    request_id: String,
    project_id: String,
    session_id: String,
    surface: Option<String>,
    operations: Vec<ChronicleBulkOperation>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BulkEventState {
    kind: String,
    event_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fields: Option<BulkEventFields>,
    last_version: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "stateKind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum BulkEventFields {
    Date {
        start_time: Option<i64>,
        start_minute: Option<i64>,
        start_granularity: String,
        end_time: Option<i64>,
        end_minute: Option<i64>,
        end_granularity: String,
        updated_at: String,
        version: i64,
    },
    Lane {
        primary_codex_id: Option<String>,
        lane_group: Option<String>,
        updated_at: String,
        version: i64,
    },
}

impl BulkEventFields {
    fn version(&self) -> i64 {
        match self {
            Self::Date { version, .. } | Self::Lane { version, .. } => *version,
        }
    }

    fn set_version(&mut self, next: i64) {
        match self {
            Self::Date { version, .. } | Self::Lane { version, .. } => *version = next,
        }
    }
}

#[derive(Debug, Clone)]
struct BulkEventRecord {
    event_id: String,
    primary_codex_id: Option<String>,
    lane_group: Option<String>,
    start_time: Option<i64>,
    start_minute: Option<i64>,
    start_granularity: String,
    end_time: Option<i64>,
    end_minute: Option<i64>,
    end_granularity: String,
    updated_at: String,
    version: i64,
}

#[derive(Debug, Clone)]
struct BulkSceneRecord {
    scene_id: String,
    pov_character_id: Option<String>,
    chronicle_start_time: Option<i64>,
    chronicle_start_minute: Option<i64>,
    chronicle_start_granularity: String,
    chronicle_end_time: Option<i64>,
    chronicle_end_minute: Option<i64>,
    chronicle_end_granularity: String,
    chronicle_precision: String,
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BulkSceneState {
    kind: String,
    scene_id: String,
    pov_character_id: Option<String>,
    chronicle_start_time: Option<i64>,
    chronicle_start_minute: Option<i64>,
    chronicle_start_granularity: String,
    chronicle_end_time: Option<i64>,
    chronicle_end_minute: Option<i64>,
    chronicle_end_granularity: String,
    chronicle_precision: String,
    updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChronicleBulkSnapshot {
    events: Vec<BulkEventState>,
    scenes: Vec<BulkSceneState>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BulkEventResult {
    kind: String,
    event_id: String,
    version: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BulkSceneResult {
    kind: String,
    scene_id: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentChronicleBulkResult {
    event_results: Vec<BulkEventResult>,
    scene_results: Vec<BulkSceneResult>,
    change_event_uid: String,
    undo_journal_id: String,
}

fn event_snapshot_version(snapshot: &Value) -> anyhow::Result<i64> {
    snapshot["eventData"]["version"]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("chronicle bulk event snapshot missing version"))
}

fn set_event_snapshot_version(snapshot: &mut Value, version: i64) -> anyhow::Result<()> {
    let event_data = snapshot
        .get_mut("eventData")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow::anyhow!("chronicle bulk event snapshot missing eventData"))?;
    event_data.insert("version".to_string(), json!(version));
    Ok(())
}

fn checked_next_version(version: i64) -> anyhow::Result<i64> {
    version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("chronicle bulk event version overflow"))
}

fn validate_absolute_date(
    start_time: i64,
    start_minute: Option<i64>,
    start_granularity: &str,
    end_time: Option<i64>,
    end_minute: Option<i64>,
    end_granularity: &str,
) -> anyhow::Result<()> {
    validate_canonical_chronicle_date_range(ChronicleDateRange {
        start: ChronicleTimestamp {
            day: Some(start_time),
            minute: start_minute,
            granularity: start_granularity,
        },
        end: ChronicleTimestamp {
            day: end_time,
            minute: end_minute,
            granularity: end_granularity,
        },
    })?;
    Ok(())
}

fn fresh_updated_at(previous: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    if now == previous {
        (chrono::Utc::now() + chrono::Duration::nanoseconds(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
    } else {
        now
    }
}

fn event_snapshot_related_ids(snapshot: &Value) -> Vec<String> {
    let mut related = BTreeSet::new();
    for key in ["asCause", "asEffect"] {
        if let Some(relations) = snapshot["relations"][key].as_array() {
            for relation in relations {
                for field in ["causeEventId", "effectEventId"] {
                    if let Some(id) = relation[field].as_str() {
                        related.insert(id.to_string());
                    }
                }
            }
        }
    }
    related.into_iter().collect()
}

fn bulk_change_target_metadata(snapshot: &ChronicleBulkSnapshot) -> Value {
    let event_ids = snapshot
        .events
        .iter()
        .map(|state| state.event_id.clone())
        .collect::<Vec<_>>();
    let scene_ids = snapshot
        .scenes
        .iter()
        .map(|state| state.scene_id.clone())
        .collect::<Vec<_>>();
    let operations = snapshot
        .events
        .iter()
        .map(|state| {
            json!({
                "kind": state.kind,
                "eventId": state.event_id,
            })
        })
        .chain(snapshot.scenes.iter().map(|state| {
            json!({
                "kind": state.kind,
                "sceneId": state.scene_id,
            })
        }))
        .collect::<Vec<_>>();
    let mut related_event_ids = BTreeSet::new();
    for state in &snapshot.events {
        if state.kind != "eventDelete" {
            continue;
        }
        if let Some(event_snapshot) = state.snapshot.as_ref() {
            related_event_ids.extend(event_snapshot_related_ids(event_snapshot));
        }
    }
    json!({
        "operations": operations,
        "eventIds": event_ids,
        "sceneIds": scene_ids,
        "relatedEventIds": related_event_ids.into_iter().collect::<Vec<_>>(),
    })
}

fn canonicalize_feed_snapshot(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                canonicalize_feed_snapshot(value);
            }
        }
        Value::Object(object) => {
            let old = std::mem::take(object);
            let mut entries = old.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (key, mut value) in entries {
                canonicalize_feed_snapshot(&mut value);
                object.insert(key, value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn feed_snapshot_digest(value: Option<&Value>) -> anyhow::Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let mut canonical = value.clone();
    canonicalize_feed_snapshot(&mut canonical);
    Ok(Some(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&canonical)?))
    )))
}

fn event_feed_state(state: &BulkEventState) -> anyhow::Result<Option<Value>> {
    match (&state.fields, &state.snapshot) {
        (Some(fields), None) => Ok(Some(serde_json::to_value(fields)?)),
        (None, Some(snapshot)) => Ok(Some(snapshot.clone())),
        (None, None) => Ok(None),
        (Some(_), Some(_)) => {
            anyhow::bail!("chronicle bulk event feed state mixes compact and composite snapshots")
        }
    }
}

fn event_feed_contract(kind: &str) -> anyhow::Result<(&'static str, Vec<String>)> {
    let (change_kind, paths): (&str, &[&str]) = match kind {
        "eventDelete" => ("metadata", &["/"]),
        "eventClearDate" | "eventSetDate" => (
            "calendar",
            &[
                "/startTime",
                "/startMinute",
                "/startGranularity",
                "/endTime",
                "/endMinute",
                "/endGranularity",
            ],
        ),
        "eventSetLane" => ("association", &["/primaryCodexId", "/laneGroup"]),
        other => anyhow::bail!("unsupported Chronicle bulk feed event kind '{other}'"),
    };
    Ok((
        change_kind,
        paths.iter().map(|path| (*path).to_string()).collect(),
    ))
}

fn scene_feed_contract(kind: &str) -> anyhow::Result<(&'static str, Vec<String>)> {
    let (change_kind, paths): (&str, &[&str]) = match kind {
        "sceneClearDate" | "sceneSetDate" => (
            "calendar",
            &[
                "/chronicleStartTime",
                "/chronicleStartMinute",
                "/chronicleStartGranularity",
                "/chronicleEndTime",
                "/chronicleEndMinute",
                "/chronicleEndGranularity",
            ],
        ),
        "sceneSetPov" => ("association", &["/povCharacterId"]),
        other => anyhow::bail!("unsupported Chronicle bulk feed scene kind '{other}'"),
    };
    Ok((
        change_kind,
        paths.iter().map(|path| (*path).to_string()).collect(),
    ))
}

fn event_feed_input(
    before: &BulkEventState,
    after: &BulkEventState,
) -> anyhow::Result<NarrativeChangeEventInput> {
    anyhow::ensure!(
        before.event_id == after.event_id && before.kind == after.kind,
        "chronicle bulk feed event snapshot identity mismatch"
    );
    let before_state = event_feed_state(before)?;
    let after_state = event_feed_state(after)?;
    let mutation_kind = match (before_state.is_some(), after_state.is_some()) {
        (true, true) => "update",
        (true, false) => "delete",
        (false, true) => "restore",
        other => anyhow::bail!("unsupported Chronicle bulk feed event transition {other:?}"),
    };
    let (change_kind, changed_paths) = event_feed_contract(&before.kind)?;
    Ok(NarrativeChangeEventInput {
        object_key: json!({
            "kind": "chronicle-event",
            "eventId": before.event_id,
        }),
        change_kind: change_kind.to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version: event_state_version(before)?,
        before_digest: feed_snapshot_digest(before_state.as_ref())?,
        after_version: event_state_version(after)?,
        after_digest: feed_snapshot_digest(after_state.as_ref())?,
        changed_paths: changed_paths.clone(),
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
    })
}

fn scene_feed_input(
    before: &BulkSceneState,
    after: &BulkSceneState,
) -> anyhow::Result<NarrativeChangeEventInput> {
    anyhow::ensure!(
        before.scene_id == after.scene_id && before.kind == after.kind,
        "chronicle bulk feed scene snapshot identity mismatch"
    );
    let before_state = serde_json::to_value(before)?;
    let after_state = serde_json::to_value(after)?;
    let (change_kind, changed_paths) = scene_feed_contract(&before.kind)?;
    Ok(NarrativeChangeEventInput {
        object_key: json!({
            "kind": "scene",
            "sceneId": before.scene_id,
        }),
        change_kind: change_kind.to_string(),
        mutation_kind: "update".to_string(),
        before_version: None,
        before_digest: feed_snapshot_digest(Some(&before_state))?,
        after_version: None,
        after_digest: feed_snapshot_digest(Some(&after_state))?,
        changed_paths: changed_paths.clone(),
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
    })
}

fn narrative_feed_events(
    before: &ChronicleBulkSnapshot,
    after: &ChronicleBulkSnapshot,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    anyhow::ensure!(
        before.events.len() == after.events.len() && before.scenes.len() == after.scenes.len(),
        "chronicle bulk feed snapshot shape mismatch"
    );
    let mut event_pairs = before.events.iter().zip(&after.events).collect::<Vec<_>>();
    event_pairs.sort_by(|(left, _), (right, _)| left.event_id.cmp(&right.event_id));
    let mut scene_pairs = before.scenes.iter().zip(&after.scenes).collect::<Vec<_>>();
    scene_pairs.sort_by(|(left, _), (right, _)| left.scene_id.cmp(&right.scene_id));

    event_pairs
        .into_iter()
        .map(|(before, after)| event_feed_input(before, after))
        .chain(
            scene_pairs
                .into_iter()
                .map(|(before, after)| scene_feed_input(before, after)),
        )
        .collect()
}

type FullEventFeedStates = BTreeMap<String, Option<Value>>;
type FullSceneFeedStates = BTreeMap<String, Value>;

fn bulk_event_feed_ids(snapshot: &ChronicleBulkSnapshot) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for state in &snapshot.events {
        ids.insert(state.event_id.clone());
        if state.kind == "eventDelete" {
            if let Some(event_snapshot) = state.snapshot.as_ref() {
                ids.extend(event_snapshot_related_ids(event_snapshot));
            }
        }
    }
    ids
}

fn collect_full_event_feed_states(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_ids: &BTreeSet<String>,
) -> anyhow::Result<FullEventFeedStates> {
    event_ids
        .iter()
        .map(|event_id| {
            let owned = conn
                .query_row(
                    "SELECT 1 FROM events WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![event_id, project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            let snapshot = owned
                .then(|| collect_event_snapshot(conn, event_id))
                .transpose()?;
            Ok((event_id.clone(), snapshot))
        })
        .collect()
}

fn bulk_scene_feed_ids(snapshot: &ChronicleBulkSnapshot) -> BTreeSet<String> {
    snapshot
        .scenes
        .iter()
        .map(|state| state.scene_id.clone())
        .collect()
}

fn collect_full_scene_feed_states(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_ids: &BTreeSet<String>,
) -> anyhow::Result<FullSceneFeedStates> {
    scene_ids
        .iter()
        .map(|scene_id| {
            Ok((
                scene_id.clone(),
                canonical_scene_snapshot(conn, project_id, scene_id)?,
            ))
        })
        .collect()
}

fn full_scene_feed_input(
    before: &BulkSceneState,
    after: &BulkSceneState,
    before_state: &Value,
    after_state: &Value,
) -> anyhow::Result<NarrativeChangeEventInput> {
    anyhow::ensure!(
        before.scene_id == after.scene_id && before.kind == after.kind,
        "chronicle bulk canonical scene snapshot identity mismatch"
    );
    let (change_kind, changed_paths) = scene_feed_contract(&before.kind)?;
    Ok(NarrativeChangeEventInput {
        object_key: json!({
            "kind": "scene",
            "sceneId": before.scene_id,
        }),
        change_kind: change_kind.to_string(),
        mutation_kind: "update".to_string(),
        before_version: before_state.get("version").and_then(Value::as_i64),
        before_digest: feed_snapshot_digest(Some(before_state))?,
        after_version: after_state.get("version").and_then(Value::as_i64),
        after_digest: feed_snapshot_digest(Some(after_state))?,
        changed_paths: changed_paths.clone(),
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
    })
}

fn narrative_feed_events_with_full_event_states(
    before: &ChronicleBulkSnapshot,
    after: &ChronicleBulkSnapshot,
    before_events: &FullEventFeedStates,
    after_events: &FullEventFeedStates,
    before_scenes: &FullSceneFeedStates,
    after_scenes: &FullSceneFeedStates,
    restore_when_created: bool,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    anyhow::ensure!(
        before.events.len() == after.events.len() && before.scenes.len() == after.scenes.len(),
        "chronicle bulk feed snapshot shape mismatch"
    );
    let primary_contracts = before
        .events
        .iter()
        .zip(&after.events)
        .map(|(before_state, after_state)| {
            anyhow::ensure!(
                before_state.event_id == after_state.event_id
                    && before_state.kind == after_state.kind,
                "chronicle bulk feed event snapshot identity mismatch"
            );
            let (change_kind, paths) = event_feed_contract(&before_state.kind)?;
            Ok((
                before_state.event_id.clone(),
                (change_kind.to_string(), paths),
            ))
        })
        .collect::<anyhow::Result<BTreeMap<_, _>>>()?;

    let mut event_ids = before_events
        .keys()
        .chain(after_events.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    event_ids.extend(primary_contracts.keys().cloned());
    let mut events = event_ids
        .into_iter()
        .map(|event_id| {
            let (change_kind, paths) = primary_contracts
                .get(&event_id)
                .cloned()
                .unwrap_or_else(|| ("association".to_string(), vec!["/relations".to_string()]));
            chronicle_event_transition_input(
                &event_id,
                before_events.get(&event_id).and_then(Option::as_ref),
                after_events.get(&event_id).and_then(Option::as_ref),
                &change_kind,
                paths,
                restore_when_created,
            )
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let mut scene_pairs = before.scenes.iter().zip(&after.scenes).collect::<Vec<_>>();
    scene_pairs.sort_by(|(left, _), (right, _)| left.scene_id.cmp(&right.scene_id));
    events.extend(
        scene_pairs
            .into_iter()
            .map(|(before, after)| {
                full_scene_feed_input(
                    before,
                    after,
                    before_scenes.get(&before.scene_id).ok_or_else(|| {
                        anyhow::anyhow!(
                            "chronicle bulk before snapshot missing scene '{}'",
                            before.scene_id
                        )
                    })?,
                    after_scenes.get(&after.scene_id).ok_or_else(|| {
                        anyhow::anyhow!(
                            "chronicle bulk after snapshot missing scene '{}'",
                            after.scene_id
                        )
                    })?,
                )
            })
            .collect::<anyhow::Result<Vec<_>>>()?,
    );
    Ok(events)
}

pub(crate) fn narrative_feed_events_from_journal(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: NarrativeChangeCauseKind,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    anyhow::ensure!(
        row.entity_kind == BULK_ENTITY_KIND,
        "Chronicle bulk Feed replay requires a Chronicle bulk Undo Journal"
    );
    let before: ChronicleBulkSnapshot = serde_json::from_str(
        row.before_json
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Chronicle bulk journal missing before_json"))?,
    )?;
    let after: ChronicleBulkSnapshot = serde_json::from_str(
        row.after_json
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Chronicle bulk journal missing after_json"))?,
    )?;
    match direction {
        NarrativeChangeCauseKind::Forward | NarrativeChangeCauseKind::Redo => {
            narrative_feed_events(&before, &after)
        }
        NarrativeChangeCauseKind::Undo => narrative_feed_events(&after, &before),
    }
}

pub(crate) fn enrich_replay_change_payload(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    payload: &mut Value,
) -> anyhow::Result<()> {
    let raw = row
        .before_json
        .as_deref()
        .or(row.after_json.as_deref())
        .ok_or_else(|| anyhow::anyhow!("chronicle bulk replay snapshot missing"))?;
    let snapshot: ChronicleBulkSnapshot = serde_json::from_str(raw)?;
    let metadata = bulk_change_target_metadata(&snapshot);
    let object = payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("chronicle bulk replay payload must be an object"))?;
    let metadata = metadata
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("chronicle bulk target metadata must be an object"))?;
    object.extend(metadata.clone());
    Ok(())
}

fn load_event_records(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_ids: &BTreeSet<String>,
) -> anyhow::Result<BTreeMap<String, BulkEventRecord>> {
    let mut records = BTreeMap::new();
    let ids = event_ids.iter().collect::<Vec<_>>();
    for chunk in ids.chunks(SQLITE_READ_CHUNK_ROWS) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT id, primary_codex_id, lane_group,
                    start_time, start_minute, start_granularity,
                    end_time, end_minute, end_granularity,
                    updated_at, version
               FROM events
              WHERE project_id = ? AND id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(
                std::iter::once(project_id).chain(chunk.iter().map(|id| id.as_str())),
            ),
            |row| {
                Ok(BulkEventRecord {
                    event_id: row.get(0)?,
                    primary_codex_id: row.get(1)?,
                    lane_group: row.get(2)?,
                    start_time: row.get(3)?,
                    start_minute: row.get(4)?,
                    start_granularity: row.get(5)?,
                    end_time: row.get(6)?,
                    end_minute: row.get(7)?,
                    end_granularity: row.get(8)?,
                    updated_at: row.get(9)?,
                    version: row.get(10)?,
                })
            },
        )?;
        for row in rows {
            let record = row?;
            records.insert(record.event_id.clone(), record);
        }
    }
    Ok(records)
}

fn load_scene_records(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_ids: &BTreeSet<String>,
) -> anyhow::Result<BTreeMap<String, BulkSceneRecord>> {
    let mut records = BTreeMap::new();
    let ids = scene_ids.iter().collect::<Vec<_>>();
    for chunk in ids.chunks(SQLITE_READ_CHUNK_ROWS) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT id, pov_character_id,
                    chronicle_start_time, chronicle_start_minute,
                    chronicle_start_granularity,
                    chronicle_end_time, chronicle_end_minute,
                    chronicle_end_granularity, chronicle_precision, updated_at
               FROM tree_nodes
              WHERE project_id = ? AND node_type = 'scene'
                AND id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(
                std::iter::once(project_id).chain(chunk.iter().map(|id| id.as_str())),
            ),
            |row| {
                Ok(BulkSceneRecord {
                    scene_id: row.get(0)?,
                    pov_character_id: row.get(1)?,
                    chronicle_start_time: row.get(2)?,
                    chronicle_start_minute: row.get(3)?,
                    chronicle_start_granularity: row.get(4)?,
                    chronicle_end_time: row.get(5)?,
                    chronicle_end_minute: row.get(6)?,
                    chronicle_end_granularity: row.get(7)?,
                    chronicle_precision: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )?;
        for row in rows {
            let record = row?;
            records.insert(record.scene_id.clone(), record);
        }
    }
    Ok(records)
}

fn ensure_codex_ids_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    codex_ids: &BTreeSet<String>,
) -> anyhow::Result<()> {
    let ids = codex_ids.iter().collect::<Vec<_>>();
    let mut found = BTreeSet::new();
    for chunk in ids.chunks(SQLITE_READ_CHUNK_ROWS) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT id FROM codex_entries
              WHERE project_id = ? AND id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(
                std::iter::once(project_id).chain(chunk.iter().map(|id| id.as_str())),
            ),
            |row| row.get::<_, String>(0),
        )?;
        for row in rows {
            found.insert(row?);
        }
    }
    if let Some(missing) = codex_ids.iter().find(|id| !found.contains(*id)) {
        anyhow::bail!("codex entry '{missing}' not found in project '{project_id}'");
    }
    Ok(())
}

fn event_fields(record: &BulkEventRecord, kind: &str) -> anyhow::Result<BulkEventFields> {
    match kind {
        "eventClearDate" | "eventSetDate" => Ok(BulkEventFields::Date {
            start_time: record.start_time,
            start_minute: record.start_minute,
            start_granularity: record.start_granularity.clone(),
            end_time: record.end_time,
            end_minute: record.end_minute,
            end_granularity: record.end_granularity.clone(),
            updated_at: record.updated_at.clone(),
            version: record.version,
        }),
        "eventSetLane" => Ok(BulkEventFields::Lane {
            primary_codex_id: record.primary_codex_id.clone(),
            lane_group: record.lane_group.clone(),
            updated_at: record.updated_at.clone(),
            version: record.version,
        }),
        other => anyhow::bail!("chronicle bulk operation '{other}' has no compact event state"),
    }
}

fn scene_state(record: &BulkSceneRecord, kind: &str) -> BulkSceneState {
    BulkSceneState {
        kind: kind.to_string(),
        scene_id: record.scene_id.clone(),
        pov_character_id: record.pov_character_id.clone(),
        chronicle_start_time: record.chronicle_start_time,
        chronicle_start_minute: record.chronicle_start_minute,
        chronicle_start_granularity: record.chronicle_start_granularity.clone(),
        chronicle_end_time: record.chronicle_end_time,
        chronicle_end_minute: record.chronicle_end_minute,
        chronicle_end_granularity: record.chronicle_end_granularity.clone(),
        chronicle_precision: record.chronicle_precision.clone(),
        updated_at: record.updated_at.clone(),
    }
}

fn update_scene_to_state(
    conn: &rusqlite::Connection,
    project_id: &str,
    expected_updated_at: &str,
    target: &BulkSceneState,
) -> anyhow::Result<NarrativeChangeEventInput> {
    let updated = conn.execute(
        "UPDATE tree_nodes
            SET pov_character_id = ?1,
                chronicle_start_time = ?2,
                chronicle_start_minute = ?3,
                chronicle_start_granularity = ?4,
                chronicle_end_time = ?5,
                chronicle_end_minute = ?6,
                chronicle_end_granularity = ?7,
                chronicle_precision = ?8,
                updated_at = ?9
          WHERE id = ?10 AND project_id = ?11 AND node_type = 'scene'
            AND updated_at = ?12",
        rusqlite::params![
            target.pov_character_id,
            target.chronicle_start_time,
            target.chronicle_start_minute,
            target.chronicle_start_granularity,
            target.chronicle_end_time,
            target.chronicle_end_minute,
            target.chronicle_end_granularity,
            target.chronicle_precision,
            target.updated_at,
            target.scene_id,
            project_id,
            expected_updated_at,
        ],
    )?;
    if updated == 0 {
        anyhow::bail!(
            "scene '{}' update conflict: expected updatedAt '{}'",
            target.scene_id,
            expected_updated_at
        );
    }
    crate::narrative_extraction::refresh_scene_scope_source_token_in_tx(
        conn,
        project_id,
        &target.scene_id,
        &target.updated_at,
    )
}

fn event_state_version(state: &BulkEventState) -> anyhow::Result<Option<i64>> {
    match (&state.fields, &state.snapshot) {
        (Some(fields), None) => Ok(Some(fields.version())),
        (None, Some(snapshot)) => Ok(Some(event_snapshot_version(snapshot)?)),
        (None, None) => Ok(None),
        (Some(_), Some(_)) => {
            anyhow::bail!("chronicle bulk event state mixes compact and composite snapshots")
        }
    }
}

fn update_event_to_fields(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    expected_version: i64,
    target: &mut BulkEventFields,
) -> anyhow::Result<i64> {
    let next = checked_next_version(expected_version)?;
    let updated = match target {
        BulkEventFields::Date {
            start_time,
            start_minute,
            start_granularity,
            end_time,
            end_minute,
            end_granularity,
            updated_at,
            ..
        } => conn.execute(
            "UPDATE events
                SET start_time = ?1, start_minute = ?2,
                    start_granularity = ?3, end_time = ?4,
                    end_minute = ?5, end_granularity = ?6,
                    updated_at = ?7, version = ?8
              WHERE id = ?9 AND project_id = ?10 AND version = ?11",
            rusqlite::params![
                *start_time,
                *start_minute,
                start_granularity.as_str(),
                *end_time,
                *end_minute,
                end_granularity.as_str(),
                updated_at.as_str(),
                next,
                event_id,
                project_id,
                expected_version,
            ],
        )?,
        BulkEventFields::Lane {
            primary_codex_id,
            lane_group,
            updated_at,
            ..
        } => conn.execute(
            "UPDATE events
                SET primary_codex_id = ?1, lane_group = ?2,
                    updated_at = ?3, version = ?4
              WHERE id = ?5 AND project_id = ?6 AND version = ?7",
            rusqlite::params![
                primary_codex_id.as_deref(),
                lane_group.as_deref(),
                updated_at.as_str(),
                next,
                event_id,
                project_id,
                expected_version,
            ],
        )?,
    };
    if updated != 1 {
        anyhow::bail!("event '{event_id}' version conflict: expected {expected_version}");
    }
    target.set_version(next);
    Ok(next)
}

fn load_event_versions(
    conn: &rusqlite::Connection,
    event_ids: &BTreeSet<String>,
) -> anyhow::Result<BTreeMap<String, (String, i64)>> {
    let mut versions = BTreeMap::new();
    let ids = event_ids.iter().collect::<Vec<_>>();
    for chunk in ids.chunks(SQLITE_READ_CHUNK_ROWS) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql =
            format!("SELECT id, project_id, version FROM events WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(chunk.iter().map(|id| id.as_str())),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?;
        for row in rows {
            let (event_id, project_id, version) = row?;
            versions.insert(event_id, (project_id, version));
        }
    }
    Ok(versions)
}

fn serialize_bounded_journal(
    before: &ChronicleBulkSnapshot,
    after: &ChronicleBulkSnapshot,
) -> anyhow::Result<(String, String)> {
    let before_json = serde_json::to_string(before)?;
    let after_json = serde_json::to_string(after)?;
    if before_json.len().saturating_add(after_json.len()) > MAX_CHRONICLE_BULK_JOURNAL_BYTES {
        anyhow::bail!("chronicle bulk undo snapshot exceeds the 16 MiB limit");
    }
    Ok((before_json, after_json))
}

fn validate_snapshot_pair(
    target: &ChronicleBulkSnapshot,
    current: &ChronicleBulkSnapshot,
) -> anyhow::Result<()> {
    if target.events.len() != current.events.len() || target.scenes.len() != current.scenes.len() {
        anyhow::bail!("chronicle bulk journal snapshot shape mismatch");
    }
    for (target, current) in target.events.iter().zip(&current.events) {
        if target.event_id != current.event_id || target.kind != current.kind {
            anyhow::bail!("chronicle bulk event journal identity mismatch");
        }
        event_state_version(target)?;
        event_state_version(current)?;
        match (&target.fields, &current.fields) {
            (Some(target_fields), Some(current_fields))
                if std::mem::discriminant(target_fields)
                    != std::mem::discriminant(current_fields) =>
            {
                anyhow::bail!("chronicle bulk compact event journal shape mismatch");
            }
            (Some(_), None) | (None, Some(_)) => {
                anyhow::bail!("chronicle bulk compact event journal state mismatch");
            }
            _ => {}
        }
    }
    for (target, current) in target.scenes.iter().zip(&current.scenes) {
        if target.scene_id != current.scene_id || target.kind != current.kind {
            anyhow::bail!("chronicle bulk scene journal identity mismatch");
        }
    }
    Ok(())
}

/// Replay a bulk journal inside the caller-owned undo transaction.
pub(crate) fn replay_chronicle_bulk_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let (target_raw, current_raw, target_column) = match direction {
        "undo" => (
            row.before_json.as_deref(),
            row.after_json.as_deref(),
            "before_json",
        ),
        "redo" => (
            row.after_json.as_deref(),
            row.before_json.as_deref(),
            "after_json",
        ),
        other => anyhow::bail!("invalid undo direction: {other}"),
    };
    let mut target: ChronicleBulkSnapshot = serde_json::from_str(
        target_raw.ok_or_else(|| anyhow::anyhow!("chronicle bulk target snapshot missing"))?,
    )?;
    let current: ChronicleBulkSnapshot = serde_json::from_str(
        current_raw.ok_or_else(|| anyhow::anyhow!("chronicle bulk current snapshot missing"))?,
    )?;
    validate_snapshot_pair(&target, &current)?;
    let mut feed_event_ids = bulk_event_feed_ids(&current);
    feed_event_ids.extend(bulk_event_feed_ids(&target));
    let before_event_feed = collect_full_event_feed_states(conn, project_id, &feed_event_ids)?;
    let mut feed_scene_ids = bulk_scene_feed_ids(&current);
    feed_scene_ids.extend(bulk_scene_feed_ids(&target));
    let before_scene_feed = collect_full_scene_feed_states(conn, project_id, &feed_scene_ids)?;

    // Validate the complete observed state with chunked set-based reads before
    // touching either table.
    let event_ids = current
        .events
        .iter()
        .map(|state| state.event_id.clone())
        .collect::<BTreeSet<_>>();
    let versions = load_event_versions(conn, &event_ids)?;
    for state in &current.events {
        match event_state_version(state)? {
            Some(expected) => {
                let found = versions.get(&state.event_id);
                if !matches!(found, Some((owner, version)) if owner == project_id && *version == expected)
                {
                    anyhow::bail!(
                        "event '{}' version conflict during chronicle bulk replay: expected {}, found {:?}",
                        state.event_id,
                        expected,
                        found
                    );
                }
            }
            None if versions.contains_key(&state.event_id) => {
                anyhow::bail!(
                    "event '{}' was recreated before chronicle bulk replay",
                    state.event_id
                );
            }
            None => {}
        }
    }

    let scene_ids = current
        .scenes
        .iter()
        .map(|state| state.scene_id.clone())
        .collect::<BTreeSet<_>>();
    let scene_records = load_scene_records(conn, project_id, &scene_ids)?;
    for state in &current.scenes {
        if scene_records
            .get(&state.scene_id)
            .map(|record| record.updated_at.as_str())
            != Some(state.updated_at.as_str())
        {
            anyhow::bail!(
                "scene '{}' update conflict during chronicle bulk replay",
                state.scene_id
            );
        }
    }

    let mut target_codex_ids = target
        .scenes
        .iter()
        .filter_map(|state| state.pov_character_id.clone())
        .collect::<BTreeSet<_>>();
    for state in &target.events {
        if let Some(BulkEventFields::Lane {
            primary_codex_id: Some(codex_id),
            ..
        }) = state.fields.as_ref()
        {
            target_codex_ids.insert(codex_id.clone());
        }
    }
    ensure_codex_ids_in_project(conn, project_id, &target_codex_ids)?;

    // Restore/delete event rows first. Associations for restored deletes are
    // deferred until every selected event row exists, so a relation between
    // two events deleted by the same action can be restored safely.
    let mut association_restores = Vec::new();
    for (index, (target_state, current_state)) in
        target.events.iter_mut().zip(&current.events).enumerate()
    {
        if let (Some(target_fields), Some(current_fields)) =
            (target_state.fields.as_mut(), current_state.fields.as_ref())
        {
            let next = update_event_to_fields(
                conn,
                project_id,
                &target_state.event_id,
                current_fields.version(),
                target_fields,
            )?;
            target_state.last_version = next;
            continue;
        }
        match (&mut target_state.snapshot, &current_state.snapshot) {
            (Some(target_snapshot), Some(current_snapshot)) => {
                let expected = event_snapshot_version(current_snapshot)?;
                let next = checked_next_version(expected)?;
                apply_event_snapshot(conn, project_id, target_snapshot, Some(next), false)?;
                set_event_snapshot_version(target_snapshot, next)?;
                target_state.last_version = next;
            }
            (Some(target_snapshot), None) => {
                let next = checked_next_version(current_state.last_version)?;
                apply_event_snapshot(conn, project_id, target_snapshot, Some(next), false)?;
                set_event_snapshot_version(target_snapshot, next)?;
                target_state.last_version = next;
                association_restores.push(index);
            }
            (None, Some(current_snapshot)) => {
                let expected = event_snapshot_version(current_snapshot)?;
                delete_event_cascade(conn, project_id, &target_state.event_id, Some(expected))?;
                target_state.last_version = expected;
            }
            (None, None) => {
                anyhow::bail!(
                    "chronicle bulk journal has no state for event '{}'",
                    target_state.event_id
                );
            }
        }
    }
    for index in association_restores {
        let target_state = &target.events[index];
        let snapshot = target_state
            .snapshot
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("chronicle bulk restore snapshot disappeared"))?;
        let version = event_snapshot_version(snapshot)?;
        apply_event_snapshot(conn, project_id, snapshot, Some(version), true)?;
    }

    let mut scene_scope_refresh_events = Vec::new();
    for (target_state, current_state) in target.scenes.iter_mut().zip(&current.scenes) {
        target_state.updated_at = fresh_updated_at(&current_state.updated_at);
        scene_scope_refresh_events.push(update_scene_to_state(
            conn,
            project_id,
            &current_state.updated_at,
            target_state,
        )?);
    }

    let serialized = serde_json::to_string(&target)?;
    let updated = match target_column {
        "before_json" => conn.execute(
            "UPDATE undo_journal SET before_json = ?1
              WHERE id = ?2 AND project_id = ?3 AND entity_kind = ?4",
            rusqlite::params![serialized, row.id, project_id, BULK_ENTITY_KIND],
        )?,
        "after_json" => conn.execute(
            "UPDATE undo_journal SET after_json = ?1
              WHERE id = ?2 AND project_id = ?3 AND entity_kind = ?4",
            rusqlite::params![serialized, row.id, project_id, BULK_ENTITY_KIND],
        )?,
        _ => unreachable!(),
    };
    if updated != 1 {
        anyhow::bail!("chronicle bulk journal state update failed");
    }
    let after_event_feed = collect_full_event_feed_states(conn, project_id, &feed_event_ids)?;
    let after_scene_feed = collect_full_scene_feed_states(conn, project_id, &feed_scene_ids)?;
    let mut events = narrative_feed_events_with_full_event_states(
        &current,
        &target,
        &before_event_feed,
        &after_event_feed,
        &before_scene_feed,
        &after_scene_feed,
        true,
    )?;
    events.extend(scene_scope_refresh_events);
    Ok(events)
}

pub fn agent_chronicle_bulk_mutate_impl(
    db: &Database,
    payload: AgentChronicleBulkPayload,
) -> anyhow::Result<Value> {
    agent_chronicle_bulk_mutate_with_authority_impl(db, payload, None)
}

pub fn agent_chronicle_bulk_mutate_with_authority_impl(
    db: &Database,
    payload: AgentChronicleBulkPayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    if payload.request_id.is_empty() {
        anyhow::bail!("chronicle bulk requestId must not be empty");
    }
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_chronicle_context(&payload.request_id, context)?;
    }
    if payload.operations.is_empty() {
        anyhow::bail!("chronicle bulk operations must not be empty");
    }
    if serde_json::to_vec(&payload)?.len() > MAX_CHRONICLE_BULK_PAYLOAD_BYTES {
        anyhow::bail!("chronicle bulk payload exceeds the 8 MiB limit");
    }
    let fingerprint_payload = json!({
        "projectId": payload.project_id,
        "operations": payload.operations,
    });
    let payload_hash = payload_fingerprint(BULK_IDEMPOTENCY_DOMAIN, &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: BULK_IDEMPOTENCY_DOMAIN,
        request_id: Some(&payload.request_id),
        payload_hash: &payload_hash,
        conflict_marker: "CHRONICLE_BULK_IDEMPOTENCY_CONFLICT",
    };
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(existing) = load_idempotent_response(conn, &idempotency_request)? {
                return Ok(existing);
            }
            let mut targets = BTreeSet::new();
            let mut event_ids = BTreeSet::new();
            let mut scene_ids = BTreeSet::new();
            let mut codex_ids = BTreeSet::new();

            // Validate operation-local input and collect every lookup key before
            // the first database read.
            for operation in &payload.operations {
                match operation {
                    ChronicleBulkOperation::EventDelete {
                        event_id,
                        base_version,
                    }
                    | ChronicleBulkOperation::EventClearDate {
                        event_id,
                        base_version,
                    }
                    | ChronicleBulkOperation::EventSetLane {
                        event_id,
                        base_version,
                        ..
                    }
                    | ChronicleBulkOperation::EventSetDate {
                        event_id,
                        base_version,
                        ..
                    } => {
                        if *base_version < 0 {
                            anyhow::bail!("event '{event_id}' has invalid negative base version");
                        }
                        if !targets.insert(format!("event:{event_id}")) {
                            anyhow::bail!("duplicate chronicle bulk event '{event_id}'");
                        }
                        event_ids.insert(event_id.clone());
                        if let ChronicleBulkOperation::EventSetLane {
                            primary_codex_id: Some(codex_id),
                            ..
                        } = operation
                        {
                            codex_ids.insert(codex_id.clone());
                        }
                        if let ChronicleBulkOperation::EventSetDate {
                            start_time,
                            start_minute,
                            start_granularity,
                            end_time,
                            end_minute,
                            end_granularity,
                            ..
                        } = operation
                        {
                            validate_absolute_date(
                                *start_time,
                                *start_minute,
                                start_granularity,
                                *end_time,
                                *end_minute,
                                end_granularity,
                            )?;
                        }
                    }
                    ChronicleBulkOperation::SceneClearDate { scene_id, .. }
                    | ChronicleBulkOperation::SceneSetPov { scene_id, .. }
                    | ChronicleBulkOperation::SceneSetDate { scene_id, .. } => {
                        if !targets.insert(format!("scene:{scene_id}")) {
                            anyhow::bail!("duplicate chronicle bulk scene '{scene_id}'");
                        }
                        scene_ids.insert(scene_id.clone());
                        if let ChronicleBulkOperation::SceneSetPov {
                            pov_character_id: Some(codex_id),
                            ..
                        } = operation
                        {
                            codex_ids.insert(codex_id.clone());
                        }
                        if let ChronicleBulkOperation::SceneSetDate {
                            start_time,
                            start_minute,
                            start_granularity,
                            end_time,
                            end_minute,
                            end_granularity,
                            ..
                        } = operation
                        {
                            validate_absolute_date(
                                *start_time,
                                *start_minute,
                                start_granularity,
                                *end_time,
                                *end_minute,
                                end_granularity,
                            )?;
                        }
                    }
                }
            }

            let event_records = load_event_records(conn, &payload.project_id, &event_ids)?;
            let scene_records = load_scene_records(conn, &payload.project_id, &scene_ids)?;
            ensure_codex_ids_in_project(conn, &payload.project_id, &codex_ids)?;

            let mut before = ChronicleBulkSnapshot::default();
            let mut after = ChronicleBulkSnapshot::default();

            // Build both journal sides before writing. Field-only operations
            // never materialize Event detail/associations; delete alone keeps
            // the full cascade-restorable composite.
            for operation in &payload.operations {
                match operation {
                    ChronicleBulkOperation::EventDelete {
                        event_id,
                        base_version,
                    }
                    | ChronicleBulkOperation::EventClearDate {
                        event_id,
                        base_version,
                    }
                    | ChronicleBulkOperation::EventSetLane {
                        event_id,
                        base_version,
                        ..
                    }
                    | ChronicleBulkOperation::EventSetDate {
                        event_id,
                        base_version,
                        ..
                    } => {
                        let record = event_records.get(event_id).ok_or_else(|| {
                            anyhow::anyhow!(
                                "event '{event_id}' not found in project '{}'",
                                payload.project_id
                            )
                        })?;
                        if record.version != *base_version {
                            anyhow::bail!(
                                "event '{event_id}' version conflict: expected {base_version}, found {}",
                                record.version
                            );
                        }
                        let kind = match operation {
                            ChronicleBulkOperation::EventDelete { .. } => "eventDelete",
                            ChronicleBulkOperation::EventClearDate { .. } => "eventClearDate",
                            ChronicleBulkOperation::EventSetLane { .. } => "eventSetLane",
                            ChronicleBulkOperation::EventSetDate { .. } => "eventSetDate",
                            _ => unreachable!(),
                        };

                        if matches!(operation, ChronicleBulkOperation::EventDelete { .. }) {
                            let snapshot = collect_event_snapshot(conn, event_id)?;
                            before.events.push(BulkEventState {
                                kind: kind.to_string(),
                                event_id: event_id.clone(),
                                snapshot: Some(snapshot),
                                fields: None,
                                last_version: *base_version,
                            });
                            after.events.push(BulkEventState {
                                kind: kind.to_string(),
                                event_id: event_id.clone(),
                                snapshot: None,
                                fields: None,
                                last_version: *base_version,
                            });
                            continue;
                        }

                        let fields = event_fields(record, kind)?;
                        let mut next_fields = fields.clone();
                        let next_version = checked_next_version(*base_version)?;
                        match (operation, &mut next_fields) {
                            (
                                ChronicleBulkOperation::EventClearDate { .. },
                                BulkEventFields::Date {
                                    start_time,
                                    start_minute,
                                    start_granularity,
                                    end_time,
                                    end_minute,
                                    end_granularity,
                                    updated_at,
                                    version,
                                },
                            ) => {
                                *start_time = None;
                                *start_minute = None;
                                *start_granularity = "none".to_string();
                                *end_time = None;
                                *end_minute = None;
                                *end_granularity = "none".to_string();
                                *updated_at = fresh_updated_at(&record.updated_at);
                                *version = next_version;
                            }
                            (
                                ChronicleBulkOperation::EventSetLane {
                                    primary_codex_id,
                                    lane_group,
                                    ..
                                },
                                BulkEventFields::Lane {
                                    primary_codex_id: next_primary,
                                    lane_group: next_group,
                                    updated_at,
                                    version,
                                },
                            ) => {
                                *next_primary = primary_codex_id.clone();
                                *next_group = lane_group.clone();
                                *updated_at = fresh_updated_at(&record.updated_at);
                                *version = next_version;
                            }
                            (
                                ChronicleBulkOperation::EventSetDate {
                                    start_time: next_start,
                                    start_minute: next_start_minute,
                                    start_granularity: next_start_granularity,
                                    end_time: next_end,
                                    end_minute: next_end_minute,
                                    end_granularity: next_end_granularity,
                                    ..
                                },
                                BulkEventFields::Date {
                                    start_time,
                                    start_minute,
                                    start_granularity,
                                    end_time,
                                    end_minute,
                                    end_granularity,
                                    updated_at,
                                    version,
                                },
                            ) => {
                                *start_time = Some(*next_start);
                                *start_minute = *next_start_minute;
                                *start_granularity = next_start_granularity.clone();
                                *end_time = *next_end;
                                *end_minute = *next_end_minute;
                                *end_granularity = next_end_granularity.clone();
                                *updated_at = fresh_updated_at(&record.updated_at);
                                *version = next_version;
                            }
                            _ => anyhow::bail!(
                                "chronicle bulk compact event state does not match '{kind}'"
                            ),
                        }
                        before.events.push(BulkEventState {
                            kind: kind.to_string(),
                            event_id: event_id.clone(),
                            snapshot: None,
                            fields: Some(fields),
                            last_version: *base_version,
                        });
                        after.events.push(BulkEventState {
                            kind: kind.to_string(),
                            event_id: event_id.clone(),
                            snapshot: None,
                            fields: Some(next_fields),
                            last_version: next_version,
                        });
                    }
                    ChronicleBulkOperation::SceneClearDate {
                        scene_id,
                        base_updated_at,
                    }
                    | ChronicleBulkOperation::SceneSetPov {
                        scene_id,
                        base_updated_at,
                        ..
                    }
                    | ChronicleBulkOperation::SceneSetDate {
                        scene_id,
                        base_updated_at,
                        ..
                    } => {
                        let record = scene_records.get(scene_id).ok_or_else(|| {
                            anyhow::anyhow!(
                                "scene '{scene_id}' not found in project '{}'",
                                payload.project_id
                            )
                        })?;
                        if record.updated_at != *base_updated_at {
                            anyhow::bail!(
                                "scene '{scene_id}' update conflict: expected updatedAt '{base_updated_at}', found '{}'",
                                record.updated_at
                            );
                        }
                        let kind = match operation {
                            ChronicleBulkOperation::SceneClearDate { .. } => "sceneClearDate",
                            ChronicleBulkOperation::SceneSetPov { .. } => "sceneSetPov",
                            ChronicleBulkOperation::SceneSetDate { .. } => "sceneSetDate",
                            _ => unreachable!(),
                        };
                        let current = scene_state(record, kind);
                        let mut next = current.clone();
                        next.updated_at = fresh_updated_at(&record.updated_at);
                        match operation {
                            ChronicleBulkOperation::SceneClearDate { .. } => {
                                next.chronicle_start_time = None;
                                next.chronicle_start_minute = None;
                                next.chronicle_start_granularity = "none".to_string();
                                next.chronicle_end_time = None;
                                next.chronicle_end_minute = None;
                                next.chronicle_end_granularity = "none".to_string();
                            }
                            ChronicleBulkOperation::SceneSetPov {
                                pov_character_id, ..
                            } => next.pov_character_id = pov_character_id.clone(),
                            ChronicleBulkOperation::SceneSetDate {
                                start_time,
                                start_minute,
                                start_granularity,
                                end_time,
                                end_minute,
                                end_granularity,
                                ..
                            } => {
                                next.chronicle_start_time = Some(*start_time);
                                next.chronicle_start_minute = *start_minute;
                                next.chronicle_start_granularity = start_granularity.clone();
                                next.chronicle_end_time = *end_time;
                                next.chronicle_end_minute = *end_minute;
                                next.chronicle_end_granularity = end_granularity.clone();
                            }
                            _ => unreachable!(),
                        }
                        before.scenes.push(current);
                        after.scenes.push(next);
                    }
                }
            }

            // Bound the fully expanded journal before the first UPDATE/DELETE.
            let (before_json, after_json) = serialize_bounded_journal(&before, &after)?;
            let mut event_feed_ids = bulk_event_feed_ids(&before);
            event_feed_ids.extend(bulk_event_feed_ids(&after));
            let before_event_feed =
                collect_full_event_feed_states(conn, &payload.project_id, &event_feed_ids)?;
            let mut scene_feed_ids = bulk_scene_feed_ids(&before);
            scene_feed_ids.extend(bulk_scene_feed_ids(&after));
            let before_scene_feed =
                collect_full_scene_feed_states(conn, &payload.project_id, &scene_feed_ids)?;

            let mut event_results = Vec::new();
            let mut scene_results = Vec::new();
            let mut scene_scope_refresh_events = Vec::new();
            let mut event_index = 0;
            let mut scene_index = 0;
            for operation in &payload.operations {
                match operation {
                    ChronicleBulkOperation::EventDelete {
                        event_id,
                        base_version,
                    } => {
                        delete_event_cascade(
                            conn,
                            &payload.project_id,
                            event_id,
                            Some(*base_version),
                        )?;
                        event_results.push(BulkEventResult {
                            kind: "eventDelete".to_string(),
                            event_id: event_id.clone(),
                            version: None,
                        });
                        event_index += 1;
                    }
                    ChronicleBulkOperation::EventClearDate {
                        event_id,
                        base_version,
                    }
                    | ChronicleBulkOperation::EventSetLane {
                        event_id,
                        base_version,
                        ..
                    }
                    | ChronicleBulkOperation::EventSetDate {
                        event_id,
                        base_version,
                        ..
                    } => {
                        let state = &mut after.events[event_index];
                        let fields = state.fields.as_mut().ok_or_else(|| {
                            anyhow::anyhow!(
                                "chronicle bulk compact state missing for event '{event_id}'"
                            )
                        })?;
                        let version = update_event_to_fields(
                            conn,
                            &payload.project_id,
                            event_id,
                            *base_version,
                            fields,
                        )?;
                        state.last_version = version;
                        event_results.push(BulkEventResult {
                            kind: state.kind.clone(),
                            event_id: event_id.clone(),
                            version: Some(version),
                        });
                        event_index += 1;
                    }
                    ChronicleBulkOperation::SceneClearDate { .. }
                    | ChronicleBulkOperation::SceneSetPov { .. }
                    | ChronicleBulkOperation::SceneSetDate { .. } => {
                        let before_state = &before.scenes[scene_index];
                        let state = &after.scenes[scene_index];
                        scene_scope_refresh_events.push(update_scene_to_state(
                            conn,
                            &payload.project_id,
                            &before_state.updated_at,
                            state,
                        )?);
                        scene_results.push(BulkSceneResult {
                            kind: state.kind.clone(),
                            scene_id: state.scene_id.clone(),
                            updated_at: state.updated_at.clone(),
                        });
                        scene_index += 1;
                    }
                }
            }
            let after_event_feed =
                collect_full_event_feed_states(conn, &payload.project_id, &event_feed_ids)?;
            let after_scene_feed =
                collect_full_scene_feed_states(conn, &payload.project_id, &scene_feed_ids)?;
            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("manual"),
                    entity_kind: BULK_ENTITY_KIND,
                    entity_id: &undo_id,
                    op_kind: "update",
                    before_json: Some(&before_json),
                    after_json: Some(&after_json),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            let mut change_payload = bulk_change_target_metadata(&before);
            change_payload["operations"] = serde_json::to_value(&payload.operations)?;
            let change_payload = if let Some(context) = renderer_context.as_ref() {
                canonical_payload_with_authority_context(&change_payload.to_string(), context)
            } else {
                change_payload.to_string()
            };
            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "chronicle.bulk".to_string(),
                    entity_type: Some(BULK_ENTITY_KIND.to_string()),
                    entity_id: Some(undo_id.clone()),
                    payload: change_payload,
                    timestamp,
                }],
            )?;
            let mut feed_events = narrative_feed_events_with_full_event_states(
                &before,
                &after,
                &before_event_feed,
                &after_event_feed,
                &before_scene_feed,
                &after_scene_feed,
                false,
            )?;
            feed_events.extend(scene_scope_refresh_events);
            append_narrative_change_transaction_in_tx(
                conn,
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "chronicle.bulk".to_string(),
                    source_change_event_uid: event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: renderer_context.as_ref().map_or_else(
                        || narrative_origin_for_surface(payload.surface.as_deref()),
                        |context| context.origin,
                    ),
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: Some(undo_id.clone()),
                    application_ids: Vec::new(),
                    occurred_at: chrono::DateTime::from_timestamp_millis(timestamp)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "chronicle bulk timestamp is outside the supported range"
                            )
                        })?
                        .to_rfc3339(),
                    events: feed_events,
                },
            )?;

            let response = serde_json::to_value(AgentChronicleBulkResult {
                event_results,
                scene_results,
                change_event_uid: event_uid.clone(),
                undo_journal_id: undo_id.clone(),
            })?;
            insert_idempotent_response(conn, &idempotency_request, &payload.project_id, &response)?;
            Ok(response)
        })();

        match result {
            Ok(result) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(result)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        crate::test_support::current_schema_memory().expect("current-schema fixture")
    }

    fn setup(db: &Database) -> (String, String, String, String, String) {
        let project_id = uuid::Uuid::new_v4().to_string();
        let codex_id = uuid::Uuid::new_v4().to_string();
        let event_delete_id = uuid::Uuid::new_v4().to_string();
        let event_clear_id = uuid::Uuid::new_v4().to_string();
        let scene_id = uuid::Uuid::new_v4().to_string();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES (?1, 'Test')",
                rusqlite::params![project_id],
            )?;
            conn.execute(
                "INSERT INTO codex_entries
                 (id, project_id, type, name, summary, content, version, created_at, updated_at)
                 VALUES (?1, ?2, 'character', 'POV', '', '{}', 1, datetime('now'), datetime('now'))",
                rusqlite::params![codex_id, project_id],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes
                 (id, project_id, node_type, title, sort_order, pov_character_id,
                  chronicle_start_time, chronicle_start_minute,
                  chronicle_start_granularity, chronicle_end_time,
                  chronicle_end_minute, chronicle_end_granularity,
                  chronicle_precision, updated_at)
                 VALUES (?1, ?2, 'scene', 'Scene', 'a0', NULL,
                         10, 30, 'time', 11, 45, 'time', 'approx', ?3)",
                rusqlite::params![scene_id, project_id, "2026-07-29T00:00:00.000Z"],
            )?;
            crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                conn,
                &project_id,
                &scene_id,
                "2026-07-29T00:00:00.000Z",
            )?;
            for (id, ordinal) in [(&event_delete_id, "a0"), (&event_clear_id, "a1")] {
                conn.execute(
                    "INSERT INTO events
                     (id, project_id, title, ordinal, start_time, start_minute,
                      start_granularity, end_time, end_minute, end_granularity,
                      precision, kind, created_at, updated_at, version)
                     VALUES (?1, ?2, 'Event', ?3, 20, 60, 'time',
                             21, 90, 'time', 'exact', 'generic',
                             datetime('now'), datetime('now'), 1)",
                    rusqlite::params![id, project_id, ordinal],
                )?;
            }
            conn.execute(
                "INSERT INTO event_relations
                   (project_id, cause_event_id, effect_event_id)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![project_id, event_clear_id, event_delete_id],
            )?;
            Ok(())
        })
        .unwrap();
        (
            project_id,
            codex_id,
            event_delete_id,
            event_clear_id,
            scene_id,
        )
    }

    fn history_replay_controls() -> Vec<String> {
        [
            "original-transaction",
            "journal-lineage",
            "typed-writer",
            "occ",
            "change-event",
            "change-feed",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }

    fn latest_change_payload(db: &Database) -> Value {
        db.with_conn(|conn| {
            let raw: String = conn.query_row(
                "SELECT payload FROM change_events ORDER BY sequence DESC LIMIT 1",
                [],
                |row| row.get(0),
            )?;
            Ok(serde_json::from_str(&raw)?)
        })
        .expect("latest change payload")
    }

    fn narrative_feed_events(db: &Database) -> Vec<Value> {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT event_ordinal, object_key_json, change_kind, mutation_kind,
                        before_version, before_digest, after_version, after_digest,
                        changed_paths_json
                   FROM narrative_change_events
                  ORDER BY canonical_sequence, event_ordinal",
            )?;
            let rows = statement.query_map([], |row| {
                let object_key: String = row.get(1)?;
                let changed_paths: String = row.get(8)?;
                Ok(json!({
                    "eventOrdinal": row.get::<_, i64>(0)?,
                    "objectKey": serde_json::from_str::<Value>(&object_key).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            object_key.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    "changeKind": row.get::<_, String>(2)?,
                    "mutationKind": row.get::<_, String>(3)?,
                    "beforeVersion": row.get::<_, Option<i64>>(4)?,
                    "beforeDigest": row.get::<_, Option<String>>(5)?,
                    "afterVersion": row.get::<_, Option<i64>>(6)?,
                    "afterDigest": row.get::<_, Option<String>>(7)?,
                    "changedPaths": serde_json::from_str::<Value>(&changed_paths).map_err(
                        |error| rusqlite::Error::FromSqlConversionFailure(
                            changed_paths.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        ),
                    )?,
                }))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .expect("load Narrative Change Feed events")
    }

    #[test]
    fn forward_bulk_appends_one_deterministic_narrative_feed_transaction() {
        let db = test_db();
        let (project_id, codex_id, event_delete_id, event_clear_id, scene_id) = setup(&db);
        let result = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "feed-forward".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                // Deliberately do not arrange the operations in object-key order.
                operations: vec![
                    ChronicleBulkOperation::SceneSetPov {
                        scene_id: scene_id.clone(),
                        base_updated_at: "2026-07-29T00:00:00.000Z".to_string(),
                        pov_character_id: Some(codex_id),
                    },
                    ChronicleBulkOperation::EventClearDate {
                        event_id: event_clear_id.clone(),
                        base_version: 1,
                    },
                    ChronicleBulkOperation::EventDelete {
                        event_id: event_delete_id.clone(),
                        base_version: 1,
                    },
                ],
            },
        )
        .expect("bulk mutation with feed");

        db.with_conn(|conn| {
            let transaction: (
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                Option<String>,
            ) = conn.query_row(
                "SELECT request_id, source_domain, source_change_event_uid,
                            cause_kind, origin, journal_id, undo_journal_id
                       FROM narrative_change_transactions",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )?;
            assert_eq!(
                transaction,
                (
                    "feed-forward".to_string(),
                    "chronicle.bulk".to_string(),
                    result["changeEventUid"].as_str().unwrap().to_string(),
                    "forward".to_string(),
                    "human".to_string(),
                    None,
                    Some(result["undoJournalId"].as_str().unwrap().to_string()),
                )
            );
            Ok(())
        })
        .expect("inspect feed transaction");

        let events = narrative_feed_events(&db);
        assert_eq!(events.len(), 4);
        let mut expected_event_ids = [event_clear_id.clone(), event_delete_id.clone()];
        expected_event_ids.sort();
        assert_eq!(
            events
                .iter()
                .map(|event| {
                    let key = &event["objectKey"];
                    (
                        key["kind"].as_str().unwrap().to_string(),
                        key.get("eventId")
                            .or_else(|| key.get("sceneId"))
                            .and_then(Value::as_str)
                            .unwrap()
                            .to_string(),
                    )
                })
                .collect::<Vec<_>>(),
            vec![
                ("chronicle-event".to_string(), expected_event_ids[0].clone()),
                ("chronicle-event".to_string(), expected_event_ids[1].clone()),
                ("scene".to_string(), scene_id.clone()),
                ("scene-scope".to_string(), scene_id.clone()),
            ]
        );

        let deleted = events
            .iter()
            .find(|event| event["objectKey"]["eventId"] == event_delete_id)
            .expect("delete feed event");
        assert_eq!(deleted["changeKind"], "metadata");
        assert_eq!(deleted["mutationKind"], "delete");
        assert_eq!(deleted["beforeVersion"], 1);
        assert!(deleted["beforeDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert_eq!(deleted["afterVersion"], Value::Null);
        assert_eq!(deleted["afterDigest"], Value::Null);
        assert_eq!(deleted["changedPaths"], json!(["/"]));

        let cleared = events
            .iter()
            .find(|event| event["objectKey"]["eventId"] == event_clear_id)
            .expect("date feed event");
        assert_eq!(cleared["changeKind"], "calendar");
        assert_eq!(cleared["mutationKind"], "update");
        assert_eq!(cleared["beforeVersion"], 1);
        assert_eq!(cleared["afterVersion"], 2);
        assert!(cleared["beforeDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert!(cleared["afterDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert_eq!(
            cleared["changedPaths"],
            json!([
                "/endGranularity",
                "/endMinute",
                "/endTime",
                "/startGranularity",
                "/startMinute",
                "/startTime",
            ])
        );

        let scene = events
            .iter()
            .find(|event| event["objectKey"]["sceneId"] == scene_id)
            .expect("scene feed event");
        assert_eq!(scene["changeKind"], "association");
        assert_eq!(scene["mutationKind"], "update");
        assert_eq!(scene["beforeVersion"], 0);
        assert_eq!(scene["afterVersion"], 0);
        assert!(scene["beforeDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert!(scene["afterDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert_eq!(scene["changedPaths"], json!(["/povCharacterId"]));
    }

    #[test]
    fn narrative_feed_origin_tracks_the_authoritative_surface() {
        for (surface, expected_origin) in [
            ("manual", "human"),
            ("in-app-agent", "ai-apply"),
            ("mcp", "ai-apply"),
            ("import", "import"),
        ] {
            let db = test_db();
            let (project_id, _codex_id, _event_delete_id, event_clear_id, _scene_id) = setup(&db);
            agent_chronicle_bulk_mutate_impl(
                &db,
                AgentChronicleBulkPayload {
                    request_id: format!("origin-{surface}"),
                    project_id,
                    session_id: "session".to_string(),
                    surface: Some(surface.to_string()),
                    operations: vec![ChronicleBulkOperation::EventClearDate {
                        event_id: event_clear_id,
                        base_version: 1,
                    }],
                },
            )
            .expect("bulk mutation with mapped origin");

            db.with_conn(|conn| {
                let origin: String = conn.query_row(
                    "SELECT origin FROM narrative_change_transactions",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(origin, expected_origin, "surface {surface}");
                Ok(())
            })
            .expect("inspect mapped origin");
        }
    }

    #[test]
    fn narrative_feed_failure_rolls_back_domain_journal_canonical_and_request_ledger() {
        let db = test_db();
        let (project_id, _codex_id, _event_delete_id, event_id, _scene_id) = setup(&db);
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER force_chronicle_bulk_feed_failure
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced chronicle bulk feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install forced feed failure");

        let error = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "feed-failure".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![ChronicleBulkOperation::EventClearDate {
                    event_id: event_id.clone(),
                    base_version: 1,
                }],
            },
        )
        .expect_err("feed failure must reject the whole bulk mutation");
        assert!(error
            .to_string()
            .contains("forced chronicle bulk feed failure"));

        db.with_conn(|conn| {
            let event_state: (Option<i64>, String, i64) = conn.query_row(
                "SELECT start_time, start_granularity, version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let canonical: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            let feed_transactions: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions",
                [],
                |row| row.get(0),
            )?;
            let feed_events: i64 =
                conn.query_row("SELECT COUNT(*) FROM narrative_change_events", [], |row| {
                    row.get(0)
                })?;
            let requests: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = ?1 AND request_id = 'feed-failure'",
                [BULK_IDEMPOTENCY_DOMAIN],
                |row| row.get(0),
            )?;
            assert_eq!(event_state, (Some(20), "time".to_string(), 1));
            assert_eq!(
                (
                    journals,
                    canonical,
                    feed_transactions,
                    feed_events,
                    requests
                ),
                (0, 0, 0, 0, 0)
            );
            Ok(())
        })
        .expect("verify full rollback after feed failure");
    }

    #[test]
    fn mixed_bulk_is_one_transaction_and_one_undo_round_trip() {
        let db = test_db();
        let (project_id, codex_id, event_delete_id, event_clear_id, scene_id) = setup(&db);
        let result = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "mixed-forward".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![
                    ChronicleBulkOperation::EventDelete {
                        event_id: event_delete_id.clone(),
                        base_version: 1,
                    },
                    ChronicleBulkOperation::EventClearDate {
                        event_id: event_clear_id.clone(),
                        base_version: 1,
                    },
                    ChronicleBulkOperation::SceneSetPov {
                        scene_id: scene_id.clone(),
                        base_updated_at: "2026-07-29T00:00:00.000Z".to_string(),
                        pov_character_id: Some(codex_id.clone()),
                    },
                ],
            },
        )
        .expect("bulk mutation");

        let forward_change = latest_change_payload(&db);
        assert_eq!(
            forward_change["eventIds"],
            json!([event_delete_id, event_clear_id])
        );
        assert_eq!(forward_change["sceneIds"], json!([scene_id]));
        assert_eq!(forward_change["relatedEventIds"], json!([event_clear_id]));
        assert_eq!(forward_change["operations"][0]["baseVersion"], json!(1));

        db.with_conn(|conn| {
            let deleted: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1",
                rusqlite::params![event_delete_id],
                |row| row.get(0),
            )?;
            let cleared: (Option<i64>, String, i64) = conn.query_row(
                "SELECT start_time, start_granularity, version FROM events WHERE id = ?1",
                rusqlite::params![event_clear_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let pov: Option<String> = conn.query_row(
                "SELECT pov_character_id FROM tree_nodes WHERE id = ?1",
                rusqlite::params![scene_id],
                |row| row.get(0),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            assert_eq!(deleted, 0);
            assert_eq!(cleared, (None, "none".to_string(), 2));
            assert_eq!(pov.as_deref(), Some(codex_id.as_str()));
            assert_eq!(journals, 1);
            assert_eq!(changes, 1);
            Ok(())
        })
        .unwrap();

        let journal_id = result["undoJournalId"].as_str().unwrap();
        crate::agent_writes::agent_undo_journal_impl(
            &db,
            crate::agent_writes::AgentUndoJournalPayload {
                request_id: "mixed-undo".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                journal_id: journal_id.to_string(),
                direction: "undo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "undo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("undo bulk");
        let undo_change = latest_change_payload(&db);
        assert_eq!(undo_change["direction"], "undo");
        assert_eq!(
            undo_change["eventIds"],
            json!([event_delete_id, event_clear_id])
        );
        assert_eq!(undo_change["sceneIds"], json!([scene_id]));
        assert_eq!(undo_change["relatedEventIds"], json!([event_clear_id]));
        assert_eq!(
            undo_change["operations"][0],
            json!({ "kind": "eventDelete", "eventId": event_delete_id })
        );
        db.with_conn(|conn| {
            let restored_version: i64 = conn.query_row(
                "SELECT version FROM events WHERE id = ?1",
                rusqlite::params![event_delete_id],
                |row| row.get(0),
            )?;
            let date_and_version: (Option<i64>, String, i64) = conn.query_row(
                "SELECT start_time, start_granularity, version FROM events WHERE id = ?1",
                rusqlite::params![event_clear_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let pov: Option<String> = conn.query_row(
                "SELECT pov_character_id FROM tree_nodes WHERE id = ?1",
                rusqlite::params![scene_id],
                |row| row.get(0),
            )?;
            assert_eq!(restored_version, 2);
            assert_eq!(date_and_version, (Some(20), "time".to_string(), 3));
            assert_eq!(pov, None);
            Ok(())
        })
        .unwrap();

        crate::agent_writes::agent_undo_journal_impl(
            &db,
            crate::agent_writes::AgentUndoJournalPayload {
                request_id: "mixed-redo".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                journal_id: journal_id.to_string(),
                direction: "redo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "redo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("redo bulk");
        assert_eq!(latest_change_payload(&db)["direction"], "redo");
        db.with_conn(|conn| {
            let deleted: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1",
                rusqlite::params![event_delete_id],
                |row| row.get(0),
            )?;
            let cleared: (Option<i64>, i64) = conn.query_row(
                "SELECT start_time, version FROM events WHERE id = ?1",
                rusqlite::params![event_clear_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let pov: Option<String> = conn.query_row(
                "SELECT pov_character_id FROM tree_nodes WHERE id = ?1",
                rusqlite::params![scene_id],
                |row| row.get(0),
            )?;
            assert_eq!(deleted, 0);
            assert_eq!(cleared, (None, 4));
            assert_eq!(pov.as_deref(), Some(codex_id.as_str()));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn more_than_500_targets_remain_one_atomic_journal() {
        let db = test_db();
        let project_id = uuid::Uuid::new_v4().to_string();
        let mut operations = Vec::with_capacity(501);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES (?1, 'Large Chronicle')",
                rusqlite::params![project_id],
            )?;
            for index in 0..501 {
                let event_id = format!("event-{index}");
                conn.execute(
                    "INSERT INTO events
                     (id, project_id, title, ordinal, start_time,
                      start_granularity, precision, kind, created_at, updated_at, version)
                     VALUES (?1, ?2, 'Event', ?3, 20, 'day', 'exact', 'generic',
                             datetime('now'), datetime('now'), 1)",
                    rusqlite::params![event_id, project_id, format!("a{index}")],
                )?;
                operations.push(ChronicleBulkOperation::EventClearDate {
                    event_id,
                    base_version: 1,
                });
            }
            Ok(())
        })
        .expect("seed large Chronicle");

        let result = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "large-forward".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations,
            },
        )
        .expect("large bulk mutation");

        assert_eq!(result["eventResults"].as_array().map(Vec::len), Some(501));
        db.with_conn(|conn| {
            let cleared: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events
                  WHERE project_id = ?1
                    AND start_time IS NULL
                    AND start_granularity = 'none'
                    AND version = 2",
                rusqlite::params![project_id],
                |row| row.get(0),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            assert_eq!(cleared, 501);
            assert_eq!(journals, 1);
            assert_eq!(changes, 1);
            Ok(())
        })
        .expect("verify one atomic journal");
    }

    #[test]
    fn oversized_payload_is_rejected_before_database_access() {
        let db = test_db();
        let error = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "oversized".to_string(),
                project_id: "project".to_string(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![ChronicleBulkOperation::EventDelete {
                    event_id: "e".repeat(MAX_CHRONICLE_BULK_PAYLOAD_BYTES),
                    base_version: 1,
                }],
            },
        )
        .expect_err("oversized payload must fail");

        assert!(error.to_string().contains("8 MiB"));
    }

    #[test]
    fn field_updates_store_compact_journal_state_without_event_composites() {
        let db = test_db();
        let (project_id, _codex_id, _event_delete_id, event_id, _scene_id) = setup(&db);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE events SET detail = ?1 WHERE id = ?2",
                rusqlite::params!["x".repeat(256 * 1024), event_id],
            )?;
            Ok(())
        })
        .expect("seed large event detail");

        agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "compact-journal".to_string(),
                project_id,
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![ChronicleBulkOperation::EventClearDate {
                    event_id,
                    base_version: 1,
                }],
            },
        )
        .expect("clear date");

        db.with_conn(|conn| {
            let (before_raw, after_raw): (String, String) = conn.query_row(
                "SELECT before_json, after_json FROM undo_journal LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert!(before_raw.len() + after_raw.len() < 4 * 1024);
            assert!(!before_raw.contains("\"detail\""));
            assert!(!after_raw.contains("\"relations\""));

            let before: Value = serde_json::from_str(&before_raw)?;
            let after: Value = serde_json::from_str(&after_raw)?;
            assert!(before["events"][0].get("snapshot").is_none());
            assert!(after["events"][0].get("snapshot").is_none());
            assert_eq!(before["events"][0]["fields"]["stateKind"], "date");
            assert_eq!(before["events"][0]["fields"]["startTime"], 20);
            assert_eq!(after["events"][0]["fields"]["startTime"], Value::Null);
            Ok(())
        })
        .expect("inspect compact journal");
    }

    #[test]
    fn legacy_full_event_update_journal_remains_replayable() {
        let db = test_db();
        let (project_id, _codex_id, _event_delete_id, event_id, _scene_id) = setup(&db);
        let before_snapshot = db
            .with_conn(|conn| collect_event_snapshot(conn, &event_id))
            .expect("legacy before snapshot");
        let result = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "legacy-forward".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![ChronicleBulkOperation::EventClearDate {
                    event_id: event_id.clone(),
                    base_version: 1,
                }],
            },
        )
        .expect("forward");
        let after_snapshot = db
            .with_conn(|conn| collect_event_snapshot(conn, &event_id))
            .expect("legacy after snapshot");

        let legacy_before = ChronicleBulkSnapshot {
            events: vec![BulkEventState {
                kind: "eventClearDate".to_string(),
                event_id: event_id.clone(),
                snapshot: Some(before_snapshot),
                fields: None,
                last_version: 1,
            }],
            scenes: Vec::new(),
        };
        let legacy_after = ChronicleBulkSnapshot {
            events: vec![BulkEventState {
                kind: "eventClearDate".to_string(),
                event_id: event_id.clone(),
                snapshot: Some(after_snapshot),
                fields: None,
                last_version: 2,
            }],
            scenes: Vec::new(),
        };
        let before_raw = serde_json::to_string(&legacy_before).expect("serialize legacy before");
        let after_raw = serde_json::to_string(&legacy_after).expect("serialize legacy after");
        assert!(!before_raw.contains("\"fields\""));
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE undo_journal SET before_json = ?1, after_json = ?2 WHERE id = ?3",
                rusqlite::params![
                    before_raw,
                    after_raw,
                    result["undoJournalId"].as_str().expect("journal id")
                ],
            )?;
            Ok(())
        })
        .expect("replace with legacy journal");

        crate::agent_writes::agent_undo_journal_impl(
            &db,
            crate::agent_writes::AgentUndoJournalPayload {
                request_id: "legacy-undo".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                journal_id: result["undoJournalId"]
                    .as_str()
                    .expect("journal id")
                    .to_string(),
                direction: "undo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "undo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("undo legacy journal");

        db.with_conn(|conn| {
            let restored: (Option<i64>, String, i64) = conn.query_row(
                "SELECT start_time, start_granularity, version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(restored, (Some(20), "time".to_string(), 3));
            Ok(())
        })
        .expect("verify legacy replay");

        crate::agent_writes::agent_undo_journal_impl(
            &db,
            crate::agent_writes::AgentUndoJournalPayload {
                request_id: "legacy-redo".to_string(),
                project_id,
                session_id: "session".to_string(),
                journal_id: result["undoJournalId"]
                    .as_str()
                    .expect("journal id")
                    .to_string(),
                direction: "redo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "redo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("redo legacy journal");
        db.with_conn(|conn| {
            let redone: (Option<i64>, String, i64) = conn.query_row(
                "SELECT start_time, start_granularity, version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(redone, (None, "none".to_string(), 4));
            Ok(())
        })
        .expect("verify legacy redo");
    }

    #[test]
    fn expanded_journal_limit_rejects_before_the_first_write() {
        let db = test_db();
        let (project_id, _codex_id, event_id, _event_clear_id, _scene_id) = setup(&db);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE events SET detail = ?1 WHERE id = ?2",
                rusqlite::params!["x".repeat(16 * 1024 * 1024 + 1), event_id],
            )?;
            Ok(())
        })
        .expect("seed oversized delete snapshot");

        let error = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "oversized-journal".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![ChronicleBulkOperation::EventDelete {
                    event_id: event_id.clone(),
                    base_version: 1,
                }],
            },
        )
        .expect_err("expanded journal must be bounded");
        assert!(
            error
                .to_string()
                .contains("undo snapshot exceeds the 16 MiB limit"),
            "{error:#}"
        );

        db.with_conn(|conn| {
            let still_present: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get(0),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            assert_eq!((still_present, journals, changes), (1, 0, 0));
            Ok(())
        })
        .expect("oversized journal rollback");
    }

    #[test]
    fn conflict_rolls_back_every_selected_target_and_side_effect() {
        let db = test_db();
        let (project_id, _codex_id, event_delete_id, event_clear_id, scene_id) = setup(&db);
        let error = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "conflict-forward".to_string(),
                project_id,
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![
                    ChronicleBulkOperation::EventDelete {
                        event_id: event_delete_id.clone(),
                        base_version: 1,
                    },
                    ChronicleBulkOperation::EventClearDate {
                        event_id: event_clear_id.clone(),
                        base_version: 99,
                    },
                    ChronicleBulkOperation::SceneClearDate {
                        scene_id,
                        base_updated_at: "2026-07-29T00:00:00.000Z".to_string(),
                    },
                ],
            },
        )
        .expect_err("stale event must reject the whole selection");
        assert!(error.to_string().contains("version conflict"));

        db.with_conn(|conn| {
            let still_present: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1",
                rusqlite::params![event_delete_id],
                |row| row.get(0),
            )?;
            let unchanged: (Option<i64>, i64) = conn.query_row(
                "SELECT start_time, version FROM events WHERE id = ?1",
                rusqlite::params![event_clear_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            assert_eq!(still_present, 1);
            assert_eq!(unchanged, (Some(20), 1));
            assert_eq!(journals, 0);
            assert_eq!(changes, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn forward_retry_returns_the_exact_response_without_reapplying() {
        let db = test_db();
        let (project_id, _codex_id, _event_delete_id, event_id, _scene_id) = setup(&db);
        let payload = AgentChronicleBulkPayload {
            request_id: "forward-retry".to_string(),
            project_id: project_id.clone(),
            session_id: "session".to_string(),
            surface: Some("manual".to_string()),
            operations: vec![ChronicleBulkOperation::EventClearDate {
                event_id: event_id.clone(),
                base_version: 1,
            }],
        };

        let first = agent_chronicle_bulk_mutate_impl(&db, payload.clone()).expect("first forward");
        let retry = agent_chronicle_bulk_mutate_impl(&db, payload.clone()).expect("forward retry");
        assert_eq!(retry, first);

        db.with_conn(|conn| {
            let version: i64 = conn.query_row(
                "SELECT version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get(0),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            let feed_transactions: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions",
                [],
                |row| row.get(0),
            )?;
            let feed_events: i64 =
                conn.query_row("SELECT COUNT(*) FROM narrative_change_events", [], |row| {
                    row.get(0)
                })?;
            let ledger: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = ?1 AND request_id = ?2",
                rusqlite::params![BULK_IDEMPOTENCY_DOMAIN, "forward-retry"],
                |row| row.get(0),
            )?;
            assert_eq!(
                (
                    version,
                    journals,
                    changes,
                    feed_transactions,
                    feed_events,
                    ledger,
                ),
                (2, 1, 1, 1, 1, 1)
            );
            Ok(())
        })
        .unwrap();

        let mut changed = payload;
        changed.operations = vec![ChronicleBulkOperation::EventSetLane {
            event_id,
            base_version: 1,
            primary_codex_id: None,
            lane_group: None,
        }];
        let error = agent_chronicle_bulk_mutate_impl(&db, changed)
            .expect_err("request id reuse with changed payload must fail");
        assert!(
            error
                .to_string()
                .contains("CHRONICLE_BULK_IDEMPOTENCY_CONFLICT"),
            "{error:#}"
        );
    }

    #[test]
    fn related_event_ids_collect_both_relation_endpoints_and_deduplicate() {
        let snapshot = json!({
            "relations": {
                "asCause": [{
                    "causeEventId": "cause",
                    "effectEventId": "effect",
                }],
                "asEffect": [{
                    "causeEventId": "cause",
                    "effectEventId": "effect",
                }],
            },
        });
        assert_eq!(
            event_snapshot_related_ids(&snapshot),
            vec!["cause".to_string(), "effect".to_string()]
        );
    }

    #[test]
    fn same_direction_replay_retry_is_idempotent_and_direction_bound() {
        let db = test_db();
        let (project_id, _codex_id, _event_delete_id, event_id, _scene_id) = setup(&db);
        let forward = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "replay-forward".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![ChronicleBulkOperation::EventClearDate {
                    event_id: event_id.clone(),
                    base_version: 1,
                }],
            },
        )
        .expect("forward");
        let undo = crate::agent_writes::AgentUndoJournalPayload {
            request_id: "same-undo-retry".to_string(),
            project_id: project_id.clone(),
            session_id: "session".to_string(),
            journal_id: forward["undoJournalId"].as_str().unwrap().to_string(),
            direction: "undo".to_string(),
            authority_route: "history-replay".to_string(),
            origin: "undo".to_string(),
            caller: "undo-redo-command".to_string(),
            controls: history_replay_controls(),
        };

        let first =
            crate::agent_writes::agent_undo_journal_impl(&db, undo.clone()).expect("first undo");
        let retry =
            crate::agent_writes::agent_undo_journal_impl(&db, undo.clone()).expect("undo retry");
        assert_eq!(retry, first);

        db.with_conn(|conn| {
            let version: i64 = conn.query_row(
                "SELECT version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get(0),
            )?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            let ledger: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'agent_apply_undo_journal' AND request_id = ?1",
                rusqlite::params!["same-undo-retry"],
                |row| row.get(0),
            )?;
            assert_eq!((version, changes, ledger), (3, 2, 1));
            Ok(())
        })
        .unwrap();

        let mut changed_direction = undo.clone();
        changed_direction.direction = "redo".to_string();
        changed_direction.origin = "redo".to_string();
        let error = crate::agent_writes::agent_undo_journal_impl(&db, changed_direction)
            .expect_err("request id must be bound to replay direction");
        assert!(
            error
                .to_string()
                .contains("UNDO_JOURNAL_IDEMPOTENCY_CONFLICT"),
            "{error:#}"
        );

        let redo = crate::agent_writes::AgentUndoJournalPayload {
            request_id: "same-redo-retry".to_string(),
            direction: "redo".to_string(),
            origin: "redo".to_string(),
            ..undo
        };
        let first_redo =
            crate::agent_writes::agent_undo_journal_impl(&db, redo.clone()).expect("first redo");
        let retry_redo =
            crate::agent_writes::agent_undo_journal_impl(&db, redo).expect("redo retry");
        assert_eq!(retry_redo, first_redo);
        db.with_conn(|conn| {
            let version: i64 = conn.query_row(
                "SELECT version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get(0),
            )?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            let ledger: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'agent_apply_undo_journal' AND request_id = ?1",
                rusqlite::params!["same-redo-retry"],
                |row| row.get(0),
            )?;
            assert_eq!((version, changes, ledger), (4, 3, 1));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn event_set_lane_is_versioned_and_undoable() {
        let db = test_db();
        let (project_id, codex_id, _event_delete_id, event_id, _scene_id) = setup(&db);
        let result = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "lane-forward".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![ChronicleBulkOperation::EventSetLane {
                    event_id: event_id.clone(),
                    base_version: 1,
                    primary_codex_id: Some(codex_id.clone()),
                    lane_group: Some("group-a".to_string()),
                }],
            },
        )
        .expect("set lane");

        db.with_conn(|conn| {
            let state: (Option<String>, Option<String>, i64) = conn.query_row(
                "SELECT primary_codex_id, lane_group, version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                state,
                (Some(codex_id.clone()), Some("group-a".to_string()), 2)
            );
            Ok(())
        })
        .unwrap();

        crate::agent_writes::agent_undo_journal_impl(
            &db,
            crate::agent_writes::AgentUndoJournalPayload {
                request_id: "lane-undo".to_string(),
                project_id,
                session_id: "session".to_string(),
                journal_id: result["undoJournalId"].as_str().unwrap().to_string(),
                direction: "undo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "undo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("undo lane");
        db.with_conn(|conn| {
            let state: (Option<String>, Option<String>, i64) = conn.query_row(
                "SELECT primary_codex_id, lane_group, version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(state, (None, None, 3));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn noncanonical_scene_date_rolls_back_an_earlier_event_date_write() {
        let db = test_db();
        let (project_id, _codex_id, _event_delete_id, event_id, scene_id) = setup(&db);
        let error = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "invalid-date-forward".to_string(),
                project_id,
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![
                    ChronicleBulkOperation::EventSetDate {
                        event_id: event_id.clone(),
                        base_version: 1,
                        start_time: 30,
                        start_minute: None,
                        start_granularity: "day".to_string(),
                        end_time: None,
                        end_minute: None,
                        end_granularity: "none".to_string(),
                    },
                    ChronicleBulkOperation::SceneSetDate {
                        scene_id: scene_id.clone(),
                        base_updated_at: "2026-07-29T00:00:00.000Z".to_string(),
                        start_time: 12,
                        start_minute: Some(30),
                        start_granularity: "day".to_string(),
                        end_time: None,
                        end_minute: None,
                        end_granularity: "none".to_string(),
                    },
                ],
            },
        )
        .expect_err("a coarse date carrying a minute must be rejected");
        assert!(
            error.to_string().contains("does not allow a minute"),
            "{error:#}"
        );

        db.with_conn(|conn| {
            let event: (i64, Option<i64>, String, i64) = conn.query_row(
                "SELECT start_time, start_minute, start_granularity, version
                   FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            let scene: (i64, Option<i64>, String) = conn.query_row(
                "SELECT chronicle_start_time, chronicle_start_minute,
                        chronicle_start_granularity
                   FROM tree_nodes WHERE id = ?1",
                rusqlite::params![scene_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            let ledger: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = ?1",
                rusqlite::params![BULK_IDEMPOTENCY_DOMAIN],
                |row| row.get(0),
            )?;
            assert_eq!(event, (20, Some(60), "time".to_string(), 1));
            assert_eq!(scene, (10, Some(30), "time".to_string()));
            assert_eq!((journals, changes, ledger), (0, 0, 0));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn absolute_event_and_scene_dates_are_atomic_and_replayable() {
        let db = test_db();
        let (project_id, _codex_id, _event_delete_id, event_id, scene_id) = setup(&db);
        let result = agent_chronicle_bulk_mutate_impl(
            &db,
            AgentChronicleBulkPayload {
                request_id: "date-forward".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: Some("manual".to_string()),
                operations: vec![
                    ChronicleBulkOperation::EventSetDate {
                        event_id: event_id.clone(),
                        base_version: 1,
                        start_time: 30,
                        start_minute: Some(120),
                        start_granularity: "time".to_string(),
                        end_time: Some(31),
                        end_minute: Some(180),
                        end_granularity: "time".to_string(),
                    },
                    ChronicleBulkOperation::SceneSetDate {
                        scene_id: scene_id.clone(),
                        base_updated_at: "2026-07-29T00:00:00.000Z".to_string(),
                        start_time: 12,
                        start_minute: None,
                        start_granularity: "day".to_string(),
                        end_time: None,
                        end_minute: None,
                        end_granularity: "none".to_string(),
                    },
                ],
            },
        )
        .expect("set absolute dates");

        db.with_conn(|conn| {
            let event: (
                i64,
                Option<i64>,
                String,
                Option<i64>,
                Option<i64>,
                String,
                i64,
            ) = conn.query_row(
                "SELECT start_time, start_minute, start_granularity,
                            end_time, end_minute, end_granularity, version
                       FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )?;
            let scene: (i64, Option<i64>, String, Option<i64>, Option<i64>, String) = conn
                .query_row(
                    "SELECT chronicle_start_time, chronicle_start_minute,
                            chronicle_start_granularity, chronicle_end_time,
                            chronicle_end_minute, chronicle_end_granularity
                       FROM tree_nodes WHERE id = ?1",
                    rusqlite::params![scene_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )?;
            assert_eq!(
                event,
                (
                    30,
                    Some(120),
                    "time".to_string(),
                    Some(31),
                    Some(180),
                    "time".to_string(),
                    2,
                )
            );
            assert_eq!(
                scene,
                (12, None, "day".to_string(), None, None, "none".to_string())
            );
            Ok(())
        })
        .unwrap();

        crate::agent_writes::agent_undo_journal_impl(
            &db,
            crate::agent_writes::AgentUndoJournalPayload {
                request_id: "date-undo".to_string(),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                journal_id: result["undoJournalId"].as_str().unwrap().to_string(),
                direction: "undo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "undo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("undo dates");
        db.with_conn(|conn| {
            let event: (i64, Option<i64>, i64) = conn.query_row(
                "SELECT start_time, start_minute, version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let scene: (i64, Option<i64>, String) = conn.query_row(
                "SELECT chronicle_start_time, chronicle_start_minute,
                        chronicle_start_granularity
                   FROM tree_nodes WHERE id = ?1",
                rusqlite::params![scene_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(event, (20, Some(60), 3));
            assert_eq!(scene, (10, Some(30), "time".to_string()));
            Ok(())
        })
        .unwrap();

        crate::agent_writes::agent_undo_journal_impl(
            &db,
            crate::agent_writes::AgentUndoJournalPayload {
                request_id: "date-redo".to_string(),
                project_id,
                session_id: "session".to_string(),
                journal_id: result["undoJournalId"].as_str().unwrap().to_string(),
                direction: "redo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "redo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("redo dates");
        db.with_conn(|conn| {
            let event: (i64, Option<i64>, i64) = conn.query_row(
                "SELECT start_time, start_minute, version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let scene: (i64, Option<i64>, String) = conn.query_row(
                "SELECT chronicle_start_time, chronicle_start_minute,
                        chronicle_start_granularity
                   FROM tree_nodes WHERE id = ?1",
                rusqlite::params![scene_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(event, (30, Some(120), 4));
            assert_eq!(scene, (12, None, "day".to_string()));
            Ok(())
        })
        .unwrap();
    }
}
