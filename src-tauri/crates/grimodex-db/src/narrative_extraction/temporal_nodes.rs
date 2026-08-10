//! Temporal Constraint Graph (TCG) Node persistence for narrative apply commits.
//!
//! A Node identifies one temporal subject (scene / event / state-boundary /
//! phase-boundary / named-period) inside one timeline. `ensure` is idempotent
//! on the server-computed semantic key so re-running an extraction task never
//! creates duplicate nodes for the same subject.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const OP_KIND_NODE_ENSURE: &str = "temporal.node.ensure";

const VALID_TIMELINE_KINDS: &[&str] = &["primary", "alternate", "embedded-fiction", "hypothetical"];
const VALID_SHAPES: &[&str] = &["point", "interval", "unknown"];
const VALID_SUBJECT_KINDS: &[&str] = &[
    "scene",
    "event",
    "state-boundary",
    "phase-boundary",
    "named-period",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporalNodeEnsurePayload {
    pub node_id: String,
    #[serde(default = "default_timeline_kind")]
    pub timeline_kind: String,
    #[serde(default)]
    pub timeline_key: Option<String>,
    pub subject: Value,
    #[serde(default = "default_shape")]
    pub shape: String,
}

fn default_timeline_kind() -> String {
    "primary".to_string()
}

fn default_shape() -> String {
    "unknown".to_string()
}

pub(crate) fn parse_node_ensure_payload(payload: &Value) -> anyhow::Result<TemporalNodeEnsurePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid temporal.node.ensure payload: {err}"))
}

#[derive(Debug, Clone)]
pub(crate) struct TemporalNodeTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    /// `false` when an existing node with a matching semantic key was
    /// returned instead of inserting a new row (idempotent ensure).
    pub created: bool,
}

/// Mirrors `temporalSubjectKey` in `src/features/narrative-extraction/temporal/nodes.ts`,
/// scoped additionally by timeline so the same subject in an alternate
/// timeline is a distinct node.
pub(crate) fn compute_node_semantic_key(
    timeline_kind: &str,
    timeline_key: Option<&str>,
    subject: &Value,
) -> anyhow::Result<String> {
    let subject_kind = subject
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal node subject missing kind"))?;
    anyhow::ensure!(
        VALID_SUBJECT_KINDS.contains(&subject_kind),
        "invalid temporal node subject kind '{subject_kind}'"
    );
    let subject_parts: Vec<Value> = match subject_kind {
        "scene" => vec![
            subject
                .get("documentRef")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("scene subject missing documentRef"))?,
            subject.get("segmentRef").cloned().unwrap_or(Value::Null),
        ],
        "event" => vec![subject
            .get("eventId")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("event subject missing eventId"))?],
        "state-boundary" | "phase-boundary" => vec![subject
            .get("inferenceId")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("boundary subject missing inferenceId"))?],
        "named-period" => vec![subject
            .get("label")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("named-period subject missing label"))?],
        other => anyhow::bail!("invalid temporal node subject kind '{other}'"),
    };
    let mut key_parts = vec![
        Value::String(timeline_kind.to_string()),
        timeline_key
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null),
        Value::String(subject_kind.to_string()),
    ];
    key_parts.extend(subject_parts);
    Ok(serde_json::to_string(&Value::Array(key_parts))?)
}

pub(crate) fn compute_sha256_fingerprint(value: &Value) -> String {
    let canonical = serde_json::to_vec(value).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(canonical)))
}

pub(crate) fn collect_node_snapshot(conn: &Connection, node_id: &str) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'projectId', project_id,
            'timelineKind', timeline_kind,
            'timelineKey', timeline_key,
            'subjectKind', subject_kind,
            'subjectJson', subject_json,
            'semanticKey', semantic_key,
            'shape', shape,
            'fingerprint', fingerprint,
            'version', version
         ) FROM narrative_temporal_nodes WHERE id = ?1",
        params![node_id],
        |row| row.get(0),
    )?;
    let mut snapshot: Value = serde_json::from_str(&raw)?;
    if let Some(obj) = snapshot.as_object_mut() {
        if let Some(subject_raw) = obj.get("subjectJson").and_then(Value::as_str) {
            let subject: Value = serde_json::from_str(subject_raw).unwrap_or(Value::Null);
            obj.insert("subject".to_string(), subject);
        }
    }
    Ok(snapshot)
}

