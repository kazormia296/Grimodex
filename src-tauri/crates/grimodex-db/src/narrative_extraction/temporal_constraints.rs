//! Temporal Constraint Graph (TCG) Constraint persistence for narrative apply commits.
//!
//! Mirrors the `TemporalConstraint` union in
//! `src/features/narrative-extraction/temporal/constraints.ts`. The STN
//! solver and its projections are out of scope here; this module only
//! persists constraint edges with OCC and semantic-key deduplication.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::temporal_nodes::{compute_sha256_fingerprint, ensure_node_in_project};

pub(crate) const OP_KIND_CONSTRAINT_CREATE: &str = "temporal.constraint.create";

const VALID_AUTHORITIES: &[&str] = &[
    "user-metadata",
    "user-confirmed",
    "explicit-story-text",
    "existing-domain-relation",
    "deterministic-derived",
    "model-inferred",
    "projection-derived",
];
const VALID_STRICTNESS: &[&str] = &["hard", "soft"];
const VALID_ENDPOINTS: &[&str] = &["start", "end", "point"];
const VALID_OFFSET_UNITS: &[&str] = &["minute", "hour", "day", "week", "month", "year"];
const VALID_OFFSET_ARITHMETIC: &[&str] = &["fixed", "calendar"];
const VALID_INTERVAL_RELATIONS: &[&str] = &[
    "before",
    "before-or-equal",
    "after",
    "after-or-equal",
    "meets",
    "overlaps",
    "during",
    "contains",
    "starts",
    "finishes",
    "equals",
];
const VALID_SYMBOLIC_RELATIONS: &[&str] = &[
    "same-night",
    "next-morning",
    "soon-after",
    "long-before",
    "seasonal",
    "other",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporalEndpointRefPayload {
    pub node_id: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporalOffsetRangePayload {
    pub min: i64,
    pub max: i64,
    pub unit: String,
    pub arithmetic: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporalDurationRangePayload {
    pub min: i64,
    pub max: i64,
    pub unit: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum TemporalConstraintPayload {
    #[serde(rename_all = "camelCase")]
    AbsoluteWindow {
        #[serde(default)]
        constraint_id: Option<String>,
        node_id: String,
        endpoint: String,
        #[serde(default)]
        literal: Option<Value>,
        #[serde(default)]
        resolved: Option<Value>,
        authority: String,
        strictness: String,
        #[serde(default)]
        source_ids: Vec<String>,
        #[serde(default)]
        fingerprint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RelativeOffset {
        #[serde(default)]
        constraint_id: Option<String>,
        left: TemporalEndpointRefPayload,
        right: TemporalEndpointRefPayload,
        offset: TemporalOffsetRangePayload,
        authority: String,
        strictness: String,
        #[serde(default)]
        source_ids: Vec<String>,
        #[serde(default)]
        fingerprint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    IntervalRelation {
        #[serde(default)]
        constraint_id: Option<String>,
        left_node_id: String,
        relation: String,
        right_node_id: String,
        authority: String,
        strictness: String,
        #[serde(default)]
        source_ids: Vec<String>,
        #[serde(default)]
        fingerprint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Duration {
        #[serde(default)]
        constraint_id: Option<String>,
        node_id: String,
        duration: TemporalDurationRangePayload,
        authority: String,
        strictness: String,
        #[serde(default)]
        source_ids: Vec<String>,
        #[serde(default)]
        fingerprint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Symbolic {
        #[serde(default)]
        constraint_id: Option<String>,
        node_id: String,
        relation: String,
        #[serde(default)]
        anchor_node_id: Option<String>,
        label: String,
        authority: String,
        strictness: String,
        #[serde(default)]
        source_ids: Vec<String>,
        #[serde(default)]
        fingerprint: Option<String>,
    },
}

pub(crate) fn parse_constraint_create_payload(
    payload: &Value,
) -> anyhow::Result<TemporalConstraintPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid temporal.constraint.create payload: {err}"))
}

impl TemporalConstraintPayload {
    pub(crate) fn kind_str(&self) -> &'static str {
        match self {
            Self::AbsoluteWindow { .. } => "absolute-window",
            Self::RelativeOffset { .. } => "relative-offset",
            Self::IntervalRelation { .. } => "interval-relation",
            Self::Duration { .. } => "duration",
            Self::Symbolic { .. } => "symbolic",
        }
    }

    fn constraint_id(&self) -> Option<&str> {
        match self {
            Self::AbsoluteWindow { constraint_id, .. }
            | Self::RelativeOffset { constraint_id, .. }
            | Self::IntervalRelation { constraint_id, .. }
            | Self::Duration { constraint_id, .. }
            | Self::Symbolic { constraint_id, .. } => constraint_id.as_deref(),
        }
    }

    fn authority(&self) -> &str {
        match self {
            Self::AbsoluteWindow { authority, .. }
            | Self::RelativeOffset { authority, .. }
            | Self::IntervalRelation { authority, .. }
            | Self::Duration { authority, .. }
            | Self::Symbolic { authority, .. } => authority,
        }
    }

    fn strictness(&self) -> &str {
        match self {
            Self::AbsoluteWindow { strictness, .. }
            | Self::RelativeOffset { strictness, .. }
            | Self::IntervalRelation { strictness, .. }
            | Self::Duration { strictness, .. }
            | Self::Symbolic { strictness, .. } => strictness,
        }
    }

    fn source_ids(&self) -> &[String] {
        match self {
            Self::AbsoluteWindow { source_ids, .. }
            | Self::RelativeOffset { source_ids, .. }
            | Self::IntervalRelation { source_ids, .. }
            | Self::Duration { source_ids, .. }
            | Self::Symbolic { source_ids, .. } => source_ids,
        }
    }

    fn fingerprint(&self) -> Option<&str> {
        match self {
            Self::AbsoluteWindow { fingerprint, .. }
            | Self::RelativeOffset { fingerprint, .. }
            | Self::IntervalRelation { fingerprint, .. }
            | Self::Duration { fingerprint, .. }
            | Self::Symbolic { fingerprint, .. } => fingerprint.as_deref(),
        }
    }

    /// Every node id this constraint references, required to exist.
    fn referenced_node_ids(&self) -> Vec<&str> {
        match self {
            Self::AbsoluteWindow { node_id, .. } | Self::Duration { node_id, .. } => {
                vec![node_id.as_str()]
            }
            Self::RelativeOffset { left, right, .. } => {
                vec![left.node_id.as_str(), right.node_id.as_str()]
            }
            Self::IntervalRelation {
                left_node_id,
                right_node_id,
                ..
            } => vec![left_node_id.as_str(), right_node_id.as_str()],
            Self::Symbolic {
                node_id,
                anchor_node_id,
                ..
            } => {
                let mut ids = vec![node_id.as_str()];
                if let Some(anchor) = anchor_node_id.as_deref() {
                    ids.push(anchor);
                }
                ids
            }
        }
    }

    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            VALID_AUTHORITIES.contains(&self.authority()),
            "invalid temporal constraint authority '{}'",
            self.authority()
        );
        anyhow::ensure!(
            VALID_STRICTNESS.contains(&self.strictness()),
            "invalid temporal constraint strictness '{}'",
            self.strictness()
        );
        match self {
            Self::AbsoluteWindow {
                endpoint,
                literal,
                resolved,
                ..
            } => {
                anyhow::ensure!(
                    VALID_ENDPOINTS.contains(&endpoint.as_str()),
                    "invalid temporal endpoint '{endpoint}'"
                );
                anyhow::ensure!(
                    literal.is_some() || resolved.is_some(),
                    "absolute-window constraint needs a literal or a resolved value"
                );
            }
            Self::RelativeOffset { left, right, offset, .. } => {
                anyhow::ensure!(
                    VALID_ENDPOINTS.contains(&left.endpoint.as_str())
                        && VALID_ENDPOINTS.contains(&right.endpoint.as_str()),
                    "invalid temporal endpoint in relative-offset constraint"
                );
                anyhow::ensure!(
                    VALID_OFFSET_UNITS.contains(&offset.unit.as_str()),
                    "invalid relative-offset unit '{}'",
                    offset.unit
                );
                anyhow::ensure!(
                    VALID_OFFSET_ARITHMETIC.contains(&offset.arithmetic.as_str()),
                    "invalid relative-offset arithmetic '{}'",
                    offset.arithmetic
                );
                anyhow::ensure!(offset.min <= offset.max, "relative-offset range is inverted");
            }
            Self::IntervalRelation { relation, .. } => {
                anyhow::ensure!(
                    VALID_INTERVAL_RELATIONS.contains(&relation.as_str()),
                    "invalid interval relation '{relation}'"
                );
            }
            Self::Duration { duration, .. } => {
                anyhow::ensure!(
                    VALID_OFFSET_UNITS.contains(&duration.unit.as_str()),
                    "invalid duration unit '{}'",
                    duration.unit
                );
                anyhow::ensure!(
                    duration.min >= 0 && duration.min <= duration.max,
                    "duration range is invalid"
                );
            }
            Self::Symbolic { relation, label, .. } => {
                anyhow::ensure!(
                    VALID_SYMBOLIC_RELATIONS.contains(&relation.as_str()),
                    "invalid symbolic relation '{relation}'"
                );
                anyhow::ensure!(!label.trim().is_empty(), "symbolic constraint label is empty");
            }
        }
        Ok(())
    }

    /// Deterministic dedup key discriminated by kind + identity fields, so
    /// two extraction passes proposing the same edge collapse to one row.
    fn semantic_key(&self) -> String {
        match self {
            Self::AbsoluteWindow { node_id, endpoint, .. } => {
                format!("absolute-window\t{node_id}\t{endpoint}")
            }
            Self::RelativeOffset { left, right, .. } => format!(
                "relative-offset\t{}\t{}\t{}\t{}",
                left.node_id, left.endpoint, right.node_id, right.endpoint
            ),
            Self::IntervalRelation {
                left_node_id,
                relation,
                right_node_id,
                ..
            } => format!("interval-relation\t{left_node_id}\t{relation}\t{right_node_id}"),
            Self::Duration { node_id, .. } => format!("duration\t{node_id}"),
            Self::Symbolic {
                node_id,
                relation,
                anchor_node_id,
                label,
                ..
            } => format!(
                "symbolic\t{node_id}\t{relation}\t{}\t{label}",
                anchor_node_id.as_deref().unwrap_or("")
            ),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TemporalConstraintTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
}

pub(crate) fn collect_constraint_snapshot(
    conn: &Connection,
    constraint_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'projectId', project_id,
            'kind', kind,
            'authority', authority,
            'strictness', strictness,
            'semanticKey', semantic_key,
            'sourceIds', source_ids_json,
            'fingerprint', fingerprint,
            'payload', payload_json,
            'version', version
         ) FROM narrative_temporal_constraints WHERE id = ?1",
        params![constraint_id],
        |row| row.get(0),
    )?;
    let mut snapshot: Value = serde_json::from_str(&raw)?;
    if let Some(obj) = snapshot.as_object_mut() {
        if let Some(source_ids_raw) = obj.get("sourceIds").and_then(Value::as_str) {
            let source_ids: Value = serde_json::from_str(source_ids_raw).unwrap_or(json!([]));
            obj.insert("sourceIds".to_string(), source_ids);
        }
        if let Some(payload_raw) = obj.get("payload").and_then(Value::as_str) {
            let payload: Value = serde_json::from_str(payload_raw).unwrap_or(Value::Null);
            obj.insert("payload".to_string(), payload);
        }
    }
    Ok(snapshot)
}

/// Create a Constraint edge. Every referenced node must already exist in the
/// project (created earlier in the same commit, or pre-existing). Rejects a
/// semantic-key duplicate rather than silently deduplicating, so the caller
/// can decide whether to retry with `constraint.create` against the existing
/// edge or drop the proposal.
pub(crate) fn apply_constraint_create_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &TemporalConstraintPayload,
    now: &str,
) -> anyhow::Result<TemporalConstraintTxResult> {
    payload.validate()?;
    for node_id in payload.referenced_node_ids() {
        ensure_node_in_project(conn, project_id, node_id)?;
    }

    let semantic_key = payload.semantic_key();
    let duplicate: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_temporal_constraints
          WHERE project_id = ?1 AND semantic_key = ?2",
        params![project_id, semantic_key],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        duplicate == 0,
        "NEX_TEMPORAL_CONSTRAINT_SEMANTIC_DUPLICATE: constraint already exists for this edge"
    );

    let constraint_id = payload
        .constraint_id()
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_temporal_constraints WHERE id = ?1",
        params![constraint_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        exists == 0,
        "temporal constraint '{constraint_id}' already exists"
    );

    let payload_value = serde_json::to_value(payload)?;
    let payload_json = serde_json::to_string(&payload_value)?;
    let source_ids_json = serde_json::to_string(payload.source_ids())?;
    let fingerprint = payload
        .fingerprint()
        .map(str::to_string)
        .unwrap_or_else(|| compute_sha256_fingerprint(&payload_value));

    conn.execute(
        "INSERT INTO narrative_temporal_constraints
            (id, project_id, kind, authority, strictness, semantic_key,
             source_ids_json, fingerprint, payload_json, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
        params![
            constraint_id,
            project_id,
            payload.kind_str(),
            payload.authority(),
            payload.strictness(),
            semantic_key,
            source_ids_json,
            fingerprint,
            payload_json,
            now,
        ],
    )?;

    let after_snapshot = collect_constraint_snapshot(conn, &constraint_id)?;
    Ok(TemporalConstraintTxResult {
        entity_id: constraint_id,
        version: 0,
        after_snapshot,
    })
}

pub(crate) fn undo_created_constraint(
    conn: &Connection,
    constraint_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM narrative_temporal_constraints WHERE id = ?1",
        params![constraint_id],
        |row| row.get(0),
    )?;
    if live_version != expected_version {
        anyhow::bail!(
            "NEX_COMMIT_TEMPORAL_CONSTRAINT_EDITED: constraint '{constraint_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM narrative_temporal_constraints WHERE id = ?1 AND version = ?2",
        params![constraint_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_TEMPORAL_CONSTRAINT_EDITED: constraint '{constraint_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn reapply_constraint_create_snapshot(
    conn: &Connection,
    project_id: &str,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal constraint snapshot missing id"))?;
    let kind = snapshot
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal constraint snapshot missing kind"))?;
    let authority = snapshot
        .get("authority")
        .and_then(Value::as_str)
        .unwrap_or("model-inferred");
    let strictness = snapshot
        .get("strictness")
        .and_then(Value::as_str)
        .unwrap_or("soft");
    let semantic_key = snapshot
        .get("semanticKey")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("temporal constraint snapshot missing semanticKey"))?;
    let source_ids = snapshot.get("sourceIds").cloned().unwrap_or(json!([]));
    let source_ids_json = serde_json::to_string(&source_ids)?;
    let fingerprint = snapshot
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("");
    let payload = snapshot.get("payload").cloned().unwrap_or(Value::Null);
    let payload_json = serde_json::to_string(&payload)?;
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("temporal constraint version overflow during redo"))?;
    conn.execute(
        "INSERT INTO narrative_temporal_constraints
            (id, project_id, kind, authority, strictness, semantic_key,
             source_ids_json, fingerprint, payload_json, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            project_id,
            kind,
            authority,
            strictness,
            semantic_key,
            source_ids_json,
            fingerprint,
            payload_json,
            replay_version,
            now,
        ],
    )?;
    Ok(replay_version)
}
