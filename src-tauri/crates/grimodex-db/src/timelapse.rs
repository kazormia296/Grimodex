//! Native-owned timelapse genesis baseline persistence.
//!
//! The renderer supplies only entity identity. Domain, entity type, and the
//! baseline payload are projected from trusted workspace tables while one
//! `BEGIN IMMEDIATE` transaction owns both the eligibility probes and inserts.

use std::collections::{HashMap, HashSet};

use anyhow::Context;
use rusqlite::{
    params, params_from_iter, types::Value, Connection, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use super::Database;

const MAX_PROJECT_ID_LENGTH: usize = 512;
const MAX_ENTITY_ID_LENGTH: usize = 512;
const MAX_ENTITY_IDS: usize = 64;
const MAX_BATCH_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_LAYOUT_SNAPSHOT_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
// Keep every bulk statement below SQLite's conservative 999-variable limit.
// Restore can contain more rows than one statement can carry, so the helper
// chunks by target while still avoiding one SELECT + INSERT pair per target.
const MAX_BODY_SNAPSHOT_BULK_TARGETS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TimelapseGenesisBaselineKind {
    Scene,
    Codex,
    Snippet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelapseDocStepCoverageProof {
    pub event_uid: String,
    pub session_id: String,
    pub content_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct TimelapseDocStepCoveragePayload {
    result_content_digest: String,
}

#[allow(dead_code)]
fn timelapse_content_digest(content: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(content.as_bytes())))
}

#[allow(dead_code)]
pub(crate) struct TimelapseDocStepCoverageScope<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub domain: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
}

