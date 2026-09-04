//! Atomic persistence for the Electron scene-body autosave hot path.
//!
//! Renderer-derived document metadata crosses IPC once, then content and every
//! schema-backed sidecar are committed under one `BEGIN IMMEDIATE`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    change_events::AppendChangeEvent,
    foreshadow::{
        finish_foreshadow_child_write, record_manual_foreshadow_fields,
        setup_semantic_key_for_upsert,
    },
    idempotency::{
        insert_idempotent_response, load_idempotent_response, payload_fingerprint,
        IdempotencyRequest,
    },
    narrative_extraction::change_feed::{
        append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest, scene_text_impact,
        AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
        NarrativeChangeOrigin,
    },
    Database,
};

type PayoffRootState = (Option<String>, Option<i64>, Option<i64>, i64);

const IDEMPOTENCY_DOMAIN: &str = "save_scene_body_bundle";

fn event_timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

fn scene_feed_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<Value> {
    crate::canonical_feed_snapshots::canonical_scene_snapshot(conn, project_id, scene_id)
}

fn foreshadow_feed_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    foreshadow_id: &str,
) -> anyhow::Result<Option<Value>> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM foreshadows WHERE id = ?1 AND project_id = ?2",
            params![foreshadow_id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(None);
    }
    crate::canonical_feed_snapshots::canonical_foreshadow_snapshot(conn, project_id, foreshadow_id)
        .map(Some)
}

fn snapshot_version(snapshot: Option<&Value>) -> Option<i64> {
    snapshot
        .and_then(|value| value.get("version"))
        .and_then(Value::as_i64)
}

