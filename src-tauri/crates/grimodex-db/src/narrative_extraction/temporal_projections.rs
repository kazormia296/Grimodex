//! Temporal Constraint Graph (TCG) Projection persistence for narrative apply commits.
//!
//! A Projection records that the (out-of-scope) STN solver derived a value
//! for one target (Scene time / Event time / Scene story-order) from a known
//! constraint set. This module only persists that record; it never solves.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

pub(crate) const OP_KIND_PROJECTION_RECORD: &str = "temporal.projection.record";

const VALID_TARGET_KINDS: &[&str] = &["scene-time", "event-time", "scene-story-order"];
const VALID_STATUSES: &[&str] = &["current", "invalidated", "undone"];

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ProjectionOcc {
    Absent,
    Version { version: i64 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporalProjectionRecordPayload {
    #[serde(default)]
    pub projection_id: Option<String>,
    pub target_kind: String,
    pub target_id: String,
    pub constraint_set_digest: String,
    pub solver_version: String,
    #[serde(default)]
    pub calendar_digest: Option<String>,
    pub projected_value_digest: String,
    pub target_result_version: i64,
    pub application_id: String,
    #[serde(default = "default_status")]
    pub status: String,
    pub occ: ProjectionOcc,
}

fn default_status() -> String {
    "current".to_string()
}

pub(crate) fn parse_projection_record_payload(
    payload: &Value,
) -> anyhow::Result<TemporalProjectionRecordPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid temporal.projection.record payload: {err}"))
}

#[derive(Debug, Clone)]
pub(crate) struct TemporalProjectionTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    pub before_snapshot: Option<Value>,
    pub op_kind: &'static str,
}

pub(crate) fn collect_projection_snapshot(
    conn: &Connection,
    projection_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'projectId', project_id,
            'targetKind', target_kind,
            'targetId', target_id,
            'constraintSetDigest', constraint_set_digest,
            'solverVersion', solver_version,
            'calendarDigest', calendar_digest,
            'projectedValueDigest', projected_value_digest,
            'targetResultVersion', target_result_version,
            'applicationId', application_id,
            'status', status,
            'version', version
         ) FROM narrative_temporal_projections WHERE id = ?1",
        params![projection_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

fn validate(payload: &TemporalProjectionRecordPayload) -> anyhow::Result<()> {
    anyhow::ensure!(
        VALID_TARGET_KINDS.contains(&payload.target_kind.as_str()),
        "invalid temporal projection targetKind '{}'",
        payload.target_kind
    );
    anyhow::ensure!(
        VALID_STATUSES.contains(&payload.status.as_str()),
        "invalid temporal projection status '{}'",
        payload.status
    );
    Ok(())
}

/// Record a Projection with absent|version OCC keyed by
/// `(projectId, targetKind, targetId)`.
pub(crate) fn apply_projection_record_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &TemporalProjectionRecordPayload,
    now: &str,
) -> anyhow::Result<TemporalProjectionTxResult> {
    validate(payload)?;

    let existing: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, version FROM narrative_temporal_projections
              WHERE project_id = ?1 AND target_kind = ?2 AND target_id = ?3",
            params![project_id, payload.target_kind, payload.target_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    match &payload.occ {
        ProjectionOcc::Absent => {
            anyhow::ensure!(
                existing.is_none(),
                "NEX_TEMPORAL_PROJECTION_OCC: projection for target '{}' already exists",
                payload.target_id
            );
            let projection_id = payload
                .projection_id
                .clone()
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            conn.execute(
                "INSERT INTO narrative_temporal_projections
                    (id, project_id, target_kind, target_id, constraint_set_digest,
                     solver_version, calendar_digest, projected_value_digest,
                     target_result_version, application_id, status, version,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?12)",
                params![
                    projection_id,
                    project_id,
                    payload.target_kind,
                    payload.target_id,
                    payload.constraint_set_digest,
                    payload.solver_version,
                    payload.calendar_digest,
                    payload.projected_value_digest,
                    payload.target_result_version,
                    payload.application_id,
                    payload.status,
                    now,
                ],
            )?;
            let after_snapshot = collect_projection_snapshot(conn, &projection_id)?;
            Ok(TemporalProjectionTxResult {
                entity_id: projection_id,
                version: 0,
                after_snapshot,
                before_snapshot: None,
                op_kind: "create",
            })
        }
        ProjectionOcc::Version { version } => {
            let Some((id, live_version)) = existing else {
                anyhow::bail!(
                    "NEX_TEMPORAL_PROJECTION_OCC: projection for target '{}' is absent",
                    payload.target_id
                );
            };
            if live_version != *version {
                anyhow::bail!(
                    "NEX_TEMPORAL_PROJECTION_OCC: projection '{id}' expected version {version}, found {live_version}"
                );
            }
            let before_snapshot = collect_projection_snapshot(conn, &id)?;
            let next_version = live_version
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("projection version overflow"))?;
            let updated = conn.execute(
                "UPDATE narrative_temporal_projections
                    SET constraint_set_digest = ?1,
                        solver_version = ?2,
                        calendar_digest = ?3,
                        projected_value_digest = ?4,
                        target_result_version = ?5,
                        application_id = ?6,
                        status = ?7,
                        version = ?8,
                        updated_at = ?9
                  WHERE id = ?10 AND version = ?11",
                params![
                    payload.constraint_set_digest,
                    payload.solver_version,
                    payload.calendar_digest,
                    payload.projected_value_digest,
                    payload.target_result_version,
                    payload.application_id,
                    payload.status,
                    next_version,
                    now,
                    id,
                    live_version,
                ],
            )?;
            anyhow::ensure!(
                updated == 1,
                "NEX_TEMPORAL_PROJECTION_OCC: projection '{id}' update conflict"
            );
            let after_snapshot = collect_projection_snapshot(conn, &id)?;
            Ok(TemporalProjectionTxResult {
                entity_id: id,
                version: next_version,
                after_snapshot,
                before_snapshot: Some(before_snapshot),
                op_kind: "patch",
            })
        }
    }
}