/// Ensure a Node exists for one temporal subject. Idempotent on the
/// server-computed semantic key: a second `ensure` with the same identity
/// returns the existing row untouched (`created = false`), even if the
/// caller supplied a different `nodeId`. Reusing an existing `nodeId` for a
/// different subject is rejected as a semantic conflict.
pub(crate) fn apply_node_ensure_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &TemporalNodeEnsurePayload,
    now: &str,
) -> anyhow::Result<TemporalNodeTxResult> {
    anyhow::ensure!(
        VALID_TIMELINE_KINDS.contains(&payload.timeline_kind.as_str()),
        "invalid temporal timeline kind '{}'",
        payload.timeline_kind
    );
    anyhow::ensure!(
        VALID_SHAPES.contains(&payload.shape.as_str()),
        "invalid temporal node shape '{}'",
        payload.shape
    );
    let subject_kind = payload
        .subject
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal node subject missing kind"))?
        .to_string();
    let semantic_key = compute_node_semantic_key(
        &payload.timeline_kind,
        payload.timeline_key.as_deref(),
        &payload.subject,
    )?;

    let existing_by_semantic_key: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, version FROM narrative_temporal_nodes
              WHERE project_id = ?1 AND semantic_key = ?2",
            params![project_id, semantic_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    if let Some((existing_id, existing_version)) = existing_by_semantic_key {
        anyhow::ensure!(
            existing_id == payload.node_id,
            "NEX_TEMPORAL_NODE_SEMANTIC_DUPLICATE: subject already bound to node '{existing_id}'"
        );
        let after_snapshot = collect_node_snapshot(conn, &existing_id)?;
        return Ok(TemporalNodeTxResult {
            entity_id: existing_id,
            version: existing_version,
            after_snapshot,
            created: false,
        });
    }

    let id_taken: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_temporal_nodes WHERE id = ?1",
        params![payload.node_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        id_taken == 0,
        "temporal node '{}' already exists with a different subject",
        payload.node_id
    );

    let subject_json = serde_json::to_string(&payload.subject)?;
    let fingerprint = compute_sha256_fingerprint(&json!({
        "timelineKind": payload.timeline_kind,
        "timelineKey": payload.timeline_key,
        "subject": payload.subject,
        "shape": payload.shape,
    }));

    conn.execute(
        "INSERT INTO narrative_temporal_nodes
            (id, project_id, timeline_kind, timeline_key, subject_kind, subject_json,
             semantic_key, shape, fingerprint, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
        params![
            payload.node_id,
            project_id,
            payload.timeline_kind,
            payload.timeline_key,
            subject_kind,
            subject_json,
            semantic_key,
            payload.shape,
            fingerprint,
            now,
        ],
    )?;

    let after_snapshot = collect_node_snapshot(conn, &payload.node_id)?;
    Ok(TemporalNodeTxResult {
        entity_id: payload.node_id.clone(),
        version: 0,
        after_snapshot,
        created: true,
    })
}

pub(crate) fn ensure_node_in_project(
    conn: &Connection,
    project_id: &str,
    node_id: &str,
) -> anyhow::Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_temporal_nodes WHERE id = ?1 AND project_id = ?2",
        params![node_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        found == 1,
        "temporal node '{node_id}' not found in project '{project_id}'"
    );
    Ok(())
}

pub(crate) fn undo_created_node(
    conn: &Connection,
    node_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM narrative_temporal_nodes WHERE id = ?1",
        params![node_id],
        |row| row.get(0),
    )?;
    if live_version != expected_version {
        anyhow::bail!(
            "NEX_COMMIT_TEMPORAL_NODE_EDITED: node '{node_id}' was modified after commit"
        );
    }
    // Constraints store node ids as quoted JSON string values inside
    // `payload_json`; matching the quoted form avoids false positives from
    // one node id being a textual substring of another.
    let referenced: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_temporal_constraints
          WHERE payload_json LIKE '%\"' || ?1 || '\"%'",
        params![node_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        referenced == 0,
        "NEX_UNDO_EXTERNAL_DEPENDENCY: temporal node '{node_id}' is referenced by a constraint"
    );
    let deleted = conn.execute(
        "DELETE FROM narrative_temporal_nodes WHERE id = ?1 AND version = ?2",
        params![node_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_TEMPORAL_NODE_EDITED: node '{node_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn reapply_node_ensure_snapshot(
    conn: &Connection,
    project_id: &str,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal node snapshot missing id"))?;
    let timeline_kind = snapshot
        .get("timelineKind")
        .and_then(Value::as_str)
        .unwrap_or("primary");
    let timeline_key = snapshot.get("timelineKey").and_then(Value::as_str);
    let subject_kind = snapshot
        .get("subjectKind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal node snapshot missing subjectKind"))?;
    let subject_json = snapshot
        .get("subjectJson")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal node snapshot missing subjectJson"))?;
    let semantic_key = snapshot
        .get("semanticKey")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal node snapshot missing semanticKey"))?;
    let shape = snapshot.get("shape").and_then(Value::as_str).unwrap_or("unknown");
    let fingerprint = snapshot
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("");
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("temporal node version overflow during redo"))?;
    conn.execute(
        "INSERT INTO narrative_temporal_nodes
            (id, project_id, timeline_kind, timeline_key, subject_kind, subject_json,
             semantic_key, shape, fingerprint, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            project_id,
            timeline_kind,
            timeline_key,
            subject_kind,
            subject_json,
            semantic_key,
            shape,
            fingerprint,
            replay_version,
            now,
        ],
    )?;
    Ok(replay_version)
}