fn feed_event(
    object_key: Value,
    change_kind: &str,
    mutation_kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    Ok(NarrativeChangeEventInput {
        object_key,
        change_kind: change_kind.to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version: snapshot_version(before),
        before_digest: before.map(narrative_snapshot_digest).transpose()?,
        after_version: snapshot_version(after),
        after_digest: after.map(narrative_snapshot_digest).transpose()?,
        changed_paths: changed_paths.clone(),
        text_impact: scene_text_impact(before, after)?,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneAuthorshipSpanInput {
    pub from_pos: i64,
    pub to_pos: i64,
    pub source: String,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub chat_msg_id: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneForeshadowSetupInput {
    pub id: String,
    pub foreshadow_id: String,
    pub base_version: i64,
    pub from_pos: i64,
    pub to_pos: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneForeshadowPayoffInput {
    pub foreshadow_id: String,
    pub base_version: i64,
    pub from_pos: i64,
    pub to_pos: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneAnnotationAnchorInput {
    pub id: String,
    pub range_start: i64,
    pub range_end: i64,
    pub text_snapshot: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneBeatMentionInput {
    pub beat_id: String,
    pub codex_id: String,
    pub role: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSceneBodyBundlePayload {
    pub scene_id: String,
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    /// Replayable ProseMirror steps for a headless scene-body mutation. When
    /// present this writer owns the canonical `doc.step` event atomically.
    pub timelapse_steps: Option<Vec<Value>>,
    /// Renderer-recorder evidence that the complete body written by this save
    /// is already represented by durable `doc.step` events. Missing or invalid
    /// evidence falls back to an atomic full-body snapshot.
    #[serde(default)]
    pub timelapse_doc_step_coverage: Option<crate::timelapse::TimelapseDocStepCoverageProof>,
    pub include_sidecars: bool,
    pub base_version: Option<i64>,
    pub updated_at: String,
    pub content_json: String,
    pub char_count: i64,
    pub placed_beat_preview: Option<String>,
    pub unplaced_beats_doc: String,
    pub unplaced_beat_preview: Option<String>,
    pub authorship_spans: Vec<SceneAuthorshipSpanInput>,
    pub foreshadow_setups: Vec<SceneForeshadowSetupInput>,
    pub foreshadow_payoffs: Vec<SceneForeshadowPayoffInput>,
    pub foreshadow_base_versions: HashMap<String, i64>,
    pub annotation_anchors: Vec<SceneAnnotationAnchorInput>,
    pub beat_mentions: Vec<SceneBeatMentionInput>,
    pub beat_pov_overrides: Vec<String>,
    pub doc_content_size: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSceneBodyBundleResult {
    pub placed_beat_preview: Option<String>,
    pub unplaced_beat_preview: Option<String>,
    pub content_version: i64,
    pub content_updated_at: String,
    /// Authoritative Foreshadow aggregate rows touched or observed by payoff persistence.
    pub foreshadow_rows: Vec<Value>,
    /// Number of SQLite transactions committed by this domain operation.
    pub db_transaction_count: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneBodyIdempotencyReceipt {
    foreshadow_ids: Vec<String>,
}

fn replay_scene_body_bundle_result(
    conn: &rusqlite::Connection,
    payload: &SaveSceneBodyBundlePayload,
    receipt: SceneBodyIdempotencyReceipt,
) -> anyhow::Result<SaveSceneBodyBundleResult> {
    let (placed_beat_preview, unplaced_beat_preview, content_version, content_updated_at) = conn
        .query_row(
            "SELECT placed_beat_preview, unplaced_beat_preview, version, updated_at
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![payload.scene_id, payload.project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let mut foreshadow_rows = Vec::new();
    for foreshadow_id in receipt.foreshadow_ids {
        let rows = Database::execute_with_conn(
            conn,
            "SELECT * FROM foreshadows WHERE id = ? AND project_id = ?",
            &[
                Value::String(foreshadow_id),
                Value::String(payload.project_id.clone()),
            ],
            "get",
        )?;
        if let Some(row) = rows.into_iter().next() {
            foreshadow_rows.push(Value::Object(row));
        }
    }
    Ok(SaveSceneBodyBundleResult {
        placed_beat_preview,
        unplaced_beat_preview,
        content_version,
        content_updated_at,
        foreshadow_rows,
        db_transaction_count: 0,
    })
}

fn validate_payload(payload: &SaveSceneBodyBundlePayload) -> anyhow::Result<()> {
    if payload.scene_id.trim().is_empty()
        || payload.project_id.trim().is_empty()
        || payload.request_id.trim().is_empty()
        || payload.session_id.trim().is_empty()
        || payload.event_uid.trim().is_empty()
    {
        anyhow::bail!("sceneId, projectId, requestId, sessionId, and eventUid must not be empty");
    }
    if payload.char_count < 0 || payload.doc_content_size < 0 {
        anyhow::bail!("scene document sizes must be non-negative");
    }
    if payload
        .timelapse_steps
        .as_ref()
        .is_some_and(|steps| steps.is_empty() || steps.iter().any(|step| !step.is_object()))
    {
        anyhow::bail!("timelapseSteps must be a non-empty array of step objects");
    }
    anyhow::ensure!(
        payload.timelapse_steps.is_none() || payload.timelapse_doc_step_coverage.is_none(),
        "timelapseSteps and timelapseDocStepCoverage are mutually exclusive"
    );
    anyhow::ensure!(
        matches!(
            payload.origin,
            NarrativeChangeOrigin::Human | NarrativeChangeOrigin::AiApply
        ),
        "scene body origin must be human or ai-apply"
    );
    if payload.base_version.is_some_and(|version| version < 0) {
        anyhow::bail!("scene base version must be non-negative");
    }
    if payload.updated_at.trim().is_empty()
        || chrono::DateTime::parse_from_rfc3339(&payload.updated_at).is_err()
    {
        anyhow::bail!("scene updatedAt must be a valid RFC3339 timestamp");
    }
    for span in &payload.authorship_spans {
        if span.from_pos < 0
            || span.to_pos < span.from_pos
            || !matches!(span.source.as_str(), "human" | "ai" | "unknown")
        {
            anyhow::bail!("invalid authorship span range");
        }
    }
    for setup in &payload.foreshadow_setups {
        if setup.id.is_empty()
            || setup.foreshadow_id.is_empty()
            || setup.from_pos < 0
            || setup.to_pos < setup.from_pos
            || setup.base_version < 0
        {
            anyhow::bail!("invalid foreshadow setup anchor");
        }
        if payload.foreshadow_base_versions.get(&setup.foreshadow_id) != Some(&setup.base_version) {
            anyhow::bail!("foreshadow setup baseVersion disagrees with scene snapshot");
        }
    }
    let mut payoff_ids = HashSet::new();
    for payoff in &payload.foreshadow_payoffs {
        if payoff.foreshadow_id.is_empty() || payoff.from_pos < 0 || payoff.to_pos < payoff.from_pos
        {
            anyhow::bail!("invalid foreshadow payoff anchor");
        }
        if payoff.base_version < 0 {
            anyhow::bail!("foreshadow payoff baseVersion must be non-negative");
        }
        if payload.foreshadow_base_versions.get(&payoff.foreshadow_id) != Some(&payoff.base_version)
        {
            anyhow::bail!("foreshadow payoff baseVersion disagrees with scene snapshot");
        }
        if !payoff_ids.insert(payoff.foreshadow_id.as_str()) {
            anyhow::bail!(
                "duplicate foreshadow payoff '{}' in one scene save",
                payoff.foreshadow_id
            );
        }
    }
    for annotation in &payload.annotation_anchors {
        if annotation.id.is_empty()
            || annotation.range_start < 0
            || annotation.range_end < annotation.range_start
        {
            anyhow::bail!("invalid annotation anchor");
        }
    }
    for mention in &payload.beat_mentions {
        if mention.beat_id.is_empty()
            || mention.codex_id.is_empty()
            || !matches!(mention.role.as_str(), "actor" | "target" | "mentioned")
        {
            anyhow::bail!("invalid beat mention");
        }
    }
    if payload
        .beat_pov_overrides
        .iter()
        .any(|codex_id| codex_id.is_empty())
    {
        anyhow::bail!("invalid beat POV override");
    }
    Ok(())
}

pub fn save_scene_body_bundle(
    db: &Database,
    payload: SaveSceneBodyBundlePayload,
) -> anyhow::Result<SaveSceneBodyBundleResult> {
    validate_payload(&payload)?;
    // A recorder session and caller-proposed canonical event UID are transport
    // metadata, not the durable identity of a domain request. A renderer may
    // restart between an ambiguous commit and its retry; replay the receipt in
    // that case while still binding every domain field and the Feed origin.
    let mut fingerprint_payload = payload.clone();
    fingerprint_payload.session_id.clear();
    fingerprint_payload.event_uid.clear();
    fingerprint_payload.timelapse_doc_step_coverage = None;
    let request_hash = payload_fingerprint(IDEMPOTENCY_DOMAIN, &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: IDEMPOTENCY_DOMAIN,
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "SCENE_BODY_BUNDLE_IDEMPOTENCY_CONFLICT",
    };
    let timestamp = event_timestamp(&payload.updated_at);
    db.with_conn(|conn| {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<SaveSceneBodyBundleResult> {
            if let Some(response) = load_idempotent_response(conn, &idempotency_request)? {
                return replay_scene_body_bundle_result(
                    conn,
                    &payload,
                    serde_json::from_value(response)?,
                );
            }
            let before_scene = scene_feed_snapshot(conn, &payload.project_id, &payload.scene_id)?;
            let mut before_foreshadows = BTreeMap::new();
            if payload.include_sidecars {
                for foreshadow_id in payload.foreshadow_base_versions.keys() {
                    if let Some(snapshot) = foreshadow_feed_snapshot(
                        conn,
                        &payload.project_id,
                        foreshadow_id,
                    )? {
                        before_foreshadows.insert(foreshadow_id.clone(), snapshot);
                    }
                }
            }
            let mut changed_roots = BTreeSet::new();
            let mut authoritative_foreshadows = Vec::new();
            let updated = conn
                .query_row(
                    "UPDATE tree_nodes
                        SET content = ?1,
                            unplaced_beats_doc = ?2,
                            char_count = ?3,
                            placed_beat_preview = ?4,
                            unplaced_beat_preview = ?5,
                            version = version + 1,
                            updated_at = ?6
                      WHERE id = ?7 AND project_id = ?8
                        AND (?9 IS NULL OR version = ?9)
                  RETURNING version, updated_at",
                    params![
                        payload.content_json,
                        payload.unplaced_beats_doc,
                        payload.char_count,
                        payload.placed_beat_preview,
                        payload.unplaced_beat_preview,
                        payload.updated_at,
                        payload.scene_id,
                        payload.project_id,
                        payload.base_version,
                    ],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "scene content conflict or scene not found in project: {} / {}",
                        payload.project_id,
                        payload.scene_id
                    )
                })?;

            // A renderer-supplied proof or replay-step list is not a sealed
            // Native authority. Until the recorder can pass a capability that
            // Native itself minted and validated, every body bundle takes the
            // conservative full-snapshot path. This also covers arbitrary or
            // mismatched `timelapseSteps`: they remain useful audit metadata,
            // but can never suppress the snapshot that represents the body
            // actually committed by this transaction.
            let append_body_snapshot = true;

            if payload.include_sidecars {
                conn.execute(
                    "DELETE FROM authorship_spans WHERE node_id = ?1",
                    params![payload.scene_id],
                )?;
                for span in &payload.authorship_spans {
                    conn.execute(
                        "INSERT INTO authorship_spans
                            (id, node_id, from_pos, to_pos, source, model, timestamp,
                             chat_msg_id, trace_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            uuid::Uuid::new_v4().to_string(),
                            payload.scene_id,
                            span.from_pos,
                            span.to_pos,
                            span.source,
                            span.model,
                            span.timestamp,
                            span.chat_msg_id,
                            span.trace_id,
                        ],
                    )?;
                }

                let now_ms = chrono::Utc::now().timestamp_millis();
                let mut valid_setup_ids = Vec::new();
                let mut touched_roots = BTreeSet::new();
                for setup in &payload.foreshadow_setups {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM foreshadows
                             WHERE id = ?1 AND project_id = ?2
                        )",
                        params![setup.foreshadow_id, payload.project_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        anyhow::bail!(
                            "foreshadow setup '{}' is not owned by project '{}'",
                            setup.id,
                            payload.project_id
                        );
                    }
                    let existing: Option<(String, String, String, i64, i64, i64)> = conn
                        .query_row(
                            "SELECT foreshadow_id, scene_id, semantic_key,
                                    from_pos, to_pos, is_orphan
                               FROM foreshadow_setups
                              WHERE id = ?1",
                            params![setup.id],
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
                        )
                        .optional()?;
                    if let Some((existing_foreshadow_id, existing_scene_id, ..)) = existing.as_ref()
                    {
                        if existing_foreshadow_id != &setup.foreshadow_id
                            || existing_scene_id != &payload.scene_id
                        {
                            anyhow::bail!(
                                "foreshadow setup '{}' belongs to a different anchor",
                                setup.id
                            );
                        }
                    }
                    let semantic_key = setup_semantic_key_for_upsert(
                        &setup.id,
                        &setup.foreshadow_id,
                        &payload.scene_id,
                        setup.from_pos,
                        setup.to_pos,
                        existing.as_ref().map(|(_, _, key, ..)| key.as_str()),
                    );
                    let changed = existing.as_ref().is_none_or(
                        |(_, _, existing_key, existing_from, existing_to, existing_orphan)| {
                            existing_key != &semantic_key
                                || *existing_from != setup.from_pos
                                || *existing_to != setup.to_pos
                                || *existing_orphan != 0
                        },
                    );
                    if changed {
                        conn.execute(
                            "INSERT INTO foreshadow_setups
                            (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                             attribution, is_orphan, semantic_key, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, 'designated_existing',
                                 'human', 0, ?6, ?7, ?7)
                         ON CONFLICT(id) DO UPDATE SET
                            scene_id = excluded.scene_id,
                            from_pos = excluded.from_pos,
                            to_pos = excluded.to_pos,
                            semantic_key = excluded.semantic_key,
                            is_orphan = 0,
                            updated_at = excluded.updated_at",
                            params![
                            setup.id,
                            setup.foreshadow_id,
                            payload.scene_id,
                            setup.from_pos,
                            setup.to_pos,
                            semantic_key,
                            now_ms,
                            ],
                        )?;
                        changed_roots.insert(setup.foreshadow_id.clone());
                    }
                    touched_roots.insert(setup.foreshadow_id.clone());
                    valid_setup_ids.push(setup.id.clone());
                }
                for payoff in &payload.foreshadow_payoffs {
                    let current: Option<PayoffRootState> = conn
                        .query_row(
                        "SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                           FROM foreshadows
                          WHERE id = ?1 AND project_id = ?2",
                        params![payoff.foreshadow_id, payload.project_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                    let Some((current_scene_id, current_from, current_to, current_version)) = current else {
                        anyhow::bail!(
                            "foreshadow payoff '{}' is not owned by project '{}'",
                            payoff.foreshadow_id,
                            payload.project_id
                        );
                    };
                    let unchanged = current_scene_id.as_deref() == Some(payload.scene_id.as_str())
                        && current_from == Some(payoff.from_pos)
                        && current_to == Some(payoff.to_pos);
                    if !unchanged {
                        anyhow::ensure!(
                            current_version == payoff.base_version,
                            "FORESHADOW_VERSION_MISMATCH: payoff '{}' expected version {}, found {}",
                            payoff.foreshadow_id,
                            payoff.base_version,
                            current_version
                        );
                        let affected = conn.execute(
                            "UPDATE foreshadows
                            SET payoff_scene_id = ?1,
                                payoff_from_pos = ?2,
                                payoff_to_pos = ?3,
                                updated_at = updated_at
                          WHERE id = ?4 AND project_id = ?5 AND version = ?6",
                        params![
                            payload.scene_id,
                            payoff.from_pos,
                            payoff.to_pos,
                            payoff.foreshadow_id,
                            payload.project_id,
                            payoff.base_version,
                        ],
                        )?;
                        anyhow::ensure!(
                            affected == 1,
                            "FORESHADOW_VERSION_MISMATCH: payoff '{}' expected version {}",
                            payoff.foreshadow_id,
                            payoff.base_version
                        );
                        changed_roots.insert(payoff.foreshadow_id.clone());
                    }
                    touched_roots.insert(payoff.foreshadow_id.clone());
                }
                if !valid_setup_ids.is_empty() || payload.doc_content_size <= 2 {
                    let valid: HashSet<&str> = valid_setup_ids.iter().map(String::as_str).collect();
                    let mut statement = conn.prepare(
                        "SELECT id, foreshadow_id, is_orphan
                           FROM foreshadow_setups WHERE scene_id = ?1",
                    )?;
                    let existing = statement
                        .query_map(params![payload.scene_id], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, i64>(2)?,
                            ))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(statement);
                    for (id, foreshadow_id, is_orphan) in existing {
                        if !valid.contains(id.as_str()) && is_orphan != 1 {
                            let changed = conn.execute(
                                "UPDATE foreshadow_setups
                                    SET is_orphan = 1, updated_at = ?1
                                  WHERE id = ?2 AND is_orphan IS NOT 1",
                                params![now_ms, id],
                            )? == 1;
                            if changed {
                                changed_roots.insert(foreshadow_id.clone());
                                touched_roots.insert(foreshadow_id);
                            }
                        }
                    }
                }

                for foreshadow_id in touched_roots {
                    let base_version = *payload
                        .foreshadow_base_versions
                        .get(&foreshadow_id)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "FORESHADOW_VERSION_MISMATCH: scene snapshot has no baseVersion for '{}'",
                                foreshadow_id
                            )
                        })?;
                    authoritative_foreshadows.push(finish_foreshadow_child_write(
                        conn,
                        &foreshadow_id,
                        changed_roots.contains(&foreshadow_id),
                        Some(base_version),
                        now_ms,
                    )?);
                    if changed_roots.contains(&foreshadow_id) {
                        let project_id: String = conn.query_row(
                            "SELECT project_id FROM foreshadows WHERE id = ?1",
                            params![foreshadow_id],
                            |row| row.get(0),
                        )?;
                        record_manual_foreshadow_fields(
                            conn,
                            &project_id,
                            &foreshadow_id,
                            &["/setups", "/payoffs"],
                            now_ms,
                        )?;
                    }
                }

                for annotation in &payload.annotation_anchors {
                    conn.execute(
                        "UPDATE post_effect_annotations
                            SET range_start = ?1,
                                range_end = ?2,
                                text_snapshot = ?3,
                                updated_at = datetime('now')
                          WHERE id = ?4 AND project_id = ?5 AND scene_id = ?6",
                        params![
                            annotation.range_start,
                            annotation.range_end,
                            annotation.text_snapshot,
                            annotation.id,
                            payload.project_id,
                            payload.scene_id,
                        ],
                    )?;
                }

                let mut wanted_mentions = HashSet::new();
                for mention in &payload.beat_mentions {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM codex_entries
                             WHERE id = ?1 AND project_id = ?2
                        )",
                        params![mention.codex_id, payload.project_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        continue;
                    }
                    conn.execute(
                        "INSERT INTO scene_codex_mentions
                            (scene_id, codex_entry_id, source, role)
                         VALUES (?1, ?2, 'beat', ?3)
                         ON CONFLICT(scene_id, codex_entry_id, source)
                         DO UPDATE SET role = excluded.role",
                        params![payload.scene_id, mention.codex_id, mention.role],
                    )?;
                    wanted_mentions.insert(mention.codex_id.as_str());
                }
                let mut statement = conn.prepare(
                    "SELECT codex_entry_id FROM scene_codex_mentions
                      WHERE scene_id = ?1 AND source = 'beat'",
                )?;
                let existing = statement
                    .query_map(params![payload.scene_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(statement);
                for codex_id in existing {
                    if !wanted_mentions.contains(codex_id.as_str()) {
                        conn.execute(
                            "DELETE FROM scene_codex_mentions
                              WHERE scene_id = ?1
                                AND codex_entry_id = ?2
                                AND source = 'beat'",
                            params![payload.scene_id, codex_id],
                        )?;
                    }
                }

                let mut wanted_povs = HashSet::new();
                for codex_id in &payload.beat_pov_overrides {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM codex_entries
                             WHERE id = ?1 AND project_id = ?2
                        )",
                        params![codex_id, payload.project_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        continue;
                    }
                    conn.execute(
                        "INSERT OR IGNORE INTO scene_beat_pov_cache
                            (scene_id, pov_character_id)
                         VALUES (?1, ?2)",
                        params![payload.scene_id, codex_id],
                    )?;
                    wanted_povs.insert(codex_id.as_str());
                }
                let mut statement = conn.prepare(
                    "SELECT pov_character_id FROM scene_beat_pov_cache
                      WHERE scene_id = ?1",
                )?;
                let existing = statement
                    .query_map(params![payload.scene_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(statement);
                for codex_id in existing {
                    if !wanted_povs.contains(codex_id.as_str()) {
                        conn.execute(
                            "DELETE FROM scene_beat_pov_cache
                              WHERE scene_id = ?1 AND pov_character_id = ?2",
                            params![payload.scene_id, codex_id],
                        )?;
                    }
                }
            }

            crate::narrative_extraction::record_human_field_write(
                conn,
                &payload.project_id,
                "scene",
                &payload.scene_id,
                &[
                    "/content",
                    "/unplacedBeatsDoc",
                    "/authorshipSpans",
                    "/foreshadowSetups",
                    "/foreshadowPayoffs",
                    "/beatMentions",
                    "/beatPovOverrides",
                ],
                &updated.1,
            )?;
            let source_key = format!("project:scene:{}", payload.scene_id);
            let source_token = format!("v{}@{}", updated.0, updated.1);
            crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                conn,
                &payload.project_id,
                "scene-body",
                &source_key,
                Some(&source_token),
                &updated.1,
                "scene-body-writer",
            )?;

            let after_scene = scene_feed_snapshot(conn, &payload.project_id, &payload.scene_id)?;
            let mut scene_paths = vec![
                "/charCount".to_string(),
                "/content".to_string(),
                "/placedBeatPreview".to_string(),
                "/unplacedBeatPreview".to_string(),
                "/unplacedBeatsDoc".to_string(),
            ];
            if payload.include_sidecars {
                scene_paths.extend(
                    [
                        "/authorshipSpans",
                        "/beatMentions",
                        "/beatPovOverrides",
                        "/foreshadowPayoffs",
                        "/foreshadowSetups",
                    ]
                    .into_iter()
                    .map(str::to_string),
                );
                scene_paths.sort();
            }
            let mut narrative_events = vec![feed_event(
                json!({ "kind": "scene", "sceneId": payload.scene_id }),
                "content",
                "update",
                Some(&before_scene),
                Some(&after_scene),
                scene_paths,
            )?];
            for foreshadow_id in &changed_roots {
                let after = foreshadow_feed_snapshot(
                    conn,
                    &payload.project_id,
                    foreshadow_id,
                )?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "changed foreshadow '{}' left the active project",
                        foreshadow_id
                    )
                })?;
                narrative_events.push(feed_event(
                    json!({ "kind": "foreshadow", "foreshadowId": foreshadow_id }),
                    "association",
                    "update",
                    before_foreshadows.get(foreshadow_id),
                    Some(&after),
                    vec!["/payoffs".to_string(), "/setups".to_string()],
                )?);
            }
            let (canonical_op_type, canonical_payload) = match &payload.timelapse_steps {
                Some(steps) => ("doc.step", json!({ "steps": steps })),
                None => (
                    "scene-body.save",
                    json!({
                        "sceneId": payload.scene_id,
                        "foreshadowRootIds": changed_roots,
                    }),
                ),
            };
            let append = append_canonical_and_narrative_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: Some(payload.scene_id.clone()),
                    domain: "editor".to_string(),
                    op_type: canonical_op_type.to_string(),
                    entity_type: Some("scene".to_string()),
                    entity_id: Some(payload.scene_id.clone()),
                    payload: canonical_payload.to_string(),
                    timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: canonical_op_type.to_string(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: payload.origin,
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: Vec::new(),
                    occurred_at: updated.1.clone(),
                    events: narrative_events,
                },
            )?;
            if append_body_snapshot {
                crate::timelapse::append_timelapse_body_snapshots_in_tx(
                    conn,
                    &payload.project_id,
                    append.canonical.tail_sequence,
                    timestamp,
                    &[crate::timelapse::TimelapseBodySnapshotTarget::scene(
                        payload.scene_id.clone(),
                    )],
                )?;
            }

            let response = SaveSceneBodyBundleResult {
                placed_beat_preview: payload.placed_beat_preview.clone(),
                unplaced_beat_preview: payload.unplaced_beat_preview.clone(),
                content_version: updated.0,
                content_updated_at: updated.1,
                foreshadow_rows: authoritative_foreshadows,
                db_transaction_count: 1,
            };
            insert_idempotent_response(
                conn,
                &idempotency_request,
                &payload.project_id,
                &serde_json::to_value(SceneBodyIdempotencyReceipt {
                    foreshadow_ids: response
                        .foreshadow_rows
                        .iter()
                        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_string))
                        .collect(),
                })?,
            )?;
            Ok(response)
        })();

        match result {
            Ok(value) => {
                if let Err(error) = conn.execute_batch("COMMIT") {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open test db");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Project')",
            &[Value::String("p1".into())],
            "run",
        )
        .expect("insert project");
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES (?, ?, 'scene', 'Scene', ?)",
            &[
                Value::String("s1".into()),
                Value::String("p1".into()),
                Value::String("{\"old\":true}".into()),
            ],
            "run",
        )
        .expect("insert scene");
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name)
             VALUES ('c1', 'p1', 'character', 'Character'),
                    ('c2', 'p1', 'character', 'Stale Character')",
            &[],
            "run",
        )
        .expect("insert codex");
        db.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES ('f1', 'p1', 'Setup', 0, 0, 0, 1, 1),
                    ('f2', 'p1', 'Payoff', 0, 0, 0, 1, 1)",
            &[],
            "run",
        )
        .expect("insert foreshadows");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO authorship_spans
                (id, node_id, from_pos, to_pos, source)
             VALUES ('old-span', 's1', 0, 1, 'unknown');
             INSERT INTO foreshadow_setups
                (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                 attribution, is_orphan, semantic_key, created_at, updated_at)
             VALUES ('setup-stale', 'f1', 's1', 0, 1, 'designated_existing',
                     'human', 0, 'f1|s1|0|1', 1, 1);
             INSERT INTO post_effect_annotations
                (id, project_id, scene_id, range_start, range_end, text_snapshot,
                 category, content)
             VALUES ('a1', 'p1', 's1', 0, 1, 'old', 'review', 'Review');
             INSERT INTO scene_codex_mentions
                (scene_id, codex_entry_id, source, role)
             VALUES ('s1', 'c2', 'beat', 'target');
             INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id)
             VALUES ('s1', 'c2');",
            )?;
            Ok(())
        })
        .expect("seed stale sidecars");
        db
    }

    fn payload() -> SaveSceneBodyBundlePayload {
        let request_id = uuid::Uuid::new_v4().to_string();
        SaveSceneBodyBundlePayload {
            scene_id: "s1".into(),
            project_id: "p1".into(),
            event_uid: request_id.clone(),
            request_id,
            session_id: "scene-test-session".into(),
            origin: NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            timelapse_doc_step_coverage: None,
            include_sidecars: true,
            base_version: None,
            updated_at: "2026-07-28T00:00:00.000Z".into(),
            content_json: "{\"type\":\"doc\"}".into(),
            char_count: 12,
            placed_beat_preview: Some("[\"beat\"]".into()),
            unplaced_beats_doc: "[]".into(),
            unplaced_beat_preview: None,
            authorship_spans: vec![SceneAuthorshipSpanInput {
                from_pos: 1,
                to_pos: 4,
                source: "human".into(),
                model: None,
                timestamp: None,
                chat_msg_id: None,
                trace_id: None,
            }],
            foreshadow_setups: vec![SceneForeshadowSetupInput {
                id: "setup-current".into(),
                foreshadow_id: "f1".into(),
                base_version: 0,
                from_pos: 2,
                to_pos: 5,
            }],
            foreshadow_payoffs: vec![SceneForeshadowPayoffInput {
                foreshadow_id: "f2".into(),
                base_version: 0,
                from_pos: 6,
                to_pos: 9,
            }],
            foreshadow_base_versions: HashMap::from([("f1".into(), 0), ("f2".into(), 0)]),
            annotation_anchors: vec![SceneAnnotationAnchorInput {
                id: "a1".into(),
                range_start: 3,
                range_end: 8,
                text_snapshot: "updated".into(),
            }],
            beat_mentions: vec![SceneBeatMentionInput {
                beat_id: "b1".into(),
                codex_id: "c1".into(),
                role: "actor".into(),
            }],
            beat_pov_overrides: vec!["c1".into()],
            doc_content_size: 20,
        }
    }

    #[test]
    fn saves_content_and_sidecars_in_one_bundle() {
        let db = test_db();
        let result = save_scene_body_bundle(&db, payload()).expect("save");
        assert_eq!(result.content_version, 1);
        assert_eq!(result.placed_beat_preview.as_deref(), Some("[\"beat\"]"));
        assert_eq!(result.db_transaction_count, 1);
        assert_eq!(result.foreshadow_rows.len(), 2);
        assert!(result.foreshadow_rows.iter().all(|row| row["version"] == 1));

        let rows = db
            .execute(
                "SELECT content, char_count, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load scene");
        assert_eq!(rows[0]["content"], "{\"type\":\"doc\"}");
        assert_eq!(rows[0]["char_count"], 12);
        assert_eq!(rows[0]["version"], 1);

        let span_count = db
            .execute(
                "SELECT count(*) AS count FROM authorship_spans WHERE node_id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load spans");
        assert_eq!(span_count[0]["count"], 1);
        let mention_count = db
            .execute(
                "SELECT count(*) AS count FROM scene_codex_mentions WHERE scene_id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load mentions");
        assert_eq!(mention_count[0]["count"], 1);

        let current_setup = db
            .execute(
                "SELECT from_pos, to_pos, is_orphan
                   FROM foreshadow_setups WHERE id = 'setup-current'",
                &[],
                "get",
            )
            .expect("load current setup");
        assert_eq!(current_setup[0]["from_pos"], 2);
        assert_eq!(current_setup[0]["to_pos"], 5);
        assert_eq!(current_setup[0]["is_orphan"], 0);
        let stale_setup = db
            .execute(
                "SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-stale'",
                &[],
                "get",
            )
            .expect("load stale setup");
        assert_eq!(stale_setup[0]["is_orphan"], 1);

        let payoff = db
            .execute(
                "SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                   FROM foreshadows WHERE id = 'f2'",
                &[],
                "get",
            )
            .expect("load payoff");
        assert_eq!(payoff[0]["payoff_scene_id"], "s1");
        assert_eq!(payoff[0]["payoff_from_pos"], 6);
        assert_eq!(payoff[0]["payoff_to_pos"], 9);
        assert_eq!(payoff[0]["version"], 1);

        let annotation = db
            .execute(
                "SELECT range_start, range_end, text_snapshot
                   FROM post_effect_annotations WHERE id = 'a1'",
                &[],
                "get",
            )
            .expect("load annotation");
        assert_eq!(annotation[0]["range_start"], 3);
        assert_eq!(annotation[0]["range_end"], 8);
        assert_eq!(annotation[0]["text_snapshot"], "updated");

        let mentions = db
            .execute(
                "SELECT codex_entry_id, role FROM scene_codex_mentions
                  WHERE scene_id = 's1' AND source = 'beat'",
                &[],
                "all",
            )
            .expect("load mentions");
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0]["codex_entry_id"], "c1");
        assert_eq!(mentions[0]["role"], "actor");
        let povs = db
            .execute(
                "SELECT pov_character_id FROM scene_beat_pov_cache WHERE scene_id = 's1'",
                &[],
                "all",
            )
            .expect("load POV cache");
        assert_eq!(povs.len(), 1);
        assert_eq!(povs[0]["pov_character_id"], "c1");
    }

    #[test]
    fn scene_bundle_appends_scene_then_changed_foreshadow_roots() {
        let db = test_db();
        let mut input = payload();
        input.request_id = "scene-save-request".to_string();
        input.event_uid = "scene-save-event".to_string();
        input.session_id = "scene-save-session".to_string();

        save_scene_body_bundle(&db, input).expect("save tracked scene bundle");

        db.with_conn(|conn| {
            let transaction: (String, String, String) = conn.query_row(
                "SELECT request_id, source_domain, origin
                   FROM narrative_change_transactions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                transaction,
                (
                    "scene-save-request".to_string(),
                    "scene-body.save".to_string(),
                    "human".to_string(),
                )
            );

            let events = conn
                .prepare(
                    "SELECT object_key_json, change_kind, mutation_kind,
                            before_version, after_version, changed_paths_json,
                            text_impact_json
                       FROM narrative_change_events
                      ORDER BY event_ordinal",
                )?
                .query_map([], |row| {
                    Ok((
                        serde_json::from_str::<Value>(&row.get::<_, String>(0)?)
                            .expect("valid object key"),
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        serde_json::from_str::<Value>(&row.get::<_, String>(5)?)
                            .expect("valid changed paths"),
                        row.get::<_, Option<String>>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(events.len(), 3);
            assert_eq!(
                events[0].0,
                serde_json::json!({ "kind": "scene", "sceneId": "s1" })
            );
            assert_eq!(events[0].1, "content");
            assert_eq!(events[0].2, "update");
            assert_eq!((events[0].3, events[0].4), (Some(0), Some(1)));
            let text_impact: Value =
                serde_json::from_str(events[0].6.as_deref().expect("scene feed text impact"))?;
            assert_eq!(
                text_impact["normalizerVersion"],
                crate::narrative_extraction::change_feed::CANONICAL_TEXT_NORMALIZER_VERSION
            );
            assert_eq!(text_impact["mapping"]["kind"], "whole-document");
            assert_eq!(
                events[1].0,
                serde_json::json!({ "kind": "foreshadow", "foreshadowId": "f1" })
            );
            assert_eq!(
                events[2].0,
                serde_json::json!({ "kind": "foreshadow", "foreshadowId": "f2" })
            );
            assert!(events[1..].iter().all(|event| event.1 == "association"
                && event.2 == "update"
                && event.5 == serde_json::json!(["/payoffs", "/setups"])));
            Ok(())
        })
        .expect("inspect scene feed");
    }

    #[test]
    fn scene_bundle_preserves_ai_apply_origin() {
        let db = test_db();
        let mut input = payload();
        input.origin = NarrativeChangeOrigin::AiApply;

        save_scene_body_bundle(&db, input).expect("save AI-applied scene bundle");

        db.with_conn(|conn| {
            let origin: String = conn.query_row(
                "SELECT origin FROM narrative_change_transactions",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(origin, "ai-apply");
            Ok(())
        })
        .expect("load Feed origin");
    }

    #[test]
    fn headless_scene_bundle_adopts_replay_steps_as_the_canonical_event() {
        let db = test_db();
        let mut input = payload();
        input.origin = NarrativeChangeOrigin::AiApply;
        input.timelapse_steps = Some(vec![json!({
            "stepType": "replace",
            "from": 1,
            "to": 1,
            "slice": { "content": [] }
        })]);

        save_scene_body_bundle(&db, input).expect("save headless replayable body write");

        db.with_conn(|conn| {
            let (op_type, payload): (String, String) =
                conn.query_row("SELECT op_type, payload FROM change_events", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
            assert_eq!(op_type, "doc.step");
            assert_eq!(
                serde_json::from_str::<Value>(&payload)?,
                json!({
                    "steps": [{
                        "stepType": "replace",
                        "from": 1,
                        "to": 1,
                        "slice": { "content": [] }
                    }]
                })
            );
            let linked_uid: String = conn.query_row(
                "SELECT source_change_event_uid FROM narrative_change_transactions",
                [],
                |row| row.get(0),
            )?;
            let canonical_uid: String =
                conn.query_row("SELECT event_uid FROM change_events", [], |row| row.get(0))?;
            assert_eq!(linked_uid, canonical_uid);
            Ok(())
        })
        .expect("inspect atomic headless event");
    }

    #[test]
    fn renderer_replay_steps_cannot_suppress_the_authoritative_body_snapshot() {
        let db = test_db();
        let mut input = payload();
        input.timelapse_steps = Some(vec![serde_json::json!({
            "stepType": "replace",
            "from": 999,
            "to": 999,
            "slice": { "content": [] }
        })]);
        input.content_json =
            "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"native body\"}]}]}"
                .to_string();

        save_scene_body_bundle(&db, input).expect("save mismatched replay steps");

        db.with_conn(|conn| {
            let (count, payload): (i64, String) = conn.query_row(
                "SELECT COUNT(*), payload
                   FROM state_snapshots
                  WHERE project_id = 'p1' AND entity_id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(count, 1, "mismatched steps must still retain a snapshot");
            assert!(payload.contains("native body"));
            Ok(())
        })
        .expect("inspect authoritative body snapshot");
    }

    #[test]
    fn scene_feed_failure_rolls_back_scene_and_foreshadow_roots() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_scene_feed
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced scene feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install feed failure");
        let mut input = payload();
        input.request_id = "scene-feed-failure".to_string();
        input.event_uid = "scene-feed-failure-event".to_string();

        let error = save_scene_body_bundle(&db, input)
            .expect_err("feed failure must reject the complete scene bundle");
        assert!(error.to_string().contains("forced scene feed failure"));

        db.with_conn(|conn| {
            let state: (String, i64, i64, i64, i64, i64) = conn.query_row(
                "SELECT content, version,
                        (SELECT version FROM foreshadows WHERE id = 'f1'),
                        (SELECT COUNT(*) FROM change_events),
                        (SELECT COUNT(*) FROM narrative_change_transactions),
                        (SELECT COUNT(*) FROM idempotency_requests
                          WHERE domain = 'save_scene_body_bundle')
                   FROM tree_nodes WHERE id = 's1'",
                [],
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
            assert_eq!(state, ("{\"old\":true}".to_string(), 0, 0, 0, 0, 0));
            Ok(())
        })
        .expect("verify scene feed rollback");
    }

    #[test]
    fn scene_bundle_requires_caller_owned_identity() {
        let db = test_db();
        for missing in ["request", "session", "event"] {
            let mut input = payload();
            match missing {
                "request" => input.request_id.clear(),
                "session" => input.session_id.clear(),
                "event" => input.event_uid.clear(),
                _ => unreachable!(),
            }
            let error = save_scene_body_bundle(&db, input)
                .expect_err("missing identity must fail before mutation");
            assert!(error.to_string().contains("must not be empty"));
        }
        let version = db
            .execute(
                "SELECT version FROM tree_nodes WHERE id = 's1'",
                &[],
                "load scene version",
            )
            .expect("load scene version");
        assert_eq!(version[0]["version"], 0);
    }

    #[test]
    fn scene_bundle_cross_session_retry_replays_without_duplicate_ledgers() {
        let db = test_db();
        let input = payload();
        let first = save_scene_body_bundle(&db, input.clone()).expect("first save");
        let mut replay = input;
        replay.session_id = "scene-session-after-restart".to_string();
        replay.event_uid = "scene-event-after-restart".to_string();
        let retry = save_scene_body_bundle(&db, replay).expect("cross-session retry");
        assert_eq!(retry.content_version, first.content_version);
        assert_eq!(retry.content_updated_at, first.content_updated_at);

        db.with_conn(|conn| {
            let counts: (i64, i64, i64, i64, i64) = conn.query_row(
                "SELECT (SELECT version FROM tree_nodes WHERE id = 's1'),
                        (SELECT COUNT(*) FROM change_events),
                        (SELECT COUNT(*) FROM narrative_change_transactions),
                        (SELECT COUNT(*) FROM narrative_change_events),
                        (SELECT COUNT(*) FROM idempotency_requests
                          WHERE domain = 'save_scene_body_bundle')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(counts, (1, 1, 1, 3, 1));
            Ok(())
        })
        .expect("inspect retry ledgers");
    }

    #[test]
    fn scene_bundle_rejects_request_reuse_with_changed_payload() {
        let db = test_db();
        let input = payload();
        save_scene_body_bundle(&db, input.clone()).expect("first save");
        let mut conflict = input;
        conflict.content_json = "{\"changed\":true}".to_string();
        let error =
            save_scene_body_bundle(&db, conflict).expect_err("changed retry payload must conflict");
        assert!(error
            .to_string()
            .contains("SCENE_BODY_BUNDLE_IDEMPOTENCY_CONFLICT"));

        let state = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = 's1'",
                &[],
                "load scene after conflicting retry",
            )
            .expect("load scene");
        assert_eq!(state[0]["content"], "{\"type\":\"doc\"}");
        assert_eq!(state[0]["version"], 1);
    }

    #[test]
    fn identical_foreshadow_sidecars_are_noop_and_return_authoritative_versions() {
        let db = test_db();
        let first = save_scene_body_bundle(&db, payload()).expect("first bundle save");
        assert!(first.foreshadow_rows.iter().all(|row| row["version"] == 1));

        // The editor payload still carries its original token here. Because
        // every sidecar value is identical, this is a true no-op that refreshes
        // the caller with the authoritative version instead of self-conflicting.
        let second = save_scene_body_bundle(&db, payload()).expect("identical bundle save");
        assert_eq!(second.foreshadow_rows.len(), 2);
        assert!(second.foreshadow_rows.iter().all(|row| row["version"] == 1));

        let roots = db
            .execute(
                "SELECT id, version FROM foreshadows ORDER BY id",
                &[],
                "load root versions",
            )
            .expect("load root versions");
        assert!(roots.iter().all(|row| row["version"] == 1));
    }

    #[test]
    fn stale_payoff_sidecar_rolls_back_scene_and_all_earlier_sidecars() {
        let db = test_db();
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES ('s2', 'p1', 'scene', 'Other Scene', '{}')",
            &[],
            "insert second scene",
        )
        .expect("insert second scene");
        db.execute(
            "UPDATE foreshadows
                SET payoff_scene_id = 's2', payoff_from_pos = 10,
                    payoff_to_pos = 12, version = 1
              WHERE id = 'f2' AND version = 0",
            &[],
            "simulate other window payoff move",
        )
        .expect("simulate other window payoff move");

        let error = save_scene_body_bundle(&db, payload())
            .expect_err("stale payoff autosave must conflict atomically");
        assert!(error.to_string().contains("FORESHADOW_VERSION_MISMATCH"));

        let scene = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = 's1'",
                &[],
                "load rolled-back scene",
            )
            .expect("load rolled-back scene");
        assert_eq!(scene[0]["content"], "{\"old\":true}");
        assert_eq!(scene[0]["version"], 0);
        let setups = db
            .execute(
                "SELECT id, is_orphan FROM foreshadow_setups ORDER BY id",
                &[],
                "load rolled-back setups",
            )
            .expect("load rolled-back setups");
        assert_eq!(setups.len(), 1);
        assert_eq!(setups[0]["id"], "setup-stale");
        assert_eq!(setups[0]["is_orphan"], 0);
        let roots = db
            .execute(
                "SELECT id, payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                   FROM foreshadows ORDER BY id",
                &[],
                "load roots after stale payoff",
            )
            .expect("load roots after stale payoff");
        assert_eq!(roots[0]["id"], "f1");
        assert_eq!(roots[0]["version"], 0);
        assert_eq!(roots[1]["id"], "f2");
        assert_eq!(roots[1]["payoff_scene_id"], "s2");
        assert_eq!(roots[1]["payoff_from_pos"], 10);
        assert_eq!(roots[1]["payoff_to_pos"], 12);
        assert_eq!(roots[1]["version"], 1);
    }

    #[test]
    fn rejects_stale_base_version_without_mutating_content() {
        let db = test_db();
        let mut first = payload();
        first.base_version = Some(0);
        save_scene_body_bundle(&db, first).expect("first versioned save");

        let mut stale = payload();
        stale.base_version = Some(0);
        stale.content_json = "{\"stale\":true}".into();
        let error = save_scene_body_bundle(&db, stale).expect_err("stale save");
        assert!(error.to_string().contains("conflict"));

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "load after stale save",
            )
            .expect("load scene");
        assert_eq!(rows[0]["content"], "{\"type\":\"doc\"}");
        assert_eq!(rows[0]["version"], 1);
    }

    #[test]
    fn uses_renderer_timestamp_for_monotonic_content_tokens() {
        let db = test_db();
        let mut first = payload();
        first.include_sidecars = false;
        first.updated_at = "2026-07-28T00:00:00.000Z".into();
        save_scene_body_bundle(&db, first).expect("first save");

        let mut second = payload();
        second.include_sidecars = false;
        second.updated_at = "2026-07-28T00:00:00.001Z".into();
        let result = save_scene_body_bundle(&db, second).expect("second save");

        assert_eq!(result.content_updated_at, "2026-07-28T00:00:00.001Z");
        let rows = db
            .execute(
                "SELECT version, updated_at FROM tree_nodes WHERE id = 's1'",
                &[],
                "load timestamp token",
            )
            .expect("load timestamp token");
        assert_eq!(rows[0]["version"], 2);
        assert_eq!(rows[0]["updated_at"], "2026-07-28T00:00:00.001Z");
    }

    #[test]
    fn rejects_foreign_foreshadow_setup_without_mutating_scene() {
        let db = test_db();
        db.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other Project')",
            &[],
            "insert other project",
        )
        .expect("insert other project");
        db.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES ('f-foreign', 'p2', 'Foreign', 0, 0, 0, 1, 1)",
            &[],
            "insert foreign foreshadow",
        )
        .expect("insert foreign foreshadow");

        let mut foreign = payload();
        foreign.foreshadow_setups[0].foreshadow_id = "f-foreign".into();
        foreign
            .foreshadow_base_versions
            .insert("f-foreign".into(), 0);
        let error = save_scene_body_bundle(&db, foreign).expect_err("foreign setup");
        assert!(error.to_string().contains("not owned by project"));

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = 's1'",
                &[],
                "load after foreign setup",
            )
            .expect("load after foreign setup");
        assert_eq!(rows[0]["content"], "{\"old\":true}");
        assert_eq!(rows[0]["version"], 0);
        let root = db
            .execute(
                "SELECT version FROM foreshadows WHERE id = 'f-foreign'",
                &[],
                "load foreign root after rejected setup",
            )
            .expect("load foreign root after rejected setup");
        assert_eq!(root[0]["version"], 0);
    }

    #[test]
    fn rejects_setup_id_rebinding_without_mutating_existing_anchor() {
        let db = test_db();
        let mut rebinding = payload();
        rebinding.foreshadow_setups[0].id = "setup-stale".into();
        rebinding.foreshadow_setups[0].foreshadow_id = "f2".into();
        let error = save_scene_body_bundle(&db, rebinding).expect_err("setup rebinding");
        assert!(error.to_string().contains("different anchor"));

        let rows = db
            .execute(
                "SELECT from_pos, to_pos, is_orphan
                   FROM foreshadow_setups WHERE id = 'setup-stale'",
                &[],
                "load after setup rebinding",
            )
            .expect("load after setup rebinding");
        assert_eq!(rows[0]["from_pos"], 0);
        assert_eq!(rows[0]["to_pos"], 1);
        assert_eq!(rows[0]["is_orphan"], 0);
    }

    #[test]
    fn preserves_matching_legacy_duplicate_setup_semantic_key() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO foreshadow_setups
                    (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                     attribution, is_orphan, semantic_key, created_at, updated_at)
                 VALUES
                    ('setup-natural', 'f1', 's1', 2, 5, 'designated_existing',
                     'human', 0, 'f1|s1|2|5', 1, 1),
                    ('setup-current', 'f1', 's1', 2, 5, 'designated_existing',
                     'human', 0, 'f1|s1|2|5#dup:setup-current', 1, 1);",
            )?;
            Ok(())
        })
        .expect("insert legacy duplicate setup fixture");

        save_scene_body_bundle(&db, payload())
            .expect("legacy duplicate semantic key should remain writeable");
        let rows = db
            .execute(
                "SELECT semantic_key FROM foreshadow_setups WHERE id = 'setup-current'",
                &[],
                "load preserved legacy duplicate key",
            )
            .expect("load preserved legacy duplicate key");
        assert_eq!(
            rows[0]["semantic_key"],
            Value::String("f1|s1|2|5#dup:setup-current".to_string())
        );
    }

    #[test]
    fn rejects_foreign_foreshadow_payoff_without_mutating_scene() {
        let db = test_db();
        db.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other Project')",
            &[],
            "insert other project",
        )
        .expect("insert other project");
        db.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES ('f-foreign', 'p2', 'Foreign', 0, 0, 0, 1, 1)",
            &[],
            "insert foreign foreshadow",
        )
        .expect("insert foreign foreshadow");

        let mut foreign = payload();
        foreign.foreshadow_payoffs[0].foreshadow_id = "f-foreign".into();
        foreign
            .foreshadow_base_versions
            .insert("f-foreign".into(), 0);
        let error = save_scene_body_bundle(&db, foreign).expect_err("foreign payoff");
        assert!(error.to_string().contains("not owned by project"));

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = 's1'",
                &[],
                "load after foreign payoff",
            )
            .expect("load after foreign payoff");
        assert_eq!(rows[0]["content"], "{\"old\":true}");
        assert_eq!(rows[0]["version"], 0);
        let root = db
            .execute(
                "SELECT version FROM foreshadows WHERE id = 'f-foreign'",
                &[],
                "load foreign root after rejected payoff",
            )
            .expect("load foreign root after rejected payoff");
        assert_eq!(root[0]["version"], 0);
    }

    #[test]
    fn skips_sidecars_for_file_backed_content() {
        let db = test_db();
        let mut file_backed = payload();
        file_backed.include_sidecars = false;
        file_backed.content_json = "{\"external\":true}".into();
        let result = save_scene_body_bundle(&db, file_backed).expect("save external content");
        assert_eq!(result.db_transaction_count, 1);

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load scene");
        assert_eq!(rows[0]["content"], "{\"external\":true}");
        assert_eq!(rows[0]["version"], 1);
        let sidecars = db
            .execute(
                "SELECT
                    (SELECT source FROM authorship_spans WHERE id = 'old-span') AS source,
                    (SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-stale') AS is_orphan,
                    (SELECT text_snapshot FROM post_effect_annotations WHERE id = 'a1') AS annotation,
                    (SELECT codex_entry_id FROM scene_codex_mentions
                      WHERE scene_id = 's1' AND source = 'beat') AS mention,
                    (SELECT pov_character_id FROM scene_beat_pov_cache
                      WHERE scene_id = 's1') AS pov",
                &[],
                "get",
            )
            .expect("load untouched sidecars");
        assert_eq!(sidecars[0]["source"], "unknown");
        assert_eq!(sidecars[0]["is_orphan"], 0);
        assert_eq!(sidecars[0]["annotation"], "old");
        assert_eq!(sidecars[0]["mention"], "c2");
        assert_eq!(sidecars[0]["pov"], "c2");
    }

    #[test]
    fn keeps_live_annotations_whose_body_anchor_is_missing() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('live-a1', 'p1', 's1', 0, 3, '本文',
                         'pseudo_comment', 'ライブ', '{\"live\":true}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('manual-a1', 'p1', 's1', 0, 3, '本文',
                         'pseudo_comment', '手動疑似', '{\"live\":false}')",
                [],
            )?;
            Ok(())
        })
        .expect("insert live annotations");

        save_scene_body_bundle(&db, payload()).expect("save without live anchor");

        let rows = db
            .execute(
                "SELECT id FROM post_effect_annotations
                  WHERE scene_id = 's1' ORDER BY id",
                &[],
                "load annotations",
            )
            .expect("load annotations");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["id"], "a1");
        assert_eq!(rows[1]["id"], "live-a1");
        assert_eq!(rows[2]["id"], "manual-a1");
    }

    #[test]
    fn keeps_live_annotation_when_target_text_remains_without_body_mark() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('live-a1', 'p1', 's1', 0, 3, '本文',
                         'pseudo_comment', 'ライブ', '{\"live\":true}')",
                [],
            )?;
            Ok(())
        })
        .expect("insert live annotation");

        let mut payload = payload();
        payload.content_json =
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"本文"}]}]}"#
                .into();
        payload.annotation_anchors.clear();
        save_scene_body_bundle(&db, payload).expect("save without visible mark");

        let rows = db
            .execute(
                "SELECT id FROM post_effect_annotations WHERE id = 'live-a1'",
                &[],
                "load retained annotation",
            )
            .expect("load annotations");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn keeps_live_annotation_without_a_text_snapshot() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('live-a1', 'p1', 's1', 0, 0, NULL,
                         'pseudo_comment', 'シーン全体の感想', '{\"live\":true}')",
                [],
            )?;
            Ok(())
        })
        .expect("insert scene-level live annotation");

        save_scene_body_bundle(&db, payload()).expect("save scene-level annotation");

        let rows = db
            .execute(
                "SELECT id FROM post_effect_annotations WHERE id = 'live-a1'",
                &[],
                "load scene-level annotation",
            )
            .expect("load annotations");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn rolls_content_back_when_a_sidecar_insert_fails_after_update() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER force_authorship_failure
                   BEFORE INSERT ON authorship_spans
                   BEGIN
                     SELECT RAISE(ABORT, 'forced authorship failure');
                   END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");

        assert!(save_scene_body_bundle(&db, payload()).is_err());

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load rolled back scene");
        assert_eq!(rows[0]["content"], "{\"old\":true}");
        assert_eq!(rows[0]["version"], 0);
        let spans = db
            .execute(
                "SELECT id, source FROM authorship_spans WHERE node_id = 's1'",
                &[],
                "all",
            )
            .expect("load restored spans");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0]["id"], "old-span");
        assert_eq!(spans[0]["source"], "unknown");
    }

    #[test]
    fn rolls_foreshadow_version_back_when_a_later_sidecar_update_fails() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER force_annotation_failure
                   BEFORE UPDATE ON post_effect_annotations
                   BEGIN
                     SELECT RAISE(ABORT, 'forced annotation failure');
                   END;",
            )?;
            Ok(())
        })
        .expect("install late failure trigger");

        assert!(save_scene_body_bundle(&db, payload()).is_err());

        let roots = db
            .execute(
                "SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                 FROM foreshadows WHERE id = 'f2'",
                &[],
                "load rolled back payoff root",
            )
            .expect("load rolled back payoff root");
        assert!(roots[0]["payoff_scene_id"].is_null());
        assert!(roots[0]["payoff_from_pos"].is_null());
        assert!(roots[0]["payoff_to_pos"].is_null());
        assert_eq!(roots[0]["version"], 0);
    }
}