/// Decide whether a renderer body update still needs an atomic full snapshot.
/// A durable recorder coverage event is the only proof that a complete prefix
/// of `doc.step` events already represents the supplied body. Missing or stale
/// renderer proof falls back to the snapshot; non-renderer callers may not
/// suppress it at all.
#[allow(dead_code)]
pub(crate) fn should_append_timelapse_body_snapshot(
    conn: &Connection,
    scope: TimelapseDocStepCoverageScope<'_>,
    content: Option<&str>,
    proof: Option<&TimelapseDocStepCoverageProof>,
    authenticated_renderer_context: bool,
) -> anyhow::Result<bool> {
    let Some(content) = content else {
        return Ok(false);
    };
    let Some(proof) = proof else {
        return Ok(true);
    };
    if !authenticated_renderer_context {
        return Ok(true);
    }
    let expected_digest = timelapse_content_digest(content);
    let trusted_content = match (scope.domain, scope.entity_type) {
        ("codex", "codex_entry") => conn
            .query_row(
                "SELECT content FROM codex_entries WHERE project_id = ?1 AND id = ?2",
                params![scope.project_id, scope.entity_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?,
        ("snippet", "snippet") => conn
            .query_row(
                "SELECT content FROM snippets WHERE project_id = ?1 AND id = ?2",
                params![scope.project_id, scope.entity_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?,
        ("editor", "scene") => conn
            .query_row(
                "SELECT content FROM tree_nodes
                  WHERE project_id = ?1 AND id = ?2 AND node_type = 'scene'",
                params![scope.project_id, scope.entity_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?,
        _ => None,
    };
    if trusted_content
        .as_deref()
        .map(timelapse_content_digest)
        .as_deref()
        != Some(expected_digest.as_str())
    {
        return Ok(true);
    }
    if proof.event_uid.trim().is_empty()
        || proof.session_id != scope.session_id
        || proof.content_digest != expected_digest
    {
        return Ok(true);
    }
    let reset_sequence = load_timelapse_reset_sequence(conn, scope.project_id)?;
    let mut coverage_statement = conn.prepare(
        "SELECT sequence, payload
               FROM change_events coverage
              WHERE coverage.project_id = ?1
                AND coverage.session_id = ?2
                AND coverage.domain = 'timelapse-internal'
                AND coverage.op_type = 'doc.step.coverage'
                AND coverage.entity_type = ?3
                AND coverage.entity_id = ?4
                AND coverage.event_uid = ?5
                AND coverage.sequence BETWEEN 1 AND ?6
                AND coverage.timestamp BETWEEN 0 AND ?6
                AND coverage.sequence > ?8
                AND EXISTS (
                    SELECT 1 FROM change_events step
                     WHERE step.project_id = coverage.project_id
                       AND step.domain = ?7
                       AND step.op_type = 'doc.step'
                       AND step.entity_type = coverage.entity_type
                       AND step.entity_id = coverage.entity_id
                       AND step.session_id = coverage.session_id
                       AND step.sequence < coverage.sequence
                       AND step.sequence > ?8
                       AND step.sequence > MAX(
                           COALESCE((
                               SELECT MAX(previous.sequence)
                                 FROM change_events previous
                                WHERE previous.project_id = coverage.project_id
                                  AND previous.domain = 'timelapse-internal'
                                  AND previous.op_type = 'doc.step.coverage'
                                  AND previous.entity_type = coverage.entity_type
                                  AND previous.entity_id = coverage.entity_id
                                  AND previous.sequence < coverage.sequence
                                  AND previous.sequence > ?8
                           ), 0),
                           COALESCE((
                               SELECT MAX(snapshot.anchor_sequence)
                                 FROM state_snapshots snapshot
                                WHERE snapshot.project_id = coverage.project_id
                                  AND snapshot.domain = ?7
                                  AND (
                                      snapshot.entity_type = coverage.entity_type
                                      OR snapshot.entity_type IS NULL
                                  )
                                  AND snapshot.entity_id = coverage.entity_id
                                  AND snapshot.anchor_sequence < coverage.sequence
                                  AND snapshot.anchor_sequence >= ?8
                           ), 0)
                       )
                )
                AND NOT EXISTS (
                    SELECT 1 FROM change_events later
                     WHERE later.project_id = coverage.project_id
                       AND later.domain = ?7
                       AND later.entity_type = coverage.entity_type
                       AND later.entity_id = coverage.entity_id
                       AND later.op_type = 'doc.step'
                       AND later.sequence > coverage.sequence
                )
                AND NOT EXISTS (
                    SELECT 1 FROM change_events newer_coverage
                     WHERE newer_coverage.project_id = coverage.project_id
                       AND newer_coverage.domain = 'timelapse-internal'
                       AND newer_coverage.op_type = 'doc.step.coverage'
                       AND newer_coverage.entity_type = coverage.entity_type
                       AND newer_coverage.entity_id = coverage.entity_id
                       AND newer_coverage.sequence > coverage.sequence
                )",
    )?;
    let mut coverage_rows = coverage_statement.query(params![
        scope.project_id,
        proof.session_id,
        scope.entity_type,
        scope.entity_id,
        proof.event_uid,
        MAX_SAFE_INTEGER,
        scope.domain,
        reset_sequence,
    ])?;
    let coverage = match coverage_rows.next()? {
        Some(row) => Some((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        None => None,
    };
    // `event_uid` predates a uniqueness constraint in legacy databases. A
    // proof that resolves to more than one durable coverage event is
    // ambiguous, so fail closed instead of letting `query_row` turn malformed
    // evidence into a writer error.
    if coverage.is_some() && coverage_rows.next()?.is_some() {
        return Ok(true);
    }
    let Some((coverage_sequence, payload)) = coverage else {
        return Ok(true);
    };
    // A snapshot at or after the coverage event is a newer authoritative body
    // boundary, even when the body table currently contains the same bytes as
    // the stale renderer request (the request may have updated it earlier in
    // this transaction).  In that case the old proof cannot suppress a fresh
    // snapshot.  Legacy rows with a NULL entity_type are logical matches too.
    let has_newer_snapshot = conn.query_row(
        "SELECT EXISTS (
                SELECT 1
                  FROM state_snapshots
                 WHERE project_id = ?1
                   AND domain = ?2
                   AND (entity_type = ?3 OR entity_type IS NULL)
                   AND entity_id = ?4
                   AND anchor_sequence >= ?5
             )",
        params![
            scope.project_id,
            scope.domain,
            scope.entity_type,
            scope.entity_id,
            coverage_sequence,
        ],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if has_newer_snapshot {
        return Ok(true);
    }
    let payload: TimelapseDocStepCoveragePayload = match serde_json::from_str(&payload) {
        Ok(payload) => payload,
        Err(_) => return Ok(true),
    };
    Ok(payload.result_content_digest != expected_digest)
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TimelapseBodySnapshotTarget {
    kind: TimelapseGenesisBaselineKind,
    entity_id: String,
}

impl TimelapseBodySnapshotTarget {
    pub fn scene(entity_id: impl Into<String>) -> Self {
        Self {
            kind: TimelapseGenesisBaselineKind::Scene,
            entity_id: entity_id.into(),
        }
    }

    pub fn codex(entity_id: impl Into<String>) -> Self {
        Self {
            kind: TimelapseGenesisBaselineKind::Codex,
            entity_id: entity_id.into(),
        }
    }

    pub fn snippet(entity_id: impl Into<String>) -> Self {
        Self {
            kind: TimelapseGenesisBaselineKind::Snippet,
            entity_id: entity_id.into(),
        }
    }
}

impl TimelapseGenesisBaselineKind {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "scene" => Ok(Self::Scene),
            "codex" => Ok(Self::Codex),
            "snippet" => Ok(Self::Snippet),
            _ => anyhow::bail!(
                "TIMELAPSE_GENESIS_BASELINE_INVALID_KIND: kind must be scene, codex, or snippet"
            ),
        }
    }

    fn domain(self) -> &'static str {
        match self {
            Self::Scene => "editor",
            Self::Codex => "codex",
            Self::Snippet => "snippet",
        }
    }

    fn entity_type(self) -> &'static str {
        match self {
            Self::Scene => "scene",
            Self::Codex => "codex_entry",
            Self::Snippet => "snippet",
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Scene => "tree_nodes",
            Self::Codex => "codex_entries",
            Self::Snippet => "snippets",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelapseGenesisBaselineAppendSummary {
    pub inserted_count: usize,
    pub skipped_existing_baseline_count: usize,
    pub skipped_existing_body_step_count: usize,
}

/// Summary returned by the renderer-facing body rebaseline writer. The
/// renderer supplies entity identities only; the native transaction resolves
/// the body, canonical tail, and timestamp from the trusted database.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelapseBodyBaselineAppendSummary {
    pub inserted_count: usize,
    pub skipped_existing_count: usize,
    pub anchor_sequence: i64,
    pub anchor_timestamp: i64,
}

/// Summary returned by the renderer-facing history purge writer.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelapseHistoryPurgeSummary {
    pub deleted_event_count: usize,
    pub deleted_snapshot_count: usize,
}

/// Summary returned by the fixed-scope layout snapshot writer.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelapseLayoutSnapshotAppendSummary {
    pub inserted: bool,
    pub anchor_sequence: i64,
    pub anchor_timestamp: i64,
}

/// Summary returned when the Native timelapse flag is changed under an exact
/// workspace binding. The renderer never writes this project setting through
/// the generic Drizzle writer.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelapseEnabledSetSummary {
    pub enabled: bool,
}

fn validate_request(
    project_id: &str,
    entity_ids: &[String],
    anchor_timestamp: i64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !project_id.is_empty()
            && project_id.trim() == project_id
            && project_id.chars().count() <= MAX_PROJECT_ID_LENGTH,
        "TIMELAPSE_GENESIS_BASELINE_INVALID_PROJECT: projectId must be exact, non-empty, and at most {MAX_PROJECT_ID_LENGTH} characters"
    );
    anyhow::ensure!(
        !entity_ids.is_empty() && entity_ids.len() <= MAX_ENTITY_IDS,
        "TIMELAPSE_GENESIS_BASELINE_INVALID_ENTITIES: entityIds must contain 1..={MAX_ENTITY_IDS} items"
    );
    anyhow::ensure!(
        (0..=MAX_SAFE_INTEGER).contains(&anchor_timestamp),
        "TIMELAPSE_GENESIS_BASELINE_INVALID_TIMESTAMP: anchorTimestamp must be a non-negative safe integer"
    );

    let mut unique = HashSet::with_capacity(entity_ids.len());
    for entity_id in entity_ids {
        anyhow::ensure!(
            !entity_id.is_empty()
                && entity_id.trim() == entity_id
                && entity_id.chars().count() <= MAX_ENTITY_ID_LENGTH,
            "TIMELAPSE_GENESIS_BASELINE_INVALID_ENTITY: entityIds must be exact, non-empty, and at most {MAX_ENTITY_ID_LENGTH} characters"
        );
        anyhow::ensure!(
            unique.insert(entity_id.as_str()),
            "TIMELAPSE_GENESIS_BASELINE_DUPLICATE_ENTITY: entityIds must be unique"
        );
    }
    Ok(())
}

fn validate_body_snapshot_targets(
    project_id: &str,
    targets: &[TimelapseBodySnapshotTarget],
    expected_anchor_sequence: Option<i64>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !project_id.is_empty()
            && project_id.trim() == project_id
            && project_id.chars().count() <= MAX_PROJECT_ID_LENGTH,
        "TIMELAPSE_BODY_SNAPSHOT_INVALID_PROJECT: projectId must be exact, non-empty, and at most {MAX_PROJECT_ID_LENGTH} characters"
    );
    anyhow::ensure!(
        !targets.is_empty() && targets.len() <= MAX_ENTITY_IDS,
        "TIMELAPSE_BODY_SNAPSHOT_INVALID_TARGETS: targets must contain 1..={MAX_ENTITY_IDS} items"
    );
    if let Some(anchor_sequence) = expected_anchor_sequence {
        anyhow::ensure!(
            (0..=MAX_SAFE_INTEGER).contains(&anchor_sequence),
            "TIMELAPSE_BODY_SNAPSHOT_INVALID_SEQUENCE: expectedAnchorSequence must be a non-negative safe integer"
        );
    }
    let mut unique = HashSet::with_capacity(targets.len());
    for target in targets {
        anyhow::ensure!(
            !target.entity_id.is_empty()
                && target.entity_id.trim() == target.entity_id
                && target.entity_id.chars().count() <= MAX_ENTITY_ID_LENGTH,
            "TIMELAPSE_BODY_SNAPSHOT_INVALID_ENTITY: target entityId must be exact, non-empty, and at most {MAX_ENTITY_ID_LENGTH} characters"
        );
        anyhow::ensure!(
            unique.insert(target),
            "TIMELAPSE_BODY_SNAPSHOT_DUPLICATE_TARGET: targets must be unique"
        );
    }
    Ok(())
}

fn validate_layout_snapshot_payload(payload: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        payload.len() <= MAX_LAYOUT_SNAPSHOT_PAYLOAD_BYTES,
        "TIMELAPSE_LAYOUT_SNAPSHOT_TOO_LARGE: payload exceeds {MAX_LAYOUT_SNAPSHOT_PAYLOAD_BYTES} bytes"
    );
    let value: JsonValue = serde_json::from_str(payload)
        .context("TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: payload must be valid JSON")?;
    let object = value.as_object().ok_or_else(|| {
        anyhow::anyhow!("TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: payload must be a JSON object")
    })?;
    anyhow::ensure!(
        object.contains_key("layout"),
        "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: payload.layout is required"
    );
    anyhow::ensure!(
        object.get("layout").is_some_and(JsonValue::is_object),
        "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: payload.layout must be an object"
    );
    for key in object.keys() {
        anyhow::ensure!(
            matches!(
                key.as_str(),
                "layout" | "activePresetId" | "hiddenStripePanels"
            ),
            "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: unsupported payload field '{key}'"
        );
    }
    if let Some(active_preset_id) = object.get("activePresetId") {
        anyhow::ensure!(
            active_preset_id.is_null() || active_preset_id.is_string(),
            "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: activePresetId must be a string or null"
        );
    }
    if let Some(hidden_panels) = object.get("hiddenStripePanels") {
        let panels = hidden_panels.as_array().ok_or_else(|| {
            anyhow::anyhow!(
                "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: hiddenStripePanels must be an array"
            )
        })?;
        anyhow::ensure!(
            panels.len() <= 128,
            "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: hiddenStripePanels is too large"
        );
        for panel in panels {
            anyhow::ensure!(
                panel.is_string(),
                "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PAYLOAD: hiddenStripePanels items must be strings"
            );
        }
    }
    Ok(())
}

fn validate_projected_batch_size(owned_content: &[String]) -> anyhow::Result<()> {
    if owned_content.len() <= 1 {
        return Ok(());
    }
    let aggregate_bytes = owned_content.iter().try_fold(0usize, |total, content| {
        total
            .checked_add(content.len())
            .context("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE: payload byte count overflow")
    })?;
    anyhow::ensure!(
        aggregate_bytes <= MAX_BATCH_PAYLOAD_BYTES,
        "TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE: multi-entity payload is {} bytes; maximum is {} bytes",
        aggregate_bytes,
        MAX_BATCH_PAYLOAD_BYTES
    );
    Ok(())
}

fn timelapse_is_explicitly_disabled(conn: &Connection, project_id: &str) -> anyhow::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM project_settings
              WHERE project_id = ?1
                AND key = 'timelapse.enabled'
                AND value = 'false'",
            [project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

/// Read the Native-owned reset epoch with strict, fail-closed parsing.
///
/// A reset retains the immutable canonical `change_events` chain and advances
/// this marker to its current tail.  Every timelapse eligibility/read path
/// must use the same marker; treating malformed state as zero would resurrect
/// history that the caller explicitly purged.
fn load_timelapse_reset_sequence(conn: &Connection, project_id: &str) -> anyhow::Result<i64> {
    let value = conn
        .query_row(
            "SELECT value FROM project_settings
              WHERE project_id = ?1
                AND key = 'timelapse.resetSequence'",
            [project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let sequence = match value {
        None => 0,
        Some(value) => value.parse::<i64>().map_err(|_| {
            anyhow::anyhow!(
                "TIMELAPSE_HISTORY_INVALID_RESET_SEQUENCE: stored reset sequence is not an integer"
            )
        })?,
    };
    anyhow::ensure!(
        (0..=MAX_SAFE_INTEGER).contains(&sequence),
        "TIMELAPSE_HISTORY_INVALID_RESET_SEQUENCE: stored reset sequence is outside the safe integer range"
    );
    Ok(sequence)
}

fn load_body_snapshot_scope_batch(
    conn: &Connection,
    project_id: &str,
    kind: TimelapseGenesisBaselineKind,
    entity_ids: &[String],
) -> anyhow::Result<HashSet<String>> {
    let scene_predicate = match kind {
        TimelapseGenesisBaselineKind::Scene => " AND node_type = 'scene'",
        TimelapseGenesisBaselineKind::Codex | TimelapseGenesisBaselineKind::Snippet => "",
    };
    let sql = format!(
        "SELECT id
           FROM {}
          WHERE project_id = ?
            AND id IN ({}){}",
        kind.table(),
        in_placeholders(entity_ids.len()),
        scene_predicate
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(std::iter::once(project_id).chain(entity_ids.iter().map(String::as_str))),
        |row| row.get::<_, String>(0),
    )?;
    Ok(rows.collect::<std::result::Result<HashSet<_>, _>>()?)
}

fn append_body_snapshot_bulk_chunk(
    conn: &Connection,
    project_id: &str,
    kind: TimelapseGenesisBaselineKind,
    anchor_sequence: i64,
    anchor_timestamp: i64,
    entity_ids: &[String],
) -> anyhow::Result<usize> {
    let id_values = (1..=entity_ids.len())
        .map(|index| format!("(?{index})"))
        .collect::<Vec<_>>()
        .join(", ");
    let project_parameter = entity_ids.len() + 1;
    let domain_parameter = entity_ids.len() + 2;
    let entity_type_parameter = entity_ids.len() + 3;
    let sequence_parameter = entity_ids.len() + 4;
    let timestamp_parameter = entity_ids.len() + 5;
    let scene_predicate = match kind {
        TimelapseGenesisBaselineKind::Scene => " AND source.node_type = 'scene'",
        TimelapseGenesisBaselineKind::Codex | TimelapseGenesisBaselineKind::Snippet => "",
    };
    let sql = format!(
        "WITH requested(entity_id) AS (VALUES {id_values})
         INSERT INTO state_snapshots
             (project_id, domain, entity_type, entity_id,
              anchor_sequence, anchor_timestamp, payload, encoding, created_at)
         SELECT ?{project_parameter}, ?{domain_parameter}, ?{entity_type_parameter},
                requested.entity_id, ?{sequence_parameter}, ?{timestamp_parameter},
                source.content, 'json', ?{timestamp_parameter}
           FROM requested
           JOIN {table} source
             ON source.id = requested.entity_id
            AND source.project_id = ?{project_parameter}{scene_predicate}
          WHERE NOT EXISTS (
                SELECT 1
                  FROM state_snapshots existing
                 WHERE existing.project_id = ?{project_parameter}
                   AND existing.domain = ?{domain_parameter}
                   AND (existing.entity_type = ?{entity_type_parameter}
                        OR existing.entity_type IS NULL)
                   AND existing.entity_id = requested.entity_id
                   AND existing.anchor_sequence = ?{sequence_parameter}
          )",
        table = kind.table(),
    );
    let mut values = entity_ids
        .iter()
        .cloned()
        .map(Value::from)
        .collect::<Vec<_>>();
    values.extend([
        Value::from(project_id.to_owned()),
        Value::from(kind.domain().to_owned()),
        Value::from(kind.entity_type().to_owned()),
        Value::from(anchor_sequence),
        Value::from(anchor_timestamp),
    ]);
    Ok(conn.execute(&sql, params_from_iter(values))?)
}

/// Append trusted full-body snapshots at a canonical event boundary already
/// owned by the caller's transaction. This is used only for whole-body writes
/// that have no replayable `doc.step` representation.
pub(crate) fn append_timelapse_body_snapshots_in_tx(
    conn: &Connection,
    project_id: &str,
    anchor_sequence: i64,
    anchor_timestamp: i64,
    targets: &[TimelapseBodySnapshotTarget],
) -> anyhow::Result<usize> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "TIMELAPSE_BODY_SNAPSHOT_TRANSACTION_REQUIRED: body snapshots require a caller-owned transaction"
    );
    if targets.is_empty() || timelapse_is_explicitly_disabled(conn, project_id)? {
        return Ok(0);
    }
    anyhow::ensure!(
        (1..=MAX_SAFE_INTEGER).contains(&anchor_sequence),
        "TIMELAPSE_BODY_SNAPSHOT_INVALID_SEQUENCE: anchorSequence must be a positive safe integer"
    );
    anyhow::ensure!(
        (0..=MAX_SAFE_INTEGER).contains(&anchor_timestamp),
        "TIMELAPSE_BODY_SNAPSHOT_INVALID_TIMESTAMP: anchorTimestamp must be a non-negative safe integer"
    );
    let canonical_timestamp = conn
        .query_row(
            "SELECT timestamp FROM change_events
              WHERE project_id = ?1 AND sequence = ?2
                AND sequence = (SELECT MAX(sequence) FROM change_events WHERE project_id = ?1)",
            params![project_id, anchor_sequence],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    anyhow::ensure!(
        canonical_timestamp == Some(anchor_timestamp),
        "TIMELAPSE_BODY_SNAPSHOT_ANCHOR_MISMATCH: anchor must match the project's canonical tail"
    );

    let mut unique_targets = HashSet::with_capacity(targets.len());
    let mut targets_by_kind = HashMap::<TimelapseGenesisBaselineKind, Vec<String>>::new();
    for target in targets {
        if unique_targets.insert(target) {
            targets_by_kind
                .entry(target.kind)
                .or_default()
                .push(target.entity_id.clone());
        }
    }

    // Resolve ownership for every target before writing any snapshot. This
    // preserves the old fail-closed behavior while reducing restore reads to
    // one bounded lookup per kind/chunk instead of one lookup per target.
    for kind in [
        TimelapseGenesisBaselineKind::Scene,
        TimelapseGenesisBaselineKind::Codex,
        TimelapseGenesisBaselineKind::Snippet,
    ] {
        let Some(entity_ids) = targets_by_kind.get(&kind) else {
            continue;
        };
        for chunk in entity_ids.chunks(MAX_BODY_SNAPSHOT_BULK_TARGETS) {
            let owned_ids = load_body_snapshot_scope_batch(conn, project_id, kind, chunk)?;
            for entity_id in chunk {
                anyhow::ensure!(
                    owned_ids.contains(entity_id),
                    "TIMELAPSE_BODY_SNAPSHOT_ENTITY_SCOPE_MISMATCH: {} entity '{}' does not belong to project '{}'",
                    kind.table(),
                    entity_id,
                    project_id
                );
            }
        }
    }

    let mut inserted_count = 0usize;
    for kind in [
        TimelapseGenesisBaselineKind::Scene,
        TimelapseGenesisBaselineKind::Codex,
        TimelapseGenesisBaselineKind::Snippet,
    ] {
        let Some(entity_ids) = targets_by_kind.get(&kind) else {
            continue;
        };
        for chunk in entity_ids.chunks(MAX_BODY_SNAPSHOT_BULK_TARGETS) {
            inserted_count += append_body_snapshot_bulk_chunk(
                conn,
                project_id,
                kind,
                anchor_sequence,
                anchor_timestamp,
                chunk,
            )?;
        }
    }
    Ok(inserted_count)
}

fn in_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn load_owned_entity_ids(
    tx: &Transaction<'_>,
    project_id: &str,
    kind: TimelapseGenesisBaselineKind,
    entity_ids: &[String],
) -> anyhow::Result<HashSet<String>> {
    let scene_predicate = match kind {
        TimelapseGenesisBaselineKind::Scene => " AND node_type = 'scene'",
        TimelapseGenesisBaselineKind::Codex | TimelapseGenesisBaselineKind::Snippet => "",
    };
    let sql = format!(
        "SELECT id
           FROM {}
          WHERE project_id = ?
            AND id IN ({}){}",
        kind.table(),
        in_placeholders(entity_ids.len()),
        scene_predicate
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(std::iter::once(project_id).chain(entity_ids.iter().map(String::as_str))),
        |row| row.get::<_, String>(0),
    )?;
    Ok(rows.collect::<std::result::Result<HashSet<_>, _>>()?)
}

fn load_owned_content_batch(
    tx: &Transaction<'_>,
    project_id: &str,
    kind: TimelapseGenesisBaselineKind,
    entity_ids: &[String],
) -> anyhow::Result<Vec<String>> {
    let scene_predicate = match kind {
        TimelapseGenesisBaselineKind::Scene => " AND node_type = 'scene'",
        TimelapseGenesisBaselineKind::Codex | TimelapseGenesisBaselineKind::Snippet => "",
    };
    let sql = format!(
        "SELECT id, content
           FROM {}
          WHERE project_id = ?
            AND id IN ({}){}",
        kind.table(),
        in_placeholders(entity_ids.len()),
        scene_predicate
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(std::iter::once(project_id).chain(entity_ids.iter().map(String::as_str))),
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    let content_by_id = rows.collect::<std::result::Result<HashMap<_, _>, _>>()?;
    entity_ids
        .iter()
        .map(|entity_id| {
            content_by_id.get(entity_id).cloned().with_context(|| {
                format!(
                    "TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH: {} entity '{}' does not belong to project '{}'",
                    kind.table(), entity_id, project_id
                )
            })
        })
        .collect()
}

fn load_existing_entity_ids(
    tx: &Transaction<'_>,
    project_id: &str,
    domain: &str,
    entity_type: &str,
    entity_ids: &[String],
    reset_sequence: i64,
) -> anyhow::Result<HashSet<String>> {
    let ids = (4..=entity_ids.len() + 3)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let reset_parameter = entity_ids.len() + 4;
    let sql = format!(
        "SELECT entity_id
           FROM state_snapshots
          WHERE project_id = ?1
            AND domain = ?2
            AND entity_type = ?3
            AND entity_id IN ({ids})
            AND anchor_sequence >= ?{reset_parameter}
         UNION ALL
         SELECT entity_id
           FROM state_snapshots
          WHERE project_id = ?1
            AND domain = ?2
            AND entity_type IS NULL
            AND entity_id IN ({ids})
            AND anchor_sequence >= ?{reset_parameter}"
    );
    let mut statement = tx.prepare(&sql)?;
    let mut values = vec![
        Value::from(project_id.to_owned()),
        Value::from(domain.to_owned()),
        Value::from(entity_type.to_owned()),
    ];
    values.extend(entity_ids.iter().cloned().map(Value::from));
    values.push(Value::from(reset_sequence));
    let rows = statement.query_map(params_from_iter(values), |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<HashSet<_>, _>>()?)
}

fn load_existing_body_steps(
    tx: &Transaction<'_>,
    project_id: &str,
    domain: &str,
    entity_ids: &[String],
    reset_sequence: i64,
) -> anyhow::Result<(HashSet<String>, bool)> {
    let id_placeholders = (3..=entity_ids.len() + 2)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let reset_parameter = entity_ids.len() + 3;
    let sql = format!(
        "SELECT entity_id
           FROM change_events
          WHERE project_id = ?1
            AND domain = ?2
            AND op_type = 'doc.step'
            AND entity_id IN ({id_placeholders})
            AND sequence > ?{reset_parameter}
         UNION ALL
         SELECT entity_id
           FROM change_events
          WHERE project_id = ?1
            AND domain = ?2
            AND op_type = 'doc.step'
            AND entity_id IS NULL
            AND sequence > ?{reset_parameter}
         UNION ALL
         SELECT entity_id
           FROM change_events
          WHERE project_id = ?1
            AND domain = ?2
            AND op_type = 'doc.step'
            AND entity_id = ''
            AND sequence > ?{reset_parameter}"
    );
    let mut statement = tx.prepare(&sql)?;
    let mut values = vec![
        Value::from(project_id.to_owned()),
        Value::from(domain.to_owned()),
    ];
    values.extend(entity_ids.iter().cloned().map(Value::from));
    values.push(Value::from(reset_sequence));
    let rows = statement.query_map(params_from_iter(values), |row| {
        row.get::<_, Option<String>>(0)
    })?;
    let mut entity_steps = HashSet::new();
    let mut ambiguous_domain_step = false;
    for entity_id in rows {
        match entity_id? {
            Some(entity_id) if !entity_id.is_empty() => {
                entity_steps.insert(entity_id);
            }
            Some(_) | None => ambiguous_domain_step = true,
        }
    }
    Ok((entity_steps, ambiguous_domain_step))
}

impl Database {
    /// Append missing genesis baselines for one canonical editor-body kind.
    ///
    /// All source reads, ownership checks, eligibility probes, and inserts are
    /// serialized by one immediate transaction. A retry or a concurrent
    /// connection therefore observes committed rows before it can insert.
    pub fn append_timelapse_genesis_baselines(
        &self,
        project_id: &str,
        kind: TimelapseGenesisBaselineKind,
        entity_ids: &[String],
        anchor_timestamp: i64,
    ) -> anyhow::Result<TimelapseGenesisBaselineAppendSummary> {
        validate_request(project_id, entity_ids, anchor_timestamp)?;
        self.with_conn(|conn| {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let project_exists = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                project_exists,
                "TIMELAPSE_GENESIS_BASELINE_PROJECT_NOT_FOUND: project '{}' does not exist",
                project_id
            );
            let reset_sequence = load_timelapse_reset_sequence(&tx, project_id)?;

            let domain = kind.domain();
            let entity_type = kind.entity_type();
            // Verify the whole input scope from IDs only before eligibility.
            // A stale or mis-scoped member rejects the transaction without
            // reading large editor bodies or inserting a partial chunk.
            let owned_ids = load_owned_entity_ids(&tx, project_id, kind, entity_ids)?;
            for entity_id in entity_ids {
                anyhow::ensure!(
                    owned_ids.contains(entity_id),
                    "TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH: {} entity '{}' does not belong to project '{}'",
                    kind.table(),
                    entity_id,
                    project_id
                );
            }
            // Resolve snapshots first. A fully-baselined steady-state batch
            // must return without preparing any change_events statement.
            let existing_baselines = load_existing_entity_ids(
                &tx,
                project_id,
                domain,
                entity_type,
                entity_ids,
                reset_sequence,
            )?;
            let mut summary = TimelapseGenesisBaselineAppendSummary {
                inserted_count: 0,
                skipped_existing_baseline_count: 0,
                skipped_existing_body_step_count: 0,
            };
            let mut candidates = Vec::with_capacity(entity_ids.len());
            for entity_id in entity_ids {
                if existing_baselines.contains(entity_id) {
                    summary.skipped_existing_baseline_count += 1;
                    continue;
                }
                candidates.push(entity_id.clone());
            }

            if candidates.is_empty() {
                tx.commit()?;
                return Ok(summary);
            }

            // One bounded probe over only unsnapshotted candidates. Repeating
            // an unindexed change_events query per entity would rescan a long
            // event log up to 64 times on first-run or partial projects.
            let (existing_body_steps, ambiguous_domain_step) =
                load_existing_body_steps(&tx, project_id, domain, &candidates, reset_sequence)?;
            let mut eligible_ids = Vec::with_capacity(candidates.len());
            for entity_id in candidates {
                if ambiguous_domain_step || existing_body_steps.contains(&entity_id) {
                    summary.skipped_existing_body_step_count += 1;
                    continue;
                }
                eligible_ids.push(entity_id);
            }

            if eligible_ids.is_empty() {
                tx.commit()?;
                return Ok(summary);
            }

            // Fetch trusted bodies only for rows that will actually insert.
            // Steady-state reopen therefore remains ID-only even for very
            // large documents that already own a snapshot or doc.step.
            let owned_content = load_owned_content_batch(&tx, project_id, kind, &eligible_ids)?;
            validate_projected_batch_size(&owned_content)?;

            for (entity_id, content) in eligible_ids.iter().zip(owned_content) {
                tx.execute(
                    "INSERT INTO state_snapshots
                         (project_id, domain, entity_type, entity_id,
                          anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'json', ?6)",
                    params![
                        project_id,
                        domain,
                        entity_type,
                        entity_id,
                        reset_sequence,
                        anchor_timestamp,
                        content
                    ],
                )?;
                summary.inserted_count += 1;
            }
            tx.commit()?;
            Ok(summary)
        })
    }

    /// Append trusted body baselines at the current canonical tail.
    ///
    /// Renderer callers provide only `(kind, entity_id)` identities.  The
    /// transaction validates ownership, reads the body from its authoritative
    /// table, resolves the current canonical tail/timestamp, and only then
    /// inserts `state_snapshots`.  An optional renderer-observed tail is merely
    /// an OCC check; it is never used as the anchor unless it matches Native's
    /// current tail exactly.
    pub fn append_timelapse_body_baselines(
        &self,
        project_id: &str,
        targets: &[TimelapseBodySnapshotTarget],
        expected_anchor_sequence: Option<i64>,
    ) -> anyhow::Result<TimelapseBodyBaselineAppendSummary> {
        validate_body_snapshot_targets(project_id, targets, expected_anchor_sequence)?;
        self.with_conn(|conn| {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let project_exists = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                project_exists,
                "TIMELAPSE_BODY_SNAPSHOT_PROJECT_NOT_FOUND: project '{}' does not exist",
                project_id
            );

            let tail = tx
                .query_row(
                    "SELECT sequence, timestamp
                       FROM change_events
                      WHERE project_id = ?1
                      ORDER BY sequence DESC
                      LIMIT 1",
                    [project_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let (anchor_sequence, anchor_timestamp) =
                tail.unwrap_or((0, chrono::Utc::now().timestamp_millis()));
            anyhow::ensure!(
                (0..=MAX_SAFE_INTEGER).contains(&anchor_sequence)
                    && (0..=MAX_SAFE_INTEGER).contains(&anchor_timestamp),
                "TIMELAPSE_BODY_SNAPSHOT_INVALID_TAIL: canonical tail is outside the safe integer range"
            );
            if let Some(expected) = expected_anchor_sequence {
                anyhow::ensure!(
                    expected == anchor_sequence,
                    "TIMELAPSE_BODY_SNAPSHOT_ANCHOR_MISMATCH: expected tail {}, current tail {}",
                    expected,
                    anchor_sequence
                );
            }

            // Resolve every target before any insert.  A stale entity or a
            // cross-project identity therefore rolls back the complete batch
            // instead of leaving a partially rebaselined project.
            let mut targets_by_kind = HashMap::<TimelapseGenesisBaselineKind, Vec<String>>::new();
            for target in targets {
                targets_by_kind
                    .entry(target.kind)
                    .or_default()
                    .push(target.entity_id.clone());
            }
            let mut trusted_content = HashMap::<TimelapseBodySnapshotTarget, String>::new();
            for kind in [
                TimelapseGenesisBaselineKind::Scene,
                TimelapseGenesisBaselineKind::Codex,
                TimelapseGenesisBaselineKind::Snippet,
            ] {
                let Some(entity_ids) = targets_by_kind.get(&kind) else {
                    continue;
                };
                let content = load_owned_content_batch(&tx, project_id, kind, entity_ids)?;
                for (entity_id, body) in entity_ids.iter().zip(content) {
                    let target = match kind {
                        TimelapseGenesisBaselineKind::Scene => {
                            TimelapseBodySnapshotTarget::scene(entity_id.clone())
                        }
                        TimelapseGenesisBaselineKind::Codex => {
                            TimelapseBodySnapshotTarget::codex(entity_id.clone())
                        }
                        TimelapseGenesisBaselineKind::Snippet => {
                            TimelapseBodySnapshotTarget::snippet(entity_id.clone())
                        }
                    };
                    trusted_content.insert(target, body);
                }
            }

            let mut skipped_existing_count = 0usize;
            let mut insert_targets = Vec::new();
            for target in targets {
                let body = trusted_content.get(target).ok_or_else(|| {
                    anyhow::anyhow!(
                        "TIMELAPSE_BODY_SNAPSHOT_ENTITY_SCOPE_MISMATCH: target body was not resolved"
                    )
                })?;
                let mut statement = tx.prepare(
                    "SELECT entity_type, anchor_timestamp, payload, encoding
                       FROM state_snapshots
                      WHERE project_id = ?1
                        AND domain = ?2
                        AND entity_id = ?3
                        AND anchor_sequence = ?4",
                )?;
                let mut rows = statement.query(params![
                    project_id,
                    target.kind.domain(),
                    target.entity_id,
                    anchor_sequence,
                ])?;
                let mut existing = false;
                while let Some(row) = rows.next()? {
                    let entity_type = row.get::<_, Option<String>>(0)?;
                    anyhow::ensure!(
                        entity_type
                            .as_deref()
                            .is_none_or(|value| value == target.kind.entity_type()),
                        "TIMELAPSE_BODY_SNAPSHOT_EXISTING_MISMATCH: entity type does not match target"
                    );
                    anyhow::ensure!(
                        row.get::<_, i64>(1)? == anchor_timestamp
                            && row.get::<_, String>(2)? == *body
                            && row.get::<_, String>(3)? == "json",
                        "TIMELAPSE_BODY_SNAPSHOT_EXISTING_MISMATCH: existing snapshot does not match trusted body or tail"
                    );
                    existing = true;
                }
                if existing {
                    skipped_existing_count += 1;
                } else {
                    insert_targets.push(target);
                }
            }

            for target in insert_targets {
                let body = trusted_content.get(target).ok_or_else(|| {
                    anyhow::anyhow!(
                        "TIMELAPSE_BODY_SNAPSHOT_ENTITY_SCOPE_MISMATCH: target body was not resolved"
                    )
                })?;
                tx.execute(
                    "INSERT INTO state_snapshots
                         (project_id, domain, entity_type, entity_id,
                          anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'json', ?6)",
                    params![
                        project_id,
                        target.kind.domain(),
                        target.kind.entity_type(),
                        target.entity_id,
                        anchor_sequence,
                        anchor_timestamp,
                        body,
                    ],
                )?;
            }

            let inserted_count = targets.len() - skipped_existing_count;
            tx.commit()?;
            Ok(TimelapseBodyBaselineAppendSummary {
                inserted_count,
                skipped_existing_count,
                anchor_sequence,
                anchor_timestamp,
            })
        })
    }

    /// Atomically purge the timelapse ledgers for one project.
    pub fn purge_timelapse_history(
        &self,
        project_id: &str,
    ) -> anyhow::Result<TimelapseHistoryPurgeSummary> {
        anyhow::ensure!(
            !project_id.is_empty()
                && project_id.trim() == project_id
                && project_id.chars().count() <= MAX_PROJECT_ID_LENGTH,
            "TIMELAPSE_HISTORY_INVALID_PROJECT: projectId must be exact, non-empty, and at most {MAX_PROJECT_ID_LENGTH} characters"
        );
        self.with_conn(|conn| {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let project_exists = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                project_exists,
                "TIMELAPSE_HISTORY_PROJECT_NOT_FOUND: project '{}' does not exist",
                project_id
            );
            // `change_events` is a shared, immutable hash chain.  It is also
            // the parent of the Narrative Change Feed through RESTRICT
            // foreign keys, so no row can be physically removed during a
            // timelapse reset without breaking sequence/hash continuity or a
            // canonical feed projection.  The reset epoch below makes the
            // old prefix invisible to timelapse readers while preserving it
            // for the other consumers of the canonical chain.
            let previous_reset_sequence = load_timelapse_reset_sequence(&tx, project_id)?;
            let current_tail_sequence = tx.query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM change_events WHERE project_id = ?1",
                [project_id],
                |row| row.get::<_, i64>(0),
            )?;
            anyhow::ensure!(
                (0..=MAX_SAFE_INTEGER).contains(&current_tail_sequence),
                "TIMELAPSE_HISTORY_INVALID_TAIL: canonical tail is outside the safe integer range"
            );
            let logically_purged_event_count = tx.query_row(
                "SELECT COUNT(*) FROM change_events
                  WHERE project_id = ?1 AND sequence > ?2 AND sequence <= ?3",
                params![project_id, previous_reset_sequence, current_tail_sequence],
                |row| row.get::<_, i64>(0),
            )? as usize;
            let deleted_snapshot_count = tx.execute(
                "DELETE FROM state_snapshots WHERE project_id = ?1",
                [project_id],
            )?;
            tx.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES (?1, 'timelapse.resetSequence', ?2)
                 ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
                params![project_id, current_tail_sequence.to_string()],
            )?;
            tx.commit()?;
            Ok(TimelapseHistoryPurgeSummary {
                deleted_event_count: logically_purged_event_count,
                deleted_snapshot_count,
            })
        })
    }

    /// Set the timelapse flag in the same Native authority used by its
    /// protected writers. This is intentionally a narrow key-specific method
    /// so a workspace switch cannot redirect a renderer rollback to another
    /// database through generic project-settings DML.
    pub fn set_timelapse_enabled(
        &self,
        project_id: &str,
        enabled: bool,
    ) -> anyhow::Result<TimelapseEnabledSetSummary> {
        anyhow::ensure!(
            !project_id.is_empty()
                && project_id.trim() == project_id
                && project_id.chars().count() <= MAX_PROJECT_ID_LENGTH,
            "TIMELAPSE_ENABLED_INVALID_PROJECT: projectId must be exact, non-empty, and at most {MAX_PROJECT_ID_LENGTH} characters"
        );
        self.with_conn(|conn| {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let project_exists = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                project_exists,
                "TIMELAPSE_ENABLED_PROJECT_NOT_FOUND: project '{}' does not exist",
                project_id
            );
            tx.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES (?1, 'timelapse.enabled', ?2)
                 ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
                params![project_id, if enabled { "true" } else { "false" }],
            )?;
            tx.commit()?;
            Ok(TimelapseEnabledSetSummary { enabled })
        })
    }

    /// Append a renderer-provided layout state under one fixed snapshot scope.
    /// The caller cannot select a domain/entity or forge the anchor timestamp;
    /// Native derives both from the active project's canonical tail.
    pub fn append_timelapse_layout_snapshot(
        &self,
        project_id: &str,
        payload: &str,
        expected_anchor_sequence: Option<i64>,
    ) -> anyhow::Result<TimelapseLayoutSnapshotAppendSummary> {
        validate_layout_snapshot_payload(payload)?;
        anyhow::ensure!(
            !project_id.is_empty()
                && project_id.trim() == project_id
                && project_id.chars().count() <= MAX_PROJECT_ID_LENGTH,
            "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_PROJECT: projectId must be exact, non-empty, and at most {MAX_PROJECT_ID_LENGTH} characters"
        );
        if let Some(anchor_sequence) = expected_anchor_sequence {
            anyhow::ensure!(
                (0..=MAX_SAFE_INTEGER).contains(&anchor_sequence),
                "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_SEQUENCE: expectedAnchorSequence must be a non-negative safe integer"
            );
        }
        self.with_conn(|conn| {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let project_exists = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                project_exists,
                "TIMELAPSE_LAYOUT_SNAPSHOT_PROJECT_NOT_FOUND: project '{}' does not exist",
                project_id
            );
            let tail = tx
                .query_row(
                    "SELECT sequence, timestamp
                       FROM change_events
                      WHERE project_id = ?1
                      ORDER BY sequence DESC
                      LIMIT 1",
                    [project_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let (anchor_sequence, anchor_timestamp) =
                tail.unwrap_or((0, chrono::Utc::now().timestamp_millis()));
            anyhow::ensure!(
                (0..=MAX_SAFE_INTEGER).contains(&anchor_sequence)
                    && (0..=MAX_SAFE_INTEGER).contains(&anchor_timestamp),
                "TIMELAPSE_LAYOUT_SNAPSHOT_INVALID_TAIL: canonical tail is outside the safe integer range"
            );
            if let Some(expected) = expected_anchor_sequence {
                anyhow::ensure!(
                    expected == anchor_sequence,
                    "TIMELAPSE_LAYOUT_SNAPSHOT_ANCHOR_MISMATCH: expected tail {}, current tail {}",
                    expected,
                    anchor_sequence
                );
            }
            tx.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id,
                      anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                 VALUES (?1, 'layout', 'workspace', 'workspace', ?2, ?3, ?4, 'json', ?3)",
                params![project_id, anchor_sequence, anchor_timestamp, payload],
            )?;
            tx.commit()?;
            Ok(TimelapseLayoutSnapshotAppendSummary {
                inserted: true,
                anchor_sequence,
                anchor_timestamp,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };

    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use rusqlite::params;

    use crate::domain_writes::{tree_node_create, TreeNodeCreatePayload};
    use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;

    use super::*;

    fn database() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        seed(&db);
        db
    }

    fn seed(db: &Database) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES ('project-a', 'A', 'ja')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES ('project-b', 'B', 'ja')",
                [],
            )?;
            for (id, project, node_type, content) in [
                (
                    "scene-new",
                    "project-a",
                    "scene",
                    r#"{"type":"doc","content":[]}"#,
                ),
                (
                    "scene-baseline",
                    "project-a",
                    "scene",
                    r#"{"type":"doc","content":[1]}"#,
                ),
                (
                    "scene-stepped",
                    "project-a",
                    "scene",
                    r#"{"type":"doc","content":[2]}"#,
                ),
                ("scene-other", "project-b", "scene", "{}"),
                ("note-a", "project-a", "note", "{}"),
            ] {
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                     VALUES (?1, ?2, ?3, ?1, ?4)",
                    params![id, project, node_type, content],
                )?;
            }
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, content)
                 VALUES ('codex-a', 'project-a', 'character', 'Codex A', '{\"type\":\"doc\"}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO snippets (id, project_id, title, content)
                 VALUES ('snippet-a', 'project-a', 'Snippet A', '{\"type\":\"doc\"}')",
                [],
            )?;
            Ok(())
        })
        .expect("seed database");
    }

    fn insert_test_tail(
        db: &Database,
        project_id: &str,
        sequence: i64,
        timestamp: i64,
    ) -> anyhow::Result<()> {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES (?1, 'editor', 'scene.replace', 'scene', 'scene-new', '{}',
                         'test-session', ?2, ?3, 'prev', ?4)",
                params![
                    project_id,
                    sequence,
                    timestamp,
                    format!("test-hash-{sequence}")
                ],
            )?;
            Ok(())
        })
    }

    fn insert_coverage_event(
        conn: &Connection,
        sequence: i64,
        event_uid: &str,
        session_id: &str,
        entity_type: &str,
        entity_id: &str,
        digest: &str,
    ) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO change_events
                 (project_id, event_uid, domain, op_type, entity_type, entity_id,
                  payload, session_id, sequence, timestamp, prev_hash, hash)
             VALUES ('project-a', ?1, 'timelapse-internal', 'doc.step.coverage', ?2, ?3,
                     json_object('resultContentDigest', ?4), ?5, ?6, ?6, ?7, ?8)",
            params![
                event_uid,
                entity_type,
                entity_id,
                digest,
                session_id,
                sequence,
                format!("coverage-prev-{sequence}"),
                format!("coverage-hash-{sequence}"),
            ],
        )?;
        Ok(())
    }

    fn insert_raw_coverage_event(
        conn: &Connection,
        sequence: i64,
        event_uid: &str,
        session_id: &str,
        entity_type: &str,
        entity_id: &str,
        payload: &str,
    ) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO change_events
                 (project_id, event_uid, domain, op_type, entity_type, entity_id,
                  payload, session_id, sequence, timestamp, prev_hash, hash)
             VALUES ('project-a', ?1, 'timelapse-internal', 'doc.step.coverage', ?2, ?3,
                     ?4, ?5, ?6, ?6, ?7, ?8)",
            params![
                event_uid,
                entity_type,
                entity_id,
                payload,
                session_id,
                sequence,
                format!("raw-coverage-prev-{sequence}"),
                format!("raw-coverage-hash-{sequence}"),
            ],
        )?;
        Ok(())
    }

    #[test]
    fn derives_trusted_payload_domain_and_entity_type() {
        let db = database();
        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &["scene-new".into()],
                123,
            )
            .expect("append baseline");
        assert_eq!(
            summary,
            TimelapseGenesisBaselineAppendSummary {
                inserted_count: 1,
                skipped_existing_baseline_count: 0,
                skipped_existing_body_step_count: 0,
            }
        );
        db.with_conn(|conn| {
            let row: (String, String, String, i64, i64, String, String, i64) = conn.query_row(
                "SELECT domain, entity_type, entity_id, anchor_sequence,
                        anchor_timestamp, payload, encoding, created_at
                   FROM state_snapshots",
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
                        row.get(7)?,
                    ))
                },
            )?;
            assert_eq!(
                row,
                (
                    "editor".into(),
                    "scene".into(),
                    "scene-new".into(),
                    0,
                    123,
                    r#"{"type":"doc","content":[]}"#.into(),
                    "json".into(),
                    123,
                )
            );
            Ok(())
        })
        .expect("read snapshot");
    }

    #[test]
    fn skips_only_the_same_entity_baseline_or_body_step() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id, anchor_sequence,
                      anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', 'scene', 'scene-baseline', 9,
                         1, '{}', 'json', 1)",
                [],
            )?;
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'doc.step', 'scene', 'scene-stepped', '{}',
                         'session-a', 1, 1, 'prev', 'hash')",
                [],
            )?;
            Ok(())
        })
        .expect("seed eligibility rows");

        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &[
                    "scene-baseline".into(),
                    "scene-stepped".into(),
                    "scene-new".into(),
                ],
                200,
            )
            .expect("append eligible baseline");
        assert_eq!(
            summary,
            TimelapseGenesisBaselineAppendSummary {
                inserted_count: 1,
                skipped_existing_baseline_count: 1,
                skipped_existing_body_step_count: 1,
            }
        );
    }

    #[test]
    fn genesis_eligibility_deduplicates_exact_and_legacy_null_snapshots() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id, anchor_sequence,
                      anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', 'scene', 'scene-baseline', 4,
                         1, '{}', 'json', 1)",
                [],
            )?;
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id, anchor_sequence,
                      anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', NULL, 'scene-new', 4,
                         1, '{}', 'json', 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed exact and legacy snapshot rows");

        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &[
                    "scene-baseline".into(),
                    "scene-new".into(),
                    "scene-stepped".into(),
                ],
                5,
            )
            .expect("indexed snapshot eligibility");
        assert_eq!(summary.skipped_existing_baseline_count, 2);
        assert_eq!(summary.inserted_count, 1);
        assert_eq!(summary.skipped_existing_body_step_count, 0);
    }

    #[test]
    fn genesis_eligibility_ignores_pre_reset_steps_and_reanchors_at_reset_epoch() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'doc.step', 'scene', 'scene-new', '{}',
                         'pre-reset-session', 1, 100, 'pre-reset-prev', 'pre-reset-hash')",
                [],
            )?;
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id, anchor_sequence,
                      anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', 'scene', 'scene-new', 0,
                         90, '{}', 'json', 90)",
                [],
            )?;
            conn.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('project-a', 'timelapse.resetSequence', '1')",
                [],
            )?;
            Ok(())
        })
        .expect("seed pre-reset eligibility state");

        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &["scene-new".into()],
                200,
            )
            .expect("rebaseline after reset");
        assert_eq!(summary.inserted_count, 1);
        assert_eq!(summary.skipped_existing_baseline_count, 0);
        assert_eq!(summary.skipped_existing_body_step_count, 0);
        db.with_conn(|conn| {
            let row: (i64, i64, String) = conn.query_row(
                "SELECT anchor_sequence, anchor_timestamp, payload
                   FROM state_snapshots
                  WHERE project_id = 'project-a'
                    AND anchor_sequence >= 1
                    AND entity_id = 'scene-new'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(row, (1, 200, r#"{"type":"doc","content":[]}"#.to_string()));
            Ok(())
        })
        .expect("read reset-epoch baseline");
    }

    #[test]
    fn rejects_mis_scoped_or_wrong_kind_entities_before_any_insert() {
        for entity_id in ["scene-other", "note-a", "missing"] {
            let db = database();
            let error = db
                .append_timelapse_genesis_baselines(
                    "project-a",
                    TimelapseGenesisBaselineKind::Scene,
                    &["scene-new".into(), entity_id.into()],
                    1,
                )
                .expect_err("scope mismatch");
            assert!(
                error
                    .to_string()
                    .contains("TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH"),
                "unexpected error: {error:#}"
            );
            let count = db
                .with_conn(|conn| {
                    Ok(
                        conn.query_row("SELECT COUNT(*) FROM state_snapshots", [], |row| {
                            row.get::<_, i64>(0)
                        })?,
                    )
                })
                .expect("snapshot count");
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_request_shapes() {
        let db = database();
        for (ids, timestamp) in [
            (Vec::<String>::new(), 1),
            (vec!["scene-new".into(), "scene-new".into()], 1),
            (vec![String::new()], 1),
            (vec![" scene-new".into()], 1),
            (vec!["scene-new".into()], -1),
            (vec!["scene-new".into()], MAX_SAFE_INTEGER + 1),
        ] {
            assert!(db
                .append_timelapse_genesis_baselines(
                    "project-a",
                    TimelapseGenesisBaselineKind::Scene,
                    &ids,
                    timestamp,
                )
                .is_err());
        }
        let too_many = (0..=MAX_ENTITY_IDS)
            .map(|index| format!("scene-{index}"))
            .collect::<Vec<_>>();
        assert!(db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &too_many,
                1,
            )
            .is_err());
        assert!(db
            .append_timelapse_genesis_baselines(
                " project-a",
                TimelapseGenesisBaselineKind::Scene,
                &["scene-new".into()],
                1,
            )
            .is_err());
    }

    #[test]
    fn bounds_multi_entity_payload_but_keeps_singletons_recoverable() {
        let oversized = "x".repeat(MAX_BATCH_PAYLOAD_BYTES + 1);
        validate_projected_batch_size(std::slice::from_ref(&oversized))
            .expect("oversized singleton stays baselineable");
        let error = validate_projected_batch_size(&[oversized, String::new()])
            .expect_err("oversized multi-entity transaction must split");
        assert!(error
            .to_string()
            .starts_with("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE:"));
    }

    #[test]
    fn payload_cap_applies_only_to_eligible_entities() {
        let db = database();
        let large = "x".repeat((MAX_BATCH_PAYLOAD_BYTES / 2) + 1);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET content = ?1
                  WHERE id IN ('scene-new', 'scene-baseline')",
                [&large],
            )?;
            Ok(())
        })
        .expect("seed large bodies");
        let entity_ids = vec!["scene-new".into(), "scene-baseline".into()];
        let error = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &entity_ids,
                1,
            )
            .expect_err("eligible large batch must split");
        assert!(error
            .to_string()
            .starts_with("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE:"));

        db.with_conn(|conn| {
            for entity_id in &entity_ids {
                conn.execute(
                    "INSERT INTO state_snapshots
                         (project_id, domain, entity_type, entity_id, anchor_sequence,
                          anchor_timestamp, payload, encoding, created_at)
                     VALUES ('project-a', 'editor', 'scene', ?1, 12, 1, '{}', 'json', 1)",
                    [entity_id],
                )?;
            }
            Ok(())
        })
        .expect("seed later rebaselines");
        let change_event_reads = Arc::new(AtomicUsize::new(0));
        let reads_for_hook = Arc::clone(&change_event_reads);
        db.with_conn(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Read {
                        table_name: "change_events",
                        ..
                    }
                ) {
                    reads_for_hook.fetch_add(1, Ordering::SeqCst);
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }))?;
            Ok(())
        })
        .expect("install change_events read guard");
        let result = db.append_timelapse_genesis_baselines(
            "project-a",
            TimelapseGenesisBaselineKind::Scene,
            &entity_ids,
            2,
        );
        db.with_conn(|conn| {
            conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            Ok(())
        })
        .expect("remove change_events read guard");
        let summary = result.expect("fully skipped batch must not query change_events");
        assert_eq!(summary.skipped_existing_baseline_count, 2);
        assert_eq!(summary.inserted_count, 0);
        assert_eq!(change_event_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn ambiguous_legacy_domain_step_skips_every_requested_entity() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'doc.step', 'scene', NULL, '{}',
                         'legacy-session', 1, 1, 'prev', 'hash')",
                [],
            )?;
            Ok(())
        })
        .expect("seed ambiguous legacy step");
        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &["scene-new".into(), "scene-baseline".into()],
                2,
            )
            .expect("ambiguous step is a safe skip");
        assert_eq!(summary.skipped_existing_body_step_count, 2);
        assert_eq!(summary.inserted_count, 0);
    }

    #[test]
    fn retry_is_idempotent() {
        let db = database();
        let first = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Codex,
                &["codex-a".into()],
                10,
            )
            .expect("first append");
        let second = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Codex,
                &["codex-a".into()],
                20,
            )
            .expect("retry append");
        assert_eq!(first.inserted_count, 1);
        assert_eq!(second.skipped_existing_baseline_count, 1);
    }

    #[test]
    fn concurrent_connections_cannot_duplicate_a_genesis_baseline() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-timelapse-genesis-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("grimodex.db");
        let first = Arc::new(Database::new(&path).expect("first database"));
        first.migrate().expect("schema");
        seed(&first);
        let second = Arc::new(Database::new(&path).expect("second database"));
        let barrier = Arc::new(Barrier::new(3));
        let handles = [first.clone(), second.clone()].map(|db| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                db.append_timelapse_genesis_baselines(
                    "project-a",
                    TimelapseGenesisBaselineKind::Snippet,
                    &["snippet-a".into()],
                    10,
                )
                .expect("concurrent append")
            })
        });
        barrier.wait();
        let summaries = handles.map(|handle| handle.join().expect("append thread"));
        assert_eq!(
            summaries
                .iter()
                .map(|summary| summary.inserted_count)
                .sum::<usize>(),
            1
        );
        assert_eq!(
            summaries
                .iter()
                .map(|summary| summary.skipped_existing_baseline_count)
                .sum::<usize>(),
            1
        );
        let count = first
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM state_snapshots
                      WHERE project_id = 'project-a'
                        AND domain = 'snippet'
                        AND entity_id = 'snippet-a'
                        AND anchor_sequence = 0",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("snapshot count");
        assert_eq!(count, 1);
        drop(first);
        drop(second);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn body_snapshot_helper_requires_transaction_and_safe_exact_tail_anchor() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'scene.replace', 'scene', 'scene-new', '{}',
                         'session-a', 1, 7, 'prev', 'body-helper-tail-1')",
                [],
            )?;
            let target = TimelapseBodySnapshotTarget::scene("scene-new");
            let outside_tx = append_timelapse_body_snapshots_in_tx(
                conn,
                "project-a",
                1,
                7,
                std::slice::from_ref(&target),
            )
            .expect_err("caller-owned transaction is required");
            assert!(outside_tx
                .to_string()
                .contains("TIMELAPSE_BODY_SNAPSHOT_TRANSACTION_REQUIRED"));

            conn.execute_batch("BEGIN IMMEDIATE")?;
            for (sequence, timestamp, marker) in [
                (0, 7, "INVALID_SEQUENCE"),
                (MAX_SAFE_INTEGER + 1, 7, "INVALID_SEQUENCE"),
                (1, -1, "INVALID_TIMESTAMP"),
                (1, MAX_SAFE_INTEGER + 1, "INVALID_TIMESTAMP"),
                (1, 8, "ANCHOR_MISMATCH"),
            ] {
                let error = append_timelapse_body_snapshots_in_tx(
                    conn,
                    "project-a",
                    sequence,
                    timestamp,
                    std::slice::from_ref(&target),
                )
                .expect_err("invalid anchor boundary must fail closed");
                assert!(
                    error.to_string().contains(marker),
                    "unexpected error for sequence={sequence}, timestamp={timestamp}: {error:#}"
                );
            }
            conn.execute_batch("ROLLBACK")?;
            Ok(())
        })
        .expect("validate body snapshot boundaries");
    }

    #[test]
    fn body_snapshot_helper_honors_off_and_deduplicates_targets_and_retry() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'scene.replace', 'scene', 'scene-new', '{}',
                         'session-a', 1, 9, 'prev', 'body-helper-tail-2')",
                [],
            )?;
            let target = TimelapseBodySnapshotTarget::scene("scene-new");
            let targets = vec![target.clone(), target.clone(), target];
            assert_eq!(
                append_timelapse_body_snapshots_in_tx(conn, "project-a", 1, 9, &targets,)?,
                1
            );
            assert_eq!(
                append_timelapse_body_snapshots_in_tx(conn, "project-a", 1, 9, &targets,)?,
                0
            );
            conn.execute_batch("COMMIT")?;

            conn.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('project-a', 'timelapse.enabled', 'false')",
                [],
            )?;
            conn.execute_batch("BEGIN IMMEDIATE")?;
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'codex', 'entry.update', 'codex_entry', 'codex-a', '{}',
                         'session-a', 2, 10, 'body-helper-tail-2', 'body-helper-tail-3')",
                [],
            )?;
            assert_eq!(
                append_timelapse_body_snapshots_in_tx(
                    conn,
                    "project-a",
                    2,
                    10,
                    &[TimelapseBodySnapshotTarget::codex("codex-a")],
                )?,
                0
            );
            conn.execute_batch("COMMIT")?;

            let rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(rows, 1);
            Ok(())
        })
        .expect("append idempotent body snapshots");
    }

    #[test]
    fn body_snapshot_helper_deduplicates_legacy_null_entity_type_rows() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'scene.replace', 'scene', 'scene-new', '{}',
                         'session-a', 1, 13, 'prev', 'body-helper-legacy-null')",
                [],
            )?;
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id,
                      anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', NULL, 'scene-new', 1, 13, '{}', 'json', 13)",
                [],
            )?;
            let inserted = append_timelapse_body_snapshots_in_tx(
                conn,
                "project-a",
                1,
                13,
                &[TimelapseBodySnapshotTarget::scene("scene-new")],
            )?;
            assert_eq!(inserted, 0);
            conn.execute_batch("COMMIT")?;
            let rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots
                  WHERE project_id = 'project-a' AND domain = 'editor'
                    AND entity_id = 'scene-new' AND anchor_sequence = 1",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(rows, 1);
            Ok(())
        })
        .expect("legacy null snapshot is a logical dedupe match");
    }

    #[test]
    fn body_snapshot_helper_batches_scope_reads_and_inserts_by_kind() {
        let db = database();
        db.with_conn(|conn| {
            for index in 0..12 {
                conn.execute(
                    "INSERT INTO tree_nodes
                         (id, project_id, node_type, title, content)
                     VALUES (?1, 'project-a', 'scene', ?1, '{}')",
                    [format!("scene-bulk-{index}")],
                )?;
            }
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'scene.replace', 'scene', 'scene-new', '{}',
                         'session-a', 1, 14, 'prev', 'body-helper-bulk-tail')",
                [],
            )?;
            Ok(())
        })
        .expect("seed bulk body targets");

        let source_reads = Arc::new(AtomicUsize::new(0));
        let reads_for_hook = Arc::clone(&source_reads);
        db.with_conn(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Read {
                        table_name: "tree_nodes",
                        ..
                    }
                ) {
                    reads_for_hook.fetch_add(1, Ordering::SeqCst);
                }
                Authorization::Allow
            }))?;
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let targets = (0..12)
                .map(|index| TimelapseBodySnapshotTarget::scene(format!("scene-bulk-{index}")))
                .collect::<Vec<_>>();
            let inserted =
                append_timelapse_body_snapshots_in_tx(conn, "project-a", 1, 14, &targets)?;
            conn.execute_batch("COMMIT")?;
            conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            assert_eq!(inserted, 12);
            Ok(())
        })
        .expect("append bulk body snapshots");
        assert!(
            source_reads.load(Ordering::SeqCst) <= 16,
            "body restore should use bounded source reads, got {}",
            source_reads.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn genesis_eligibility_queries_use_entity_lookup_indexes() {
        let db = database();
        db.with_conn(|conn| {
            let event_plan = conn
                .prepare(
                    "EXPLAIN QUERY PLAN
                       SELECT entity_id
                         FROM change_events
                        WHERE project_id = 'project-a'
                          AND domain = 'editor'
                          AND op_type = 'doc.step'
                          AND entity_id IN ('scene-new', 'scene-baseline')
                       UNION ALL
                       SELECT entity_id
                         FROM change_events
                        WHERE project_id = 'project-a'
                          AND domain = 'editor'
                          AND op_type = 'doc.step'
                          AND entity_id IS NULL
                       UNION ALL
                       SELECT entity_id
                         FROM change_events
                        WHERE project_id = 'project-a'
                          AND domain = 'editor'
                          AND op_type = 'doc.step'
                          AND entity_id = ''",
                )?
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let event_searches = event_plan
                .iter()
                .filter(|detail| detail.contains("change_events"))
                .collect::<Vec<_>>();
            assert!(
                event_searches.len() >= 3
                    && event_searches.iter().all(|detail| {
                        detail.contains("idx_change_events_project_domain_op_entity_seq")
                            && detail.contains("entity_id=?")
                    }),
                "event eligibility plan did not seek entity ids: {event_plan:?}"
            );

            let snapshot_plan = conn
                .prepare(
                    "EXPLAIN QUERY PLAN
                       SELECT entity_id
                         FROM state_snapshots
                        WHERE project_id = 'project-a'
                          AND domain = 'editor'
                          AND entity_type = 'scene'
                          AND entity_id IN ('scene-new', 'scene-baseline')
                       UNION ALL
                       SELECT entity_id
                         FROM state_snapshots
                        WHERE project_id = 'project-a'
                          AND domain = 'editor'
                          AND entity_type IS NULL
                          AND entity_id IN ('scene-new', 'scene-baseline')",
                )?
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let snapshot_searches = snapshot_plan
                .iter()
                .filter(|detail| detail.contains("state_snapshots"))
                .collect::<Vec<_>>();
            assert!(
                snapshot_searches.len() >= 2
                    && snapshot_searches.iter().all(|detail| {
                        detail.contains("idx_state_snap_project_domain_type_entity_seq")
                            && detail.contains("entity_id=?")
                    }),
                "snapshot eligibility plan did not seek entity ids: {snapshot_plan:?}"
            );
            assert!(
                snapshot_searches.iter().any(|detail| {
                    detail.contains("entity_type=?") || detail.contains("entity_type IS NULL")
                }),
                "snapshot eligibility plan omitted exact/legacy entity-type branches: {snapshot_plan:?}"
            );
            Ok(())
        })
        .expect("inspect indexed eligibility plans");
    }

    #[test]
    fn body_snapshot_helper_rejects_scope_mismatch_for_the_whole_caller_transaction() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'scene.replace', 'scene', 'scene-new', '{}',
                         'session-a', 1, 11, 'prev', 'body-helper-scope-tail')",
                [],
            )?;
            let error = append_timelapse_body_snapshots_in_tx(
                conn,
                "project-a",
                1,
                11,
                &[
                    TimelapseBodySnapshotTarget::scene("scene-new"),
                    TimelapseBodySnapshotTarget::scene("scene-other"),
                ],
            )
            .expect_err("foreign-project entity must fail closed");
            assert!(error
                .to_string()
                .contains("TIMELAPSE_BODY_SNAPSHOT_ENTITY_SCOPE_MISMATCH"));
            conn.execute_batch("ROLLBACK")?;
            let snapshots: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(snapshots, 0);
            Ok(())
        })
        .expect("validate body snapshot scope");
    }

    #[test]
    fn exact_internal_coverage_suppresses_snapshot_until_a_later_body_step() {
        let db = database();
        let content = r#"{"type":"doc"}"#;
        let digest = timelapse_content_digest(content);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, event_uid, domain, op_type, entity_type, entity_id,
                      payload, session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'before-coverage-step', 'codex', 'doc.step',
                         'codex_entry', 'codex-a', '{}', 'coverage-session', 1, 1,
                         'before-coverage-prev', 'before-coverage-hash')",
                [],
            )?;
            insert_coverage_event(
                conn,
                2,
                "coverage-event",
                "coverage-session",
                "codex_entry",
                "codex-a",
                &digest,
            )?;
            let scope = TimelapseDocStepCoverageScope {
                project_id: "project-a",
                session_id: "coverage-session",
                domain: "codex",
                entity_type: "codex_entry",
                entity_id: "codex-a",
            };
            let proof = TimelapseDocStepCoverageProof {
                event_uid: "coverage-event".to_string(),
                session_id: "coverage-session".to_string(),
                content_digest: digest.clone(),
            };
            assert!(!should_append_timelapse_body_snapshot(
                conn,
                scope,
                Some(content),
                Some(&proof),
                true,
            )?);

            conn.execute(
                "INSERT INTO change_events
                     (project_id, event_uid, domain, op_type, entity_type, entity_id,
                      payload, session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'later-step', 'codex', 'doc.step',
                         'codex_entry', 'codex-a', '{}', 'coverage-session', 3, 3,
                         'coverage-hash-2', 'later-step-hash')",
                [],
            )?;
            assert!(should_append_timelapse_body_snapshot(
                conn,
                TimelapseDocStepCoverageScope {
                    project_id: "project-a",
                    session_id: "coverage-session",
                    domain: "codex",
                    entity_type: "codex_entry",
                    entity_id: "codex-a",
                },
                Some(content),
                Some(&proof),
                true,
            )?);
            Ok(())
        })
        .expect("validate exact coverage and stale-proof fallback");
    }

    #[test]
    fn coverage_proof_before_reset_epoch_cannot_suppress_a_body_snapshot() {
        let db = database();
        let content = r#"{"type":"doc"}"#;
        let digest = timelapse_content_digest(content);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, event_uid, domain, op_type, entity_type, entity_id,
                      payload, session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'pre-reset-coverage-step', 'codex', 'doc.step',
                         'codex_entry', 'codex-a', '{}', 'coverage-session', 1, 1,
                         'pre-reset-coverage-prev', 'pre-reset-coverage-hash')",
                [],
            )?;
            insert_coverage_event(
                conn,
                2,
                "pre-reset-coverage",
                "coverage-session",
                "codex_entry",
                "codex-a",
                &digest,
            )?;
            conn.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('project-a', 'timelapse.resetSequence', '2')",
                [],
            )?;
            Ok(())
        })
        .expect("seed pre-reset coverage proof");

        let proof = TimelapseDocStepCoverageProof {
            event_uid: "pre-reset-coverage".to_string(),
            session_id: "coverage-session".to_string(),
            content_digest: digest,
        };
        assert!(db
            .with_conn(|conn| {
                should_append_timelapse_body_snapshot(
                    conn,
                    TimelapseDocStepCoverageScope {
                        project_id: "project-a",
                        session_id: "coverage-session",
                        domain: "codex",
                        entity_type: "codex_entry",
                        entity_id: "codex-a",
                    },
                    Some(content),
                    Some(&proof),
                    true,
                )
            })
            .expect("pre-reset coverage must fail closed"));
    }

    #[test]
    fn newer_coverage_invalidates_an_older_proof_without_a_later_step() {
        let db = database();
        let content = r#"{"type":"doc"}"#;
        let digest = timelapse_content_digest(content);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, event_uid, domain, op_type, entity_type, entity_id,
                      payload, session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'old-coverage-step', 'codex', 'doc.step',
                         'codex_entry', 'codex-a', '{}', 'coverage-session', 1, 1,
                         'old-step-prev', 'old-step-hash')",
                [],
            )?;
            insert_coverage_event(
                conn,
                2,
                "old-coverage",
                "coverage-session",
                "codex_entry",
                "codex-a",
                &digest,
            )?;
            let proof = TimelapseDocStepCoverageProof {
                event_uid: "old-coverage".to_string(),
                session_id: "coverage-session".to_string(),
                content_digest: digest.clone(),
            };
            assert!(!should_append_timelapse_body_snapshot(
                conn,
                TimelapseDocStepCoverageScope {
                    project_id: "project-a",
                    session_id: "coverage-session",
                    domain: "codex",
                    entity_type: "codex_entry",
                    entity_id: "codex-a",
                },
                Some(content),
                Some(&proof),
                true,
            )?);

            insert_coverage_event(
                conn,
                3,
                "new-coverage",
                "coverage-session",
                "codex_entry",
                "codex-a",
                &digest,
            )?;
            assert!(should_append_timelapse_body_snapshot(
                conn,
                TimelapseDocStepCoverageScope {
                    project_id: "project-a",
                    session_id: "coverage-session",
                    domain: "codex",
                    entity_type: "codex_entry",
                    entity_id: "codex-a",
                },
                Some(content),
                Some(&proof),
                true,
            )?);
            Ok(())
        })
        .expect("newer coverage must invalidate the old proof");
    }

    #[test]
    fn matching_snapshot_at_or_after_coverage_invalidates_an_old_proof() {
        let content = r#"{"type":"doc","content":[{"text":"C"}]}"#;
        let digest = timelapse_content_digest(content);
        for (snapshot_anchor, snapshot_entity_type) in [(2_i64, Some("codex_entry")), (3_i64, None)]
        {
            let db = database();
            db.with_conn(|conn| {
                // The stale body request can update the canonical table to C
                // before proof validation. The newer snapshot is therefore
                // the only evidence that must force a fresh snapshot.
                conn.execute(
                    "UPDATE codex_entries SET content = ?1
                      WHERE project_id = 'project-a' AND id = 'codex-a'",
                    [content],
                )?;
                conn.execute(
                    "INSERT INTO change_events
                         (project_id, event_uid, domain, op_type, entity_type, entity_id,
                          payload, session_id, sequence, timestamp, prev_hash, hash)
                     VALUES ('project-a', 'snapshot-boundary-step', 'codex', 'doc.step',
                             'codex_entry', 'codex-a', '{}', 'coverage-session', 1, 1,
                             'snapshot-step-prev', 'snapshot-step-hash')",
                    [],
                )?;
                insert_coverage_event(
                    conn,
                    2,
                    "snapshot-boundary-coverage",
                    "coverage-session",
                    "codex_entry",
                    "codex-a",
                    &digest,
                )?;
                conn.execute(
                    "INSERT INTO state_snapshots
                         (project_id, domain, entity_type, entity_id,
                          anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                     VALUES ('project-a', 'codex', ?1, 'codex-a', ?2, ?2, ?3, 'json', ?2)",
                    params![
                        snapshot_entity_type,
                        snapshot_anchor,
                        r#"{"type":"doc","content":[{"text":"D"}]}"#,
                    ],
                )?;
                let proof = TimelapseDocStepCoverageProof {
                    event_uid: "snapshot-boundary-coverage".to_string(),
                    session_id: "coverage-session".to_string(),
                    content_digest: digest.clone(),
                };
                assert!(should_append_timelapse_body_snapshot(
                    conn,
                    TimelapseDocStepCoverageScope {
                        project_id: "project-a",
                        session_id: "coverage-session",
                        domain: "codex",
                        entity_type: "codex_entry",
                        entity_id: "codex-a",
                    },
                    Some(content),
                    Some(&proof),
                    true,
                )?);
                Ok(())
            })
            .expect("snapshot boundary must invalidate stale coverage");
        }
    }

    #[test]
    fn legacy_null_entity_type_snapshot_advances_coverage_boundary() {
        let db = database();
        let content = r#"{"type":"doc"}"#;
        let digest = timelapse_content_digest(content);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id, anchor_sequence,
                      anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'codex', NULL, 'codex-a', 1, 1, '{}', 'json', 1)",
                [],
            )?;
            conn.execute(
                "INSERT INTO change_events
                     (project_id, event_uid, domain, op_type, entity_type, entity_id,
                      payload, session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'legacy-boundary-step', 'codex', 'doc.step',
                         'codex_entry', 'codex-a', '{}', 'coverage-session', 1, 1,
                         'legacy-step-prev', 'legacy-step-hash')",
                [],
            )?;
            insert_coverage_event(
                conn,
                3,
                "legacy-boundary-coverage",
                "coverage-session",
                "codex_entry",
                "codex-a",
                &digest,
            )?;
            let proof = TimelapseDocStepCoverageProof {
                event_uid: "legacy-boundary-coverage".to_string(),
                session_id: "coverage-session".to_string(),
                content_digest: digest,
            };
            assert!(should_append_timelapse_body_snapshot(
                conn,
                TimelapseDocStepCoverageScope {
                    project_id: "project-a",
                    session_id: "coverage-session",
                    domain: "codex",
                    entity_type: "codex_entry",
                    entity_id: "codex-a",
                },
                Some(content),
                Some(&proof),
                true,
            )?);
            Ok(())
        })
        .expect("legacy null entity type must not bypass the boundary");
    }

    #[test]
    fn missing_malformed_mis_scoped_or_nonrenderer_coverage_falls_back_to_snapshot() {
        let content = r#"{"type":"doc"}"#;
        let digest = timelapse_content_digest(content);
        for case in [
            "missing",
            "wrong-event",
            "wrong-session",
            "wrong-digest",
            "wrong-payload-shape",
            "missing-digest",
            "extra-payload-field",
            "non-object-payload",
            "duplicate-payload-field",
            "wrong-entity",
            "nonrenderer",
        ] {
            let db = database();
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO change_events
                         (project_id, event_uid, domain, op_type, entity_type, entity_id,
                          payload, session_id, sequence, timestamp, prev_hash, hash)
                     VALUES ('project-a', 'coverage-step', 'codex', 'doc.step',
                             'codex_entry', 'codex-a', '{}', 'coverage-session', 1, 1,
                             'coverage-step-prev', 'coverage-step-hash')",
                    [],
                )?;
                let coverage_entity_id = if case == "wrong-entity" {
                    "different-codex"
                } else {
                    "codex-a"
                };
                let stored_digest = if case == "wrong-digest"
                    || case == "wrong-payload-shape"
                {
                    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                } else {
                    digest.as_str()
                };
                let payload = match case {
                    "missing-digest" => "{}".to_string(),
                    "extra-payload-field" => {
                        format!(r#"{{"resultContentDigest":"{digest}","extra":true}}"#)
                    }
                    "non-object-payload" => format!(r#""{digest}""#),
                    "duplicate-payload-field" => {
                        format!(r#"{{"resultContentDigest":"{digest}","resultContentDigest":"{digest}"}}"#)
                    }
                    _ => serde_json::json!({ "resultContentDigest": stored_digest }).to_string(),
                };
                insert_raw_coverage_event(
                    conn,
                    2,
                    "coverage-event",
                    "coverage-session",
                    "codex_entry",
                    coverage_entity_id,
                    &payload,
                )?;
                let proof = TimelapseDocStepCoverageProof {
                    event_uid: if case == "wrong-event" {
                        "different-event".to_string()
                    } else {
                        "coverage-event".to_string()
                    },
                    session_id: if case == "wrong-session" {
                        "different-session".to_string()
                    } else {
                        "coverage-session".to_string()
                    },
                    content_digest: if case == "wrong-digest" {
                        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                            .to_string()
                    } else {
                        digest.clone()
                    },
                };
                let proof = (case != "missing").then_some(&proof);
                assert!(
                    should_append_timelapse_body_snapshot(
                        conn,
                        TimelapseDocStepCoverageScope {
                            project_id: "project-a",
                            session_id: "coverage-session",
                            domain: "codex",
                            entity_type: "codex_entry",
                            entity_id: "codex-a",
                        },
                        Some(content),
                        proof,
                        case != "nonrenderer",
                    )?,
                    "{case} must fall back to an atomic snapshot"
                );
                Ok(())
            })
            .expect("validate coverage fallback");
        }
    }

    #[test]
    fn body_baselines_use_trusted_content_and_are_atomic_idempotent_and_tail_bound() {
        let db = database();
        insert_test_tail(&db, "project-a", 7, 700).expect("seed canonical tail");
        let targets = vec![
            TimelapseBodySnapshotTarget::scene("scene-new"),
            TimelapseBodySnapshotTarget::codex("codex-a"),
            TimelapseBodySnapshotTarget::snippet("snippet-a"),
        ];

        let summary = db
            .append_timelapse_body_baselines("project-a", &targets, Some(7))
            .expect("append trusted body baselines");
        assert_eq!(summary.inserted_count, 3);
        assert_eq!(summary.skipped_existing_count, 0);
        assert_eq!(summary.anchor_sequence, 7);
        assert_eq!(summary.anchor_timestamp, 700);
        db.with_conn(|conn| {
            let rows = {
                let mut statement = conn.prepare(
                    "SELECT domain, entity_type, entity_id, anchor_sequence,
                            anchor_timestamp, payload, encoding
                       FROM state_snapshots
                      WHERE project_id = 'project-a'
                      ORDER BY domain, entity_id",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            assert_eq!(
                rows,
                vec![
                    (
                        "codex".to_string(),
                        "codex_entry".to_string(),
                        "codex-a".to_string(),
                        7,
                        700,
                        r#"{"type":"doc"}"#.to_string(),
                        "json".to_string(),
                    ),
                    (
                        "editor".to_string(),
                        "scene".to_string(),
                        "scene-new".to_string(),
                        7,
                        700,
                        r#"{"type":"doc","content":[]}"#.to_string(),
                        "json".to_string(),
                    ),
                    (
                        "snippet".to_string(),
                        "snippet".to_string(),
                        "snippet-a".to_string(),
                        7,
                        700,
                        r#"{"type":"doc"}"#.to_string(),
                        "json".to_string(),
                    ),
                ]
            );
            Ok(())
        })
        .expect("read trusted baseline rows");

        let retry = db
            .append_timelapse_body_baselines("project-a", &targets, Some(7))
            .expect("retry trusted body baselines");
        assert_eq!(retry.inserted_count, 0);
        assert_eq!(retry.skipped_existing_count, 3);

        let count_before_rejection = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("count baselines");
        for (label, invalid_targets, expected_error) in [
            (
                "cross-project",
                vec![
                    TimelapseBodySnapshotTarget::scene("scene-baseline"),
                    TimelapseBodySnapshotTarget::scene("scene-other"),
                ],
                "TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH",
            ),
            (
                "stale",
                vec![TimelapseBodySnapshotTarget::scene("missing")],
                "TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH",
            ),
        ] {
            let error = db
                .append_timelapse_body_baselines("project-a", &invalid_targets, Some(7))
                .expect_err(label);
            assert!(
                error.to_string().contains(expected_error),
                "{label} error: {error:#}"
            );
            let count_after_rejection = db
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?)
                })
                .expect("count after rejected body baseline");
            assert_eq!(count_after_rejection, count_before_rejection);
        }

        let error = db
            .append_timelapse_body_baselines(
                "project-a",
                &[TimelapseBodySnapshotTarget::scene("scene-baseline")],
                Some(6),
            )
            .expect_err("stale renderer tail");
        assert!(error
            .to_string()
            .contains("TIMELAPSE_BODY_SNAPSHOT_ANCHOR_MISMATCH"));
        let count_after_anchor_rejection = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("count after anchor rejection");
        assert_eq!(count_after_anchor_rejection, count_before_rejection);
    }

    #[test]
    fn safe_typed_writers_still_rearm_when_timelapse_is_disabled() {
        let db = database();
        insert_test_tail(&db, "project-a", 3, 300).expect("seed canonical tail");
        db.set_timelapse_enabled("project-a", false)
            .expect("disable timelapse");

        let body_summary = db
            .append_timelapse_body_baselines(
                "project-a",
                &[TimelapseBodySnapshotTarget::scene("scene-new")],
                Some(3),
            )
            .expect("body rearm write");
        assert_eq!(body_summary.inserted_count, 1);
        let layout_summary = db
            .append_timelapse_layout_snapshot(
                "project-a",
                r#"{"layout":{"regions":{}},"activePresetId":null,"hiddenStripePanels":[]}"#,
                Some(3),
            )
            .expect("layout rearm write");
        assert!(layout_summary.inserted);
        db.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots
                  WHERE project_id = 'project-a' AND anchor_sequence = 3",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 2);
            Ok(())
        })
        .expect("read rearm writes");
    }

    #[test]
    fn purge_is_project_scoped_and_rolls_back_both_deletes_on_failure() {
        let db = database();
        insert_test_tail(&db, "project-a", 1, 100).expect("seed project-a event");
        insert_test_tail(&db, "project-b", 1, 200).expect("seed project-b event");
        db.with_conn(|conn| {
            for (project_id, entity_id, domain) in [
                ("project-a", "scene-new", "editor"),
                ("project-a", "workspace", "layout"),
                ("project-b", "scene-other", "editor"),
            ] {
                conn.execute(
                    "INSERT INTO state_snapshots
                         (project_id, domain, entity_type, entity_id,
                          anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                     VALUES (?1, ?2, 'scene', ?3, 1, 100, '{}', 'json', 100)",
                    params![project_id, domain, entity_id],
                )?;
            }
            Ok(())
        })
        .expect("seed purge rows");

        let summary = db
            .purge_timelapse_history("project-a")
            .expect("purge project-a");
        assert_eq!(summary.deleted_event_count, 1);
        assert_eq!(summary.deleted_snapshot_count, 2);
        db.with_conn(|conn| {
            let project_a_events: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events WHERE project_id = 'project-a'",
                [],
                |row| row.get(0),
            )?;
            let project_a_snapshots: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                [],
                |row| row.get(0),
            )?;
            let project_b_events: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events WHERE project_id = 'project-b'",
                [],
                |row| row.get(0),
            )?;
            let project_b_snapshots: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-b'",
                [],
                |row| row.get(0),
            )?;
            let project_a_reset: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'project-a' AND key = 'timelapse.resetSequence'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((project_a_events, project_a_snapshots), (1, 0));
            assert_eq!(project_a_reset, "1");
            assert_eq!((project_b_events, project_b_snapshots), (1, 1));
            Ok(())
        })
        .expect("verify project-scoped purge");

        insert_test_tail(&db, "project-a", 2, 200).expect("seed rollback event");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id,
                      anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', 'scene', 'scene-new', 2, 200, '{}', 'json', 200)",
                [],
            )?;
            conn.execute_batch(
                "CREATE TRIGGER timelapse_purge_rollback
                   BEFORE DELETE ON state_snapshots
                   WHEN OLD.project_id = 'project-a'
                   BEGIN SELECT RAISE(ABORT, 'forced purge rollback'); END;",
            )?;
            Ok(())
        })
        .expect("install purge rollback trigger");
        let error = db
            .purge_timelapse_history("project-a")
            .expect_err("purge trigger failure");
        assert!(error.to_string().contains("forced purge rollback"));
        db.with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER timelapse_purge_rollback")?;
            let events: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events WHERE project_id = 'project-a'",
                [],
                |row| row.get(0),
            )?;
            let snapshots: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                [],
                |row| row.get(0),
            )?;
            let reset: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'project-a' AND key = 'timelapse.resetSequence'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((events, snapshots), (2, 1));
            assert_eq!(reset, "1");
            Ok(())
        })
        .expect("verify purge rollback");
    }

    #[test]
    fn purge_preserves_real_canonical_feed_foreign_keys_and_only_removes_timelapse_rows() {
        let db = database();
        tree_node_create(
            &db,
            TreeNodeCreatePayload {
                id: "canonical-scene".to_string(),
                project_id: "project-a".to_string(),
                request_id: "canonical-tree-create-request".to_string(),
                session_id: "canonical-session".to_string(),
                event_uid: "canonical-tree-create-event".to_string(),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                parent_id: None,
                node_type: "scene".to_string(),
                title: "Canonical Scene".to_string(),
                sort_order: "z".to_string(),
                synopsis: None,
                status: None,
                source_uri: None,
                source_mtime: None,
                content: Some(r#"{"type":"doc","content":[]}"#.to_string()),
                canonical_payload: None,
            },
        )
        .expect("real typed writer canonical event");
        let canonical_sequence = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT sequence FROM change_events
                      WHERE project_id = 'project-a'
                        AND event_uid = 'canonical-tree-create-event'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("canonical event sequence");
        insert_test_tail(&db, "project-a", canonical_sequence + 1, 2_000)
            .expect("seed timelapse-only event");
        insert_test_tail(&db, "project-b", 1, 3_000).expect("seed other project event");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id,
                      anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', 'scene', 'scene-new', ?1, 2000, '{}', 'json', 2000)",
                [canonical_sequence + 1],
            )?;
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id,
                      anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-b', 'editor', 'scene', 'scene-other', 1, 3000, '{}', 'json', 3000)",
                [],
            )?;
            Ok(())
        })
        .expect("seed canonical and timelapse snapshots");

        let summary = db
            .purge_timelapse_history("project-a")
            .expect("purge must preserve canonical feed FKs");
        assert_eq!(summary.deleted_event_count, 2);
        assert_eq!(summary.deleted_snapshot_count, 2);
        db.with_conn(|conn| {
            let canonical_event: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events
                  WHERE project_id = 'project-a' AND event_uid = 'canonical-tree-create-event'",
                [],
                |row| row.get(0),
            )?;
            let canonical_transaction: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = 'project-a'
                    AND source_change_event_uid = 'canonical-tree-create-event'",
                [],
                |row| row.get(0),
            )?;
            let canonical_feed_event: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_events
                  WHERE project_id = 'project-a'
                    AND canonical_change_event_uid = 'canonical-tree-create-event'",
                [],
                |row| row.get(0),
            )?;
            let timelapse_event: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events
                  WHERE project_id = 'project-a' AND sequence = ?1",
                [canonical_sequence + 1],
                |row| row.get(0),
            )?;
            let project_a_snapshots: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                [],
                |row| row.get(0),
            )?;
            let project_b_rows: (i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM change_events WHERE project_id = 'project-b'),
                    (SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-b')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(
                (
                    canonical_event,
                    canonical_transaction,
                    canonical_feed_event,
                    timelapse_event,
                    project_a_snapshots,
                    project_b_rows,
                ),
                (1, 1, 1, 1, 0, (1, 1))
            );
            let reset: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'project-a' AND key = 'timelapse.resetSequence'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(reset, (canonical_sequence + 1).to_string());
            Ok(())
        })
        .expect("verify canonical feed preservation");

        insert_test_tail(&db, "project-a", canonical_sequence + 2, 4_000)
            .expect("seed rollback timelapse event");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id,
                      anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', 'scene', 'scene-new', ?1, 4000, '{}', 'json', 4000)",
                [canonical_sequence + 2],
            )?;
            conn.execute_batch(
                "CREATE TRIGGER timelapse_canonical_purge_rollback
                   BEFORE DELETE ON state_snapshots
                   WHEN OLD.project_id = 'project-a'
                   BEGIN SELECT RAISE(ABORT, 'forced canonical purge rollback'); END;",
            )?;
            Ok(())
        })
        .expect("install canonical purge rollback trigger");
        let error = db
            .purge_timelapse_history("project-a")
            .expect_err("rollback trigger must fail purge");
        assert!(error
            .to_string()
            .contains("forced canonical purge rollback"));
        db.with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER timelapse_canonical_purge_rollback")?;
            let retained: (i64, i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM change_events
                      WHERE project_id = 'project-a'
                        AND sequence = ?1),
                    (SELECT COUNT(*) FROM state_snapshots
                      WHERE project_id = 'project-a'
                        AND anchor_sequence = ?1),
                    (SELECT COUNT(*) FROM change_events
                      WHERE project_id = 'project-a'
                        AND event_uid = 'canonical-tree-create-event')",
                [canonical_sequence + 2],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(retained, (1, 1, 1));
            Ok(())
        })
        .expect("verify canonical purge rollback");
    }

    #[test]
    fn layout_snapshot_is_fixed_scope_schema_size_and_tail_bound() {
        let db = database();
        insert_test_tail(&db, "project-a", 11, 1100).expect("seed layout tail");
        let payload = r#"{"layout":{"regions":{"main":{"size":1}},"active":true},"activePresetId":"focus","hiddenStripePanels":["chat"]}"#;
        let summary = db
            .append_timelapse_layout_snapshot("project-a", payload, None)
            .expect("record layout snapshot");
        assert_eq!(summary.anchor_sequence, 11);
        assert_eq!(summary.anchor_timestamp, 1100);
        db.with_conn(|conn| {
            let row: (String, String, String, i64, i64, String, String) = conn.query_row(
                "SELECT domain, entity_type, entity_id, anchor_sequence,
                        anchor_timestamp, payload, encoding
                   FROM state_snapshots
                  WHERE project_id = 'project-a'",
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
            assert_eq!(row.0, "layout");
            assert_eq!(row.1, "workspace");
            assert_eq!(row.2, "workspace");
            assert_eq!(row.3, 11);
            assert_eq!(row.4, 1100);
            assert_eq!(row.5, payload);
            assert_eq!(row.6, "json");
            Ok(())
        })
        .expect("read fixed layout scope");

        for (invalid_payload, marker) in [
            (
                r#"{"layout":{},"domain":"editor"}"#,
                "unsupported payload field",
            ),
            (r#"{"layout":[]}"#, "layout must be an object"),
            (
                r#"{"activePresetId":"missing-layout"}"#,
                "layout is required",
            ),
        ] {
            let error = db
                .append_timelapse_layout_snapshot("project-a", invalid_payload, Some(11))
                .expect_err("invalid layout payload");
            assert!(error.to_string().contains(marker), "{error:#}");
        }
        let oversized = format!(
            r#"{{"layout":{{"blob":"{}"}}}}"#,
            "x".repeat(MAX_LAYOUT_SNAPSHOT_PAYLOAD_BYTES)
        );
        let error = db
            .append_timelapse_layout_snapshot("project-a", &oversized, Some(11))
            .expect_err("oversized layout payload");
        assert!(error
            .to_string()
            .contains("TIMELAPSE_LAYOUT_SNAPSHOT_TOO_LARGE"));
        let error = db
            .append_timelapse_layout_snapshot("project-a", payload, Some(10))
            .expect_err("stale layout tail");
        assert!(error
            .to_string()
            .contains("TIMELAPSE_LAYOUT_SNAPSHOT_ANCHOR_MISMATCH"));
        let snapshot_count = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM state_snapshots WHERE project_id = 'project-a'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("count layout snapshots");
        assert_eq!(snapshot_count, 1);
    }

    #[test]
    fn enabled_setting_is_project_exact_and_update_failures_preserve_value() {
        let db = database();
        assert_eq!(
            db.set_timelapse_enabled("project-a", true)
                .expect("enable project-a"),
            TimelapseEnabledSetSummary { enabled: true }
        );
        db.with_conn(|conn| {
            let row: (String, i64) = conn.query_row(
                "SELECT value, COUNT(*) FROM project_settings
                  WHERE project_id = 'project-a' AND key = 'timelapse.enabled'
                  GROUP BY value",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(row, ("true".to_string(), 1));
            let other_project: i64 = conn.query_row(
                "SELECT COUNT(*) FROM project_settings WHERE project_id = 'project-b'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(other_project, 0);
            conn.execute_batch(
                "CREATE TRIGGER timelapse_enabled_update_rollback
                   BEFORE UPDATE OF value ON project_settings
                   WHEN OLD.project_id = 'project-a' AND OLD.key = 'timelapse.enabled'
                   BEGIN SELECT RAISE(ABORT, 'forced enabled rollback'); END;",
            )?;
            Ok(())
        })
        .expect("install enabled rollback trigger");
        let error = db
            .set_timelapse_enabled("project-a", false)
            .expect_err("enabled update trigger");
        assert!(error.to_string().contains("forced enabled rollback"));
        db.with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER timelapse_enabled_update_rollback")?;
            let value: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'project-a' AND key = 'timelapse.enabled'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(value, "true");
            Ok(())
        })
        .expect("verify enabled rollback");

        let error = db
            .set_timelapse_enabled("project-missing", true)
            .expect_err("unknown project");
        assert!(error
            .to_string()
            .contains("TIMELAPSE_ENABLED_PROJECT_NOT_FOUND"));
    }
}