pub(crate) fn undo_created_projection(
    conn: &Connection,
    projection_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM narrative_temporal_projections WHERE id = ?1",
        params![projection_id],
        |row| row.get(0),
    )?;
    if live_version != expected_version {
        anyhow::bail!(
            "NEX_COMMIT_TEMPORAL_PROJECTION_EDITED: projection '{projection_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM narrative_temporal_projections WHERE id = ?1 AND version = ?2",
        params![projection_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_TEMPORAL_PROJECTION_EDITED: projection '{projection_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn restore_projection_patch(
    conn: &Connection,
    projection_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM narrative_temporal_projections WHERE id = ?1",
        params![projection_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!(
            "NEX_COMMIT_TEMPORAL_PROJECTION_EDITED: projection '{projection_id}' version mismatch"
        );
    }
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("projection version overflow during undo"))?;
    let updated = conn.execute(
        "UPDATE narrative_temporal_projections
            SET constraint_set_digest = ?1,
                solver_version = ?2,
                calendar_digest = ?3,
                projected_value_digest = ?4,
                target_result_version = ?5,
                application_id = ?6,
                status = ?7,
                version = ?8,
                updated_at = ?9
          WHERE id = ?10 AND version = ?11",
        params![
            before_snapshot
                .get("constraintSetDigest")
                .and_then(Value::as_str),
            before_snapshot.get("solverVersion").and_then(Value::as_str),
            before_snapshot
                .get("calendarDigest")
                .and_then(Value::as_str),
            before_snapshot
                .get("projectedValueDigest")
                .and_then(Value::as_str),
            before_snapshot
                .get("targetResultVersion")
                .and_then(Value::as_i64),
            before_snapshot.get("applicationId").and_then(Value::as_str),
            before_snapshot
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("current"),
            next_version,
            now,
            projection_id,
            live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_TEMPORAL_PROJECTION_EDITED: projection '{projection_id}' restore conflict"
    );
    Ok(next_version)
}

pub(crate) fn reapply_projection_create_snapshot(
    conn: &Connection,
    project_id: &str,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("projection snapshot missing id"))?;
    let target_kind = snapshot
        .get("targetKind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("projection snapshot missing targetKind"))?;
    let target_id = snapshot
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("projection snapshot missing targetId"))?;
    let constraint_set_digest = snapshot
        .get("constraintSetDigest")
        .and_then(Value::as_str)
        .unwrap_or("");
    let solver_version = snapshot
        .get("solverVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    let calendar_digest = snapshot.get("calendarDigest").and_then(Value::as_str);
    let projected_value_digest = snapshot
        .get("projectedValueDigest")
        .and_then(Value::as_str)
        .unwrap_or("");
    let target_result_version = snapshot
        .get("targetResultVersion")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let application_id = snapshot
        .get("applicationId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let status = snapshot
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("current");
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("projection version overflow during redo"))?;
    conn.execute(
        "INSERT INTO narrative_temporal_projections
            (id, project_id, target_kind, target_id, constraint_set_digest,
             solver_version, calendar_digest, projected_value_digest,
             target_result_version, application_id, status, version,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            id,
            project_id,
            target_kind,
            target_id,
            constraint_set_digest,
            solver_version,
            calendar_digest,
            projected_value_digest,
            target_result_version,
            application_id,
            status,
            replay_version,
            now,
        ],
    )?;
    Ok(replay_version)
}
