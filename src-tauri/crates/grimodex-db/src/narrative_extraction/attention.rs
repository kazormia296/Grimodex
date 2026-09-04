//! Attention Typed Writer for `narrative_maintenance_attention`.
//!
//! Gate C2 Lane D. Per
//! `policies/narrative/maintenance-attention-contract.json` this storage is
//! `durable-user-state`, `epochBinding: "none"`, and `backflowPolicy:
//! "forbid"` — this module is the sole typed writer for the table and must
//! never touch the Change Feed (`change_events`/`narrative_change_*`).
//! `narrative_maintenance_attention` is registered in
//! `policies/narrative/change-feed-writers.json`'s `EXCLUSION_REASONS` as
//! `non-backflow-invariant`: Run publish, Finding Observation writes, and
//! epoch rotation must never mutate these rows; only this writer sets or
//! clears them.
//!
//! Reads never mutate. [`get_attention`] returns the row exactly as stored,
//! even after a snooze has lapsed (`snoozed_until <= now`) — it is never
//! auto-deleted or rewritten on read. Snooze expiry is a pure computation
//! the caller performs via [`is_attention_applicable`]; deciding what to do
//! with an inapplicable row (e.g. resurfacing it in the Inbox) is a
//! different Lane's responsibility.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;

use super::commit::digest_plan;
use super::finding_identity::{
    material_basis_digest, stable_finding_identity, MaterialBasisInput, BUNDLED_FINDING_RULE_ID,
    BUNDLED_FINDING_RULE_VERSION, MAINTENANCE_FAILURE_FINDING_RULE_ID,
};
use super::task_leases::with_immediate_transaction;
use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, payload_fingerprint, IdempotencyRequest,
};
use crate::Database;

/// Scopes Attention `requestId`s in the shared `idempotency_requests`
/// ledger so they cannot collide with a request id minted by any other
/// surface.
const ATTENTION_IDEMPOTENCY_DOMAIN: &str = "narrative.maintenance-attention";

/// Transaction-owning wrapper over [`set_attention_in_tx`], for callers
/// outside this crate (the N-API boundary). The OCC read and the write it
/// guards must not be separable, so this owns the `BEGIN IMMEDIATE` rather
/// than leaving each caller to remember one.
pub fn set_attention(
    db: &Database,
    request: SetAttentionRequest<'_>,
) -> anyhow::Result<AttentionWriteOutcome> {
    db.with_conn(|conn| with_immediate_transaction(conn, |conn| set_attention_in_tx(conn, request)))
}

/// Transaction-owning wrapper over [`clear_attention_in_tx`]; see
/// [`set_attention`] for why the transaction lives here.
pub fn clear_attention(
    db: &Database,
    project_id: &str,
    finding_key: &str,
    actor_id: &str,
    request_id: &str,
    expected_version: i64,
) -> anyhow::Result<AttentionWriteOutcome> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            clear_attention_in_tx(
                conn,
                project_id,
                finding_key,
                actor_id,
                request_id,
                expected_version,
            )
        })
    })
}

/// Disposition a human or agent has recorded against a Maintenance finding.
///
/// `pub` (not `pub(crate)`): C2-T1 Transport Assembly exposes
/// `set_attention_in_tx`/`clear_attention_in_tx` through
/// `narrative_maintenance_attention_set`/`_clear`, so this type crosses the
/// `grimodex-node` N-API crate boundary as part of that command's payload
/// and (via `AttentionRow`) the Maintenance Inbox response.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionDisposition {
    Snoozed,
    Dismissed,
    Flagged,
}

impl AttentionDisposition {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Snoozed => "snoozed",
            Self::Dismissed => "dismissed",
            Self::Flagged => "flagged",
        }
    }
}

impl TryFrom<&str> for AttentionDisposition {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            "snoozed" => Ok(Self::Snoozed),
            "dismissed" => Ok(Self::Dismissed),
            "flagged" => Ok(Self::Flagged),
            other => anyhow::bail!("unknown attention disposition '{other}'"),
        }
    }
}

/// A `narrative_maintenance_attention` row exactly as stored. Rows are
/// returned as-is by [`get_attention`]; nothing here filters or mutates them.
/// `pub`: reachable from `InboxEntry` (`inbox_read_model.rs`), which
/// crosses the N-API boundary.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct AttentionRow {
    pub project_id: String,
    pub finding_key: String,
    /// Stable Finding identity used for inheritance across a harmless rerun
    /// or epoch rotation. `None` is retained for pre-C2-3 rows.
    pub finding_identity: Option<String>,
    /// `legacy-unresolved` is persisted when migration could not prove that
    /// an old Attention belongs to exactly one current Edge. Such a row is
    /// reported diagnostically and is never silently inherited.
    pub identity_resolution_status: String,
    pub disposition: AttentionDisposition,
    pub material_basis_digest: String,
    pub snoozed_until: Option<String>,
    pub set_at: String,
    /// Who decided this. Mandatory: an Attention row is durable user state,
    /// so an unattributed one is not a meaningful record. Replaces the
    /// nullable `set_by` this table carried before SCHEMA 25.
    pub actor_id: String,
    /// Caller-supplied identity of the request that last wrote this row,
    /// with `payload_digest` of the decision it carried. Provenance, not
    /// the replay record — replay is resolved from the durable
    /// `idempotency_requests` receipt, which survives a `clear` deleting
    /// this row.
    pub request_id: String,
    pub payload_digest: String,
    pub reason: Option<String>,
    /// OCC token. Starts at 1 and increments on every accepted write.
    pub version: i64,
}

/// What one accepted Attention write did.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionWriteOutcome {
    /// The row's version after this call. `0` after a clear.
    pub version: i64,
    /// True when this call matched an already-applied `requestId` and
    /// therefore changed nothing — a retry, not a second decision.
    pub replayed: bool,
}

/// Everything one `set` needs. A struct rather than a long argument list so
/// the OCC token and the request identity cannot be transposed at a call
/// site.
#[derive(Debug, Clone, Copy)]
pub struct SetAttentionRequest<'a> {
    pub project_id: &'a str,
    pub finding_key: &'a str,
    pub disposition: AttentionDisposition,
    pub material_basis_digest: &'a str,
    pub snoozed_until: Option<&'a str>,
    pub set_at: &'a str,
    pub actor_id: &'a str,
    pub request_id: &'a str,
    pub reason: Option<&'a str>,
    /// Expected current `version`; `0` means "no row must exist yet".
    /// Required, not optional — an OCC token a caller may omit is not one.
    pub expected_version: i64,
}

/// Digest of the *decision* this request carries, so a retry of the same
/// `requestId` can be told apart from a different decision reusing it.
///
/// Covers the fields that make the decision what it is, including
/// `actor_id`: a different actor reusing another's `requestId` is a
/// conflict, not a replay. Deliberately excludes `set_at` (a retry is
/// naturally later) and `expected_version` (a retry may legitimately carry
/// a stale one, which is exactly why replay is checked before OCC).
fn attention_payload_digest(request: &SetAttentionRequest<'_>) -> String {
    let canonical = json!({
        "disposition": request.disposition.as_str(),
        "materialBasisDigest": request.material_basis_digest,
        "snoozedUntil": request.snoozed_until,
        "reason": request.reason,
        "actorId": request.actor_id,
    });
    format!("sha256:{}", digest_plan(&canonical))
}

/// Fingerprint of one Attention *request*, as filed in the shared
/// `idempotency_requests` ledger.
///
/// Covers the operation, the row it targets, who decided it, and — for a
/// `set` — [`attention_payload_digest`] of the decision itself. So a
/// `clear` cannot replay a `set` under the same `requestId`, and neither
/// can a different actor: both change the fingerprint, and a changed
/// fingerprint under a known `requestId` is `NEX_ATTENTION_REQUEST_CONFLICT`.
///
/// Excludes `set_at` and `expected_version` for the same reason
/// [`attention_payload_digest`] does: a retry is naturally later and may
/// still carry the OCC token it was first built with.
fn attention_request_fingerprint(
    operation: &str,
    project_id: &str,
    finding_key: &str,
    actor_id: &str,
    decision_digest: Option<&str>,
) -> anyhow::Result<String> {
    payload_fingerprint(
        ATTENTION_IDEMPOTENCY_DOMAIN,
        &json!({
            "operation": operation,
            "projectId": project_id,
            "findingKey": finding_key,
            "actorId": actor_id,
            "decisionDigest": decision_digest,
        }),
    )
}

fn attention_receipt_request<'a>(
    request_id: &'a str,
    payload_hash: &'a str,
) -> IdempotencyRequest<'a> {
    IdempotencyRequest {
        domain: ATTENTION_IDEMPOTENCY_DOMAIN,
        request_id: Some(request_id),
        payload_hash,
        conflict_marker: "NEX_ATTENTION_REQUEST_CONFLICT",
    }
}

/// Resolves a replay from the durable ledger rather than from the Attention
/// row.
///
/// The row cannot be the replay record: `clear` deletes it, so a retry of a
/// clear that already landed would find nothing and — depending on the OCC
/// token it carried — either silently "succeed" against a row someone else
/// has since written, or fail as a version conflict. The ledger entry
/// survives the delete, so the retry replays the answer the original call
/// gave, and the receipt remains as the audit record of who cleared what.
fn replayed_attention_outcome(
    conn: &Connection,
    request: &IdempotencyRequest<'_>,
) -> anyhow::Result<Option<AttentionWriteOutcome>> {
    let Some(receipt) = load_idempotent_response(conn, request)? else {
        return Ok(None);
    };
    let version = receipt
        .get("version")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_ATTENTION_RECEIPT_MALFORMED: the stored receipt for this requestId has no \
                 version"
            )
        })?;
    Ok(Some(AttentionWriteOutcome {
        version,
        replayed: true,
    }))
}

/// Files the durable receipt for an accepted write, in the caller's
/// transaction — so the receipt and the row it describes commit together or
/// not at all.
#[allow(clippy::too_many_arguments)]
fn record_attention_receipt(
    conn: &Connection,
    request: &IdempotencyRequest<'_>,
    operation: &str,
    project_id: &str,
    finding_key: &str,
    actor_id: &str,
    decision_digest: Option<&str>,
    version: i64,
) -> anyhow::Result<()> {
    insert_idempotent_response(
        conn,
        request,
        project_id,
        &json!({
            "operation": operation,
            "projectId": project_id,
            "findingKey": finding_key,
            "actorId": actor_id,
            "payloadDigest": decision_digest,
            "version": version,
        }),
    )
}

fn row_to_attention_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttentionRow> {
    let disposition_raw: String = row.get("disposition")?;
    let disposition =
        AttentionDisposition::try_from(disposition_raw.as_str()).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error.to_string(),
                )),
            )
        })?;
    Ok(AttentionRow {
        project_id: row.get("project_id")?,
        finding_key: row.get("finding_key")?,
        finding_identity: row.get("finding_identity")?,
        identity_resolution_status: row.get("identity_resolution_status")?,
        disposition,
        material_basis_digest: row.get("material_basis_digest")?,
        snoozed_until: row.get("snoozed_until")?,
        set_at: row.get("set_at")?,
        actor_id: row.get("actor_id")?,
        request_id: row.get("request_id")?,
        payload_digest: row.get("payload_digest")?,
        reason: row.get("reason")?,
        version: row.get("version")?,
    })
}

const ATTENTION_COLUMNS: &str = "project_id, finding_key, finding_identity, identity_resolution_status,
     disposition, material_basis_digest, snoozed_until, set_at, actor_id, request_id, payload_digest,
     reason, version";

/// Resolve a stable identity when the current diagnostic history has exactly
/// one subject for this consumer. Multiple Edge findings are intentionally
/// ambiguous and return `None`; preserving that ambiguity prevents one
/// Attention decision from being inherited by an unrelated Edge.
fn current_finding_identity(
    conn: &Connection,
    project_id: &str,
    finding_key: &str,
    material_basis_digest: &str,
) -> anyhow::Result<Option<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT finding_identity
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND finding_key = ?2
            AND material_basis_digest = ?3
            AND finding_identity IS NOT NULL AND finding_identity <> ''
          ORDER BY finding_identity ASC",
    )?;
    let identities = statement
        .query_map(
            params![project_id, finding_key, material_basis_digest],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    match identities.as_slice() {
        [identity] => Ok(Some(identity.clone())),
        // A Finding key is a consumer-facing label, not proof of the Edge
        // subject. Leave the identity unresolved until an observation gives
        // us a unique Edge-backed subject.
        [] => Ok(None),
        _ => Ok(None),
    }
}

/// Upsert a Maintenance Attention row. `snoozed_until` is required exactly
/// when `disposition` is [`AttentionDisposition::Snoozed`] and is stored as
/// `NULL` for every other disposition, even if the caller passed one in —
/// a stale snooze timestamp must not survive a disposition change.
///
/// This function never appends to the Change Feed: `narrative_maintenance_attention`
/// is `backflowPolicy: "forbid"` durable user state, not Change Feed output.
///
/// `pub`: called directly from `grimodex-node`'s
/// `narrative_maintenance_attention_set` N-API binding (C2-T1).
pub fn set_attention_in_tx(
    conn: &Connection,
    request: SetAttentionRequest<'_>,
) -> anyhow::Result<AttentionWriteOutcome> {
    anyhow::ensure!(
        !request.project_id.trim().is_empty(),
        "projectId is required"
    );
    anyhow::ensure!(
        !request.finding_key.trim().is_empty(),
        "findingKey is required"
    );
    anyhow::ensure!(
        !request.material_basis_digest.trim().is_empty(),
        "materialBasisDigest is required"
    );
    anyhow::ensure!(!request.set_at.trim().is_empty(), "setAt is required");
    anyhow::ensure!(!request.actor_id.trim().is_empty(), "actorId is required");
    anyhow::ensure!(
        !request.request_id.trim().is_empty(),
        "requestId is required"
    );
    anyhow::ensure!(
        request.expected_version >= 0,
        "NEX_ATTENTION_VERSION_INVALID: expectedVersion must not be negative"
    );

    let stored_snoozed_until = match request.disposition {
        AttentionDisposition::Snoozed => {
            let value = request
                .snoozed_until
                .filter(|value| !value.trim().is_empty());
            anyhow::ensure!(
                value.is_some(),
                "snoozedUntil is required when disposition is 'snoozed'"
            );
            value
        }
        AttentionDisposition::Dismissed | AttentionDisposition::Flagged => None,
    };

    let payload_digest = attention_payload_digest(&request);
    let fingerprint = attention_request_fingerprint(
        "set",
        request.project_id,
        request.finding_key,
        request.actor_id,
        Some(&payload_digest),
    )?;
    let receipt = attention_receipt_request(request.request_id, &fingerprint);

    // Replay is resolved before OCC on purpose: a retry of a request that
    // already landed may carry the expectedVersion it was first built with,
    // which is now stale. Treating that as a conflict would make retries
    // impossible, which is the opposite of what request identity is for.
    if let Some(outcome) = replayed_attention_outcome(conn, &receipt)? {
        return Ok(outcome);
    }

    let existing = get_attention(conn, request.project_id, request.finding_key)?;
    let current_version = existing.as_ref().map_or(0, |row| row.version);
    anyhow::ensure!(
        current_version == request.expected_version,
        "NEX_ATTENTION_VERSION_CONFLICT: finding '{}' in project '{}' is at version {} but the \
         caller expected {}; re-read the row and retry",
        request.finding_key,
        request.project_id,
        current_version,
        request.expected_version
    );

    let next_version = current_version + 1;
    let finding_identity = current_finding_identity(
        conn,
        request.project_id,
        request.finding_key,
        request.material_basis_digest,
    )?;
    let identity_resolution_status = if finding_identity.is_some() {
        "resolved"
    } else {
        "unresolved"
    };
    let updated = conn.execute(
        "INSERT INTO narrative_maintenance_attention
            (project_id, finding_key, finding_identity, identity_resolution_status,
             disposition, material_basis_digest, snoozed_until, set_at, actor_id, request_id,
             payload_digest, reason, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(project_id, finding_key) DO UPDATE SET
            finding_identity = excluded.finding_identity,
            identity_resolution_status = excluded.identity_resolution_status,
            disposition = excluded.disposition,
            material_basis_digest = excluded.material_basis_digest,
            snoozed_until = excluded.snoozed_until,
            set_at = excluded.set_at,
            actor_id = excluded.actor_id,
            request_id = excluded.request_id,
            payload_digest = excluded.payload_digest,
            reason = excluded.reason,
            version = excluded.version
          WHERE narrative_maintenance_attention.version = ?14",
        params![
            request.project_id,
            request.finding_key,
            finding_identity,
            identity_resolution_status,
            request.disposition.as_str(),
            request.material_basis_digest,
            stored_snoozed_until,
            request.set_at,
            request.actor_id,
            request.request_id,
            payload_digest,
            request.reason,
            next_version,
            current_version,
        ],
    )?;
    // Defence in depth: the WHERE on the DO UPDATE re-checks the same
    // version inside the write, so a racing writer that slipped between the
    // read above and this statement loses here instead of silently winning.
    anyhow::ensure!(
        updated == 1,
        "NEX_ATTENTION_VERSION_CONFLICT: finding '{}' in project '{}' changed while this write \
         was in flight; re-read the row and retry",
        request.finding_key,
        request.project_id
    );

    record_attention_receipt(
        conn,
        &receipt,
        "set",
        request.project_id,
        request.finding_key,
        request.actor_id,
        Some(&payload_digest),
        next_version,
    )?;

    Ok(AttentionWriteOutcome {
        version: next_version,
        replayed: false,
    })
}

/// Clear (delete) a Maintenance Attention row under the same OCC token the
/// setter uses. Clearing an absent row is a no-op success only when the
/// caller expected it to be absent (`expected_version == 0`); clearing a row
/// that has moved on since the caller read it is a conflict, not a silent
/// delete.
///
/// Leaves a durable receipt in `idempotency_requests` in this same
/// transaction. Two reasons the row itself cannot serve that purpose:
///
/// - a retry of a clear that already landed finds no row, so without the
///   receipt it has no way to tell "I already did this" from "someone else
///   has since written a row here";
/// - the delete destroys the only record of who cleared the finding and
///   under what request. The receipt keeps that, which is the point of
///   requiring an `actorId` on durable user state at all.
///
/// `pub`: called directly from `grimodex-node`'s
/// `narrative_maintenance_attention_clear` N-API binding (C2-T1).
pub fn clear_attention_in_tx(
    conn: &Connection,
    project_id: &str,
    finding_key: &str,
    actor_id: &str,
    request_id: &str,
    expected_version: i64,
) -> anyhow::Result<AttentionWriteOutcome> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!finding_key.trim().is_empty(), "findingKey is required");
    anyhow::ensure!(!actor_id.trim().is_empty(), "actorId is required");
    anyhow::ensure!(!request_id.trim().is_empty(), "requestId is required");
    anyhow::ensure!(
        expected_version >= 0,
        "NEX_ATTENTION_VERSION_INVALID: expectedVersion must not be negative"
    );

    let fingerprint =
        attention_request_fingerprint("clear", project_id, finding_key, actor_id, None)?;
    let receipt = attention_receipt_request(request_id, &fingerprint);

    // Before OCC, for the same reason as in `set_attention_in_tx`: a retry
    // carries the token it was first built with, and after a successful
    // clear that token no longer describes anything.
    if let Some(outcome) = replayed_attention_outcome(conn, &receipt)? {
        return Ok(outcome);
    }

    let current_version =
        get_attention(conn, project_id, finding_key)?.map_or(0, |row| row.version);
    anyhow::ensure!(
        current_version == expected_version,
        "NEX_ATTENTION_VERSION_CONFLICT: finding '{finding_key}' in project '{project_id}' is at \
         version {current_version} but the caller expected {expected_version}; re-read the row \
         and retry"
    );

    if current_version > 0 {
        let deleted = conn.execute(
            "DELETE FROM narrative_maintenance_attention
              WHERE project_id = ?1 AND finding_key = ?2 AND version = ?3",
            params![project_id, finding_key, expected_version],
        )?;
        anyhow::ensure!(
            deleted == 1,
            "NEX_ATTENTION_VERSION_CONFLICT: finding '{finding_key}' in project '{project_id}' \
             changed while this clear was in flight; re-read the row and retry"
        );
    }
    // `current_version == 0` is a clear of an absent row the caller
    // correctly expected to be absent: nothing to delete, but still a
    // request that happened and still gets a receipt, so its retry replays
    // instead of racing whatever is written next.

    record_attention_receipt(
        conn,
        &receipt,
        "clear",
        project_id,
        finding_key,
        actor_id,
        None,
        0,
    )?;

    Ok(AttentionWriteOutcome {
        version: 0,
        replayed: false,
    })
}

/// Read a Maintenance Attention row exactly as stored. Never mutates,
/// deletes, or filters on expiry — the row survives a lapsed snooze until
/// the typed writer above clears or resets it.
pub(crate) fn get_attention(
    conn: &Connection,
    project_id: &str,
    finding_key: &str,
) -> anyhow::Result<Option<AttentionRow>> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {ATTENTION_COLUMNS}
                   FROM narrative_maintenance_attention
                  WHERE project_id = ?1 AND finding_key = ?2"
            ),
            params![project_id, finding_key],
            row_to_attention_row,
        )
        .optional()?;
    Ok(row)
}

/// Re-home a legacy orphan only when the old Attention material digest maps to
/// exactly one Finding Observation, whose Edge identifies exactly one current
/// Consumer. A consumer's owning Run is only a candidate hint and is not
/// sufficient proof: the old digest -> Observation -> Edge chain is the
/// identity-preserving evidence. This is a migration-only repair; ambiguous,
/// missing, and target-conflicting rows remain untouched and are reported.
/// Attention exactly linked to a terminal maintenance-failure Observation is
/// durable Inbox output, not an orphaned graph Consumer, and remains untouched
/// without being reported as a migration ambiguity.
pub(crate) fn rehome_orphaned_attention_in_tx(conn: &Connection) -> anyhow::Result<Vec<String>> {
    let mapping_tables_available: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'narrative_dependency_edges'
        ) AND EXISTS(
            SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'narrative_maintenance_finding_observations'
        )",
        [],
        |row| row.get(0),
    )?;
    if !mapping_tables_available {
        let rows: Vec<String> = conn
            .prepare(
                "SELECT project_id || ':' || finding_key
                   FROM narrative_maintenance_attention
                  ORDER BY project_id, finding_key",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(rows
            .into_iter()
            .map(|key| format!("{key} (mapping-tables-unavailable)"))
            .collect());
    }
    let orphan_rows: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT a.project_id, a.finding_key, a.material_basis_digest
               FROM narrative_maintenance_attention a
              WHERE NOT EXISTS (
                    SELECT 1 FROM narrative_dependency_edges e
                     WHERE e.project_id = a.project_id
                       AND e.consumer_kind || ':' || e.consumer_key = a.finding_key
              )
                AND NOT EXISTS (
                    SELECT 1
                      FROM narrative_maintenance_finding_observations o
                     WHERE o.project_id = a.project_id
                       AND o.finding_key = a.finding_key
                       AND o.finding_identity = a.finding_identity
                       AND o.material_basis_digest = a.material_basis_digest
                       AND o.rule_id = ?1
                )
              ORDER BY a.project_id, a.finding_key",
        )?
        .query_map([MAINTENANCE_FAILURE_FINDING_RULE_ID], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut unresolved = Vec::new();

    for (project_id, old_finding_key, old_material_basis_digest) in orphan_rows {
        let candidates: Vec<(String, String, String, String, String)> = conn
            .prepare(
                "SELECT DISTINCT e.consumer_kind || ':' || e.consumer_key,
                        COALESCE(NULLIF(o.finding_identity, ''), ''), e.id,
                        o.reason_code, o.evidence_freshness_snapshot
                   FROM narrative_dependency_edges e
                   JOIN narrative_maintenance_finding_observations o
                     ON o.project_id = e.project_id
                    AND o.edge_id = e.id
                    AND o.material_basis_digest = ?2
                    AND o.finding_key = ?3
                  WHERE e.project_id = ?1
                    AND e.consumer_kind || ':' || e.consumer_key <> ?3
                  ORDER BY 1",
            )?
            .query_map(
                params![project_id, old_material_basis_digest, old_finding_key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        if candidates.len() != 1 {
            unresolved.push(format!(
                "{project_id}:{old_finding_key} (exact-candidate-count={})",
                candidates.len()
            ));
            continue;
        }
        let (new_finding_key, observed_identity, edge_id, reason_code, freshness) =
            candidates[0].clone();
        let target_exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM narrative_maintenance_attention
                 WHERE project_id = ?1 AND finding_key = ?2
            )",
            params![project_id, new_finding_key],
            |row| row.get(0),
        )?;
        if target_exists {
            unresolved.push(format!(
                "{project_id}:{old_finding_key} (target-conflict={new_finding_key})"
            ));
            continue;
        }

        let finding_identity = stable_finding_identity(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &edge_id,
        )?;
        if !observed_identity.is_empty() && observed_identity != finding_identity {
            unresolved.push(format!(
                "{project_id}:{old_finding_key} (observation-identity-mismatch)"
            ));
            continue;
        }
        let new_material_basis_digest = material_basis_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &MaterialBasisInput {
                stable_subject: &edge_id,
                edge_id: Some(&edge_id),
                failure_code: None,
                reason_code: &reason_code,
                evidence_freshness: &freshness,
                evidence_detail_digest: None,
            },
        )?;
        conn.execute(
            "UPDATE narrative_maintenance_attention
                SET finding_key = ?1, finding_identity = ?2,
                    identity_resolution_status = 'resolved',
                    material_basis_digest = ?3
              WHERE project_id = ?4 AND finding_key = ?5",
            params![
                new_finding_key,
                finding_identity,
                new_material_basis_digest,
                project_id,
                old_finding_key
            ],
        )?;
    }
    Ok(unresolved)
}

/// Pure computation of `applicationConditions` from
/// `maintenance-attention-contract.json`, minus `finding-key-match` (the
/// caller already looked the row up by finding key). No DB access.
///
/// - `material-basis-digest-match`: the row's `material_basis_digest` must
///   equal `current_material_basis_digest` — a stale finding no longer
///   applies once its underlying evidence has moved.
/// - `finding-identity-resolved`: migration-preserved legacy rows whose Edge
///   identity cannot be proved are diagnostic only and never apply.
/// - `snooze-not-expired`: only meaningful for
///   [`AttentionDisposition::Snoozed`]; the row applies only while
///   `snoozed_until > now`. Dismissed/Flagged rows have no expiry and apply
///   as long as the digest matches.
pub(crate) fn is_attention_applicable(
    row: &AttentionRow,
    current_material_basis_digest: &str,
    now: &str,
) -> bool {
    if row.identity_resolution_status != "resolved" {
        return false;
    }
    if row.material_basis_digest != current_material_basis_digest {
        return false;
    }
    match row.disposition {
        AttentionDisposition::Snoozed => match row.snoozed_until.as_deref() {
            Some(snoozed_until) => snoozed_until > now,
            None => false,
        },
        AttentionDisposition::Dismissed | AttentionDisposition::Flagged => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use rusqlite::params;
    use std::path::Path;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('proj-1', 'Project 1')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        db
    }

    fn seed_orphan_mapping(
        db: &Database,
        edge_id: &str,
        consumer_key: &str,
        observation_id: &str,
        old_material_basis_digest: &str,
        finding_identity: &str,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-attention-rehome', 'proj-1', 1, 'initial',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at, owning_run_id)
                 VALUES (?1, 'proj-1', 'proposal-revision', ?2,
                         'project:scene:scene-1', '[]',
                         '2026-08-15T00:00:00.000Z', 'old')",
                params![edge_id, consumer_key],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES (?1, 'proj-1', 'run-old', 'epoch-attention-rehome', ?2,
                         'legacy:old', 'source-missing', 'source-missing',
                         ?3, '2026-08-15T00:00:00.000Z', ?4,
                         'narrative.consumer-freshness', 1, 'observation-old')",
                params![
                    observation_id,
                    edge_id,
                    old_material_basis_digest,
                    finding_identity
                ],
            )?;
            Ok(())
        })
        .expect("seed exact attention mapping");
    }

    fn seed_orphan_attention(db: &Database, material_basis_digest: &str, request_id: &str) {
        let mut request = request(
            AttentionDisposition::Dismissed,
            material_basis_digest,
            None,
            request_id,
            0,
        );
        request.finding_key = "legacy:old";
        db.with_conn(|conn| set_attention_in_tx(conn, request))
            .expect("seed orphan attention");
    }

    fn stable_test_identity(edge_id: &str) -> String {
        stable_finding_identity(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            edge_id,
        )
        .expect("stable identity")
    }

    #[test]
    fn attention_identity_resolution_uses_the_requested_material_basis() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-attention-identity', 'proj-1', 1, 'initial',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            for (id, digest, identity) in [
                (
                    "observation-identity-exact",
                    "digest-exact",
                    "identity-exact",
                ),
                (
                    "observation-identity-other",
                    "digest-other",
                    "identity-other",
                ),
            ] {
                conn.execute(
                    "INSERT INTO narrative_maintenance_finding_observations
                        (id, project_id, run_id, semantic_epoch_id, edge_id,
                         finding_key, reason_code, evidence_freshness_snapshot,
                         material_basis_digest, observed_at, finding_identity,
                         rule_id, rule_version, observation_digest)
                     VALUES (?1, 'proj-1', 'run-identity', 'epoch-attention-identity',
                             NULL, 'finding-a', 'source-missing', 'source-missing',
                             ?2, '2026-08-15T00:00:00.000Z', ?3,
                             'narrative.consumer-freshness', 1, 'observation-digest')",
                    params![id, digest, identity],
                )?;
            }
            Ok(())
        })
        .expect("seed material-specific identities");

        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-exact",
                    None,
                    "req-material-exact",
                    0,
                ),
            )
        })
        .expect("set exact material Attention");
        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("read exact material Attention")
            .expect("Attention row");
        assert_eq!(row.finding_identity.as_deref(), Some("identity-exact"));
    }

    #[test]
    fn attention_identity_is_cleared_when_new_material_is_ambiguous() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-attention-ambiguity', 'proj-1', 1, 'initial',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            for (id, digest, identity) in [
                (
                    "observation-identity-initial",
                    "digest-initial",
                    "identity-initial",
                ),
                (
                    "observation-identity-ambiguous-a",
                    "digest-ambiguous",
                    "identity-a",
                ),
                (
                    "observation-identity-ambiguous-b",
                    "digest-ambiguous",
                    "identity-b",
                ),
            ] {
                conn.execute(
                    "INSERT INTO narrative_maintenance_finding_observations
                        (id, project_id, run_id, semantic_epoch_id, edge_id,
                         finding_key, reason_code, evidence_freshness_snapshot,
                         material_basis_digest, observed_at, finding_identity,
                         rule_id, rule_version, observation_digest)
                     VALUES (?1, 'proj-1', 'run-identity', 'epoch-attention-ambiguity',
                             NULL, 'finding-a', 'source-missing', 'source-missing',
                             ?2, '2026-08-15T00:00:00.000Z', ?3,
                             'narrative.consumer-freshness', 1, 'observation-digest')",
                    params![id, digest, identity],
                )?;
            }
            Ok(())
        })
        .expect("seed ambiguous material identities");

        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-initial",
                    None,
                    "req-material-initial",
                    0,
                ),
            )
        })
        .expect("set initial material Attention");
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-ambiguous",
                    None,
                    "req-material-ambiguous",
                    1,
                ),
            )
        })
        .expect("set ambiguous material Attention");

        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("read ambiguous material Attention")
            .expect("Attention row");
        assert_eq!(row.finding_identity, None);
        assert_eq!(row.material_basis_digest, "digest-ambiguous");
    }

    #[test]
    fn orphan_rehome_uses_unique_digest_observation_edge_mapping_and_converts_digest() {
        let db = fixture();
        seed_orphan_mapping(
            &db,
            "edge-rehome-1",
            "revision-1",
            "observation-rehome-1",
            "legacy-material",
            &stable_test_identity("edge-rehome-1"),
        );
        seed_orphan_attention(&db, "legacy-material", "req-orphan-rehome");

        let unresolved = db
            .with_conn(rehome_orphaned_attention_in_tx)
            .expect("rehome orphan attention");
        assert!(unresolved.is_empty(), "unique mapping should be moved");

        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "proposal-revision:revision-1"))
            .expect("read rehomed attention")
            .expect("rehomed row");
        assert_eq!(
            row.finding_identity.as_deref(),
            Some(stable_test_identity("edge-rehome-1").as_str())
        );
        assert_ne!(row.material_basis_digest, "legacy-material");
        assert!(db
            .with_conn(|conn| get_attention(conn, "proj-1", "legacy:old"))
            .expect("read old attention")
            .is_none());
    }

    #[test]
    fn orphan_rehome_ignores_attention_exactly_linked_to_terminal_output() {
        let db = fixture();
        let finding_key = "narrative-maintenance-failure:verify:verify:epoch-1";
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-terminal-attention', 'proj-1', 1, 'initial',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES ('terminal-failure:v1:NEX_MAINTENANCE_UNCLASSIFIED:run-terminal',
                         'proj-1', 'run-terminal', 'epoch-terminal-attention', NULL, ?1,
                         'component-incompatible', 'unknown', 'terminal-material',
                         '2026-08-15T00:00:00.000Z', 'terminal-identity', ?2, 1,
                         'terminal-observation')",
                params![finding_key, MAINTENANCE_FAILURE_FINDING_RULE_ID],
            )?;
            let mut attention = request(
                AttentionDisposition::Dismissed,
                "terminal-material",
                None,
                "req-terminal-attention",
                0,
            );
            attention.finding_key = finding_key;
            set_attention_in_tx(conn, attention)?;
            Ok(())
        })
        .expect("seed exact terminal Attention output");

        let unresolved = db
            .with_conn(rehome_orphaned_attention_in_tx)
            .expect("run orphan rehome");
        assert!(
            unresolved.is_empty(),
            "terminal Inbox output is not a graph orphan to migrate"
        );
        let preserved = db
            .with_conn(|conn| get_attention(conn, "proj-1", finding_key))
            .expect("read terminal Attention")
            .expect("terminal Attention must remain durable");
        assert_eq!(
            preserved.finding_identity.as_deref(),
            Some("terminal-identity")
        );
        assert_eq!(preserved.material_basis_digest, "terminal-material");
    }

    #[test]
    fn orphan_rehome_preserves_ambiguous_digest_mappings() {
        let db = fixture();
        seed_orphan_mapping(
            &db,
            "edge-rehome-ambiguous-1",
            "revision-1",
            "observation-rehome-ambiguous-1",
            "legacy-material",
            &stable_test_identity("edge-rehome-ambiguous-1"),
        );
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at, owning_run_id)
                 VALUES ('edge-rehome-ambiguous-2', 'proj-1', 'proposal-revision',
                         'revision-2', 'project:scene:scene-2', '[]',
                         '2026-08-15T00:00:00.000Z', 'old')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES ('observation-rehome-ambiguous-2', 'proj-1', 'run-old',
                         'epoch-attention-rehome', 'edge-rehome-ambiguous-2',
                         'legacy:old', 'source-missing', 'source-missing',
                         'legacy-material', '2026-08-15T00:00:00.000Z',
                         ?1, 'narrative.consumer-freshness', 1,
                         'observation-old-2')",
                params![stable_test_identity("edge-rehome-ambiguous-2")],
            )?;
            Ok(())
        })
        .expect("seed ambiguous mapping");
        seed_orphan_attention(&db, "legacy-material", "req-orphan-ambiguous");

        let unresolved = db
            .with_conn(rehome_orphaned_attention_in_tx)
            .expect("inspect ambiguous orphan attention");
        assert_eq!(unresolved.len(), 1);
        let old = db
            .with_conn(|conn| get_attention(conn, "proj-1", "legacy:old"))
            .expect("read preserved orphan")
            .expect("ambiguous row must remain");
        assert_eq!(old.material_basis_digest, "legacy-material");
        assert!(db
            .with_conn(|conn| get_attention(conn, "proj-1", "proposal-revision:revision-1"))
            .expect("read ambiguous target")
            .is_none());
        assert!(db
            .with_conn(|conn| get_attention(conn, "proj-1", "proposal-revision:revision-2"))
            .expect("read ambiguous target")
            .is_none());
    }

    #[test]
    fn orphan_rehome_preserves_digest_mapping_when_target_attention_conflicts() {
        let db = fixture();
        seed_orphan_mapping(
            &db,
            "edge-rehome-conflict-1",
            "revision-conflict",
            "observation-rehome-conflict-1",
            "legacy-material",
            &stable_test_identity("edge-rehome-conflict-1"),
        );
        seed_orphan_attention(&db, "legacy-material", "req-orphan-conflict");
        let mut target_request = request(
            AttentionDisposition::Flagged,
            "target-material",
            None,
            "req-target-conflict",
            0,
        );
        target_request.finding_key = "proposal-revision:revision-conflict";
        db.with_conn(|conn| set_attention_in_tx(conn, target_request))
            .expect("seed target attention");

        let unresolved = db
            .with_conn(rehome_orphaned_attention_in_tx)
            .expect("inspect conflicting orphan attention");
        assert_eq!(unresolved.len(), 1);
        let old = db
            .with_conn(|conn| get_attention(conn, "proj-1", "legacy:old"))
            .expect("read preserved orphan")
            .expect("conflicting row must remain");
        assert_eq!(old.material_basis_digest, "legacy-material");
        let target = db
            .with_conn(|conn| get_attention(conn, "proj-1", "proposal-revision:revision-conflict"))
            .expect("read target attention")
            .expect("existing target remains");
        assert_eq!(target.material_basis_digest, "target-material");
    }

    #[test]
    fn orphan_rehome_ignores_same_digest_observations_for_another_finding() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-attention-cross-finding', 'proj-1', 1, 'initial',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at, owning_run_id)
                 VALUES ('edge-cross-finding', 'proj-1', 'proposal-revision',
                         'revision-cross-finding', 'project:scene:scene-cross', '[]',
                         '2026-08-15T00:00:00.000Z', 'old')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES ('observation-cross-finding', 'proj-1', 'run-old',
                         'epoch-attention-cross-finding', 'edge-cross-finding',
                         'legacy:other', 'source-missing', 'source-missing',
                         'legacy-material', '2026-08-15T00:00:00.000Z',
                         'stable-other', 'narrative.consumer-freshness', 1,
                         'observation-cross-finding')",
                [],
            )?;
            Ok(())
        })
        .expect("seed cross-finding observation");
        seed_orphan_attention(&db, "legacy-material", "req-orphan-cross-finding");

        let unresolved = db
            .with_conn(rehome_orphaned_attention_in_tx)
            .expect("inspect cross-finding orphan");
        assert_eq!(unresolved.len(), 1);
        assert!(db
            .with_conn(|conn| get_attention(conn, "proj-1", "legacy:old"))
            .expect("read preserved cross-finding orphan")
            .is_some());
    }

    /// Minimal valid request; tests override just the field under test.
    fn request<'a>(
        disposition: AttentionDisposition,
        material_basis_digest: &'a str,
        snoozed_until: Option<&'a str>,
        request_id: &'a str,
        expected_version: i64,
    ) -> SetAttentionRequest<'a> {
        SetAttentionRequest {
            project_id: "proj-1",
            finding_key: "finding-a",
            disposition,
            material_basis_digest,
            snoozed_until,
            set_at: "2026-08-15T00:00:00.000Z",
            actor_id: "user-1",
            request_id,
            reason: None,
            expected_version,
        }
    }

    /// A `dismissed` set against a named finding, for the receipt tests
    /// (which care about the request identity, not the disposition).
    fn dismiss_request<'a>(
        finding_key: &'a str,
        request_id: &'a str,
        expected_version: i64,
    ) -> SetAttentionRequest<'a> {
        SetAttentionRequest {
            finding_key,
            ..request(
                AttentionDisposition::Dismissed,
                "digest-1",
                None,
                request_id,
                expected_version,
            )
        }
    }

    #[test]
    fn set_get_clear_round_trip() {
        let db = fixture();
        let outcome = db
            .with_conn(|conn| {
                set_attention_in_tx(
                    conn,
                    request(
                        AttentionDisposition::Snoozed,
                        "digest-1",
                        Some("2026-09-01T00:00:00.000Z"),
                        "req-1",
                        0,
                    ),
                )
            })
            .expect("set attention");
        assert_eq!(outcome.version, 1);
        assert!(!outcome.replayed);

        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row exists");
        assert_eq!(row.disposition, AttentionDisposition::Snoozed);
        assert_eq!(row.material_basis_digest, "digest-1");
        assert_eq!(
            row.snoozed_until.as_deref(),
            Some("2026-09-01T00:00:00.000Z")
        );
        assert_eq!(row.actor_id, "user-1");
        assert_eq!(row.request_id, "req-1");
        assert_eq!(row.version, 1);

        db.with_conn(|conn| {
            clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-2", 1)
        })
        .expect("clear attention");
        let cleared = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention after clear");
        assert!(cleared.is_none());
    }

    #[test]
    fn set_upserts_and_clears_stale_snoozed_until_on_disposition_change() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Snoozed,
                    "digest-1",
                    Some("2026-09-01T00:00:00.000Z"),
                    "req-1",
                    0,
                ),
            )
        })
        .expect("set snoozed");

        let outcome = db
            .with_conn(|conn| {
                let mut next = request(
                    AttentionDisposition::Dismissed,
                    "digest-2",
                    None,
                    "req-2",
                    1,
                );
                next.actor_id = "user-2";
                set_attention_in_tx(conn, next)
            })
            .expect("set dismissed");
        assert_eq!(outcome.version, 2);

        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row exists");
        assert_eq!(row.disposition, AttentionDisposition::Dismissed);
        assert_eq!(row.material_basis_digest, "digest-2");
        assert_eq!(row.snoozed_until, None);
        assert_eq!(row.actor_id, "user-2");
        assert_eq!(row.version, 2);
    }

    #[test]
    fn snoozed_disposition_requires_snoozed_until() {
        let db = fixture();
        let result = db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(AttentionDisposition::Snoozed, "digest-1", None, "req-1", 0),
            )
        });
        assert!(result.is_err());
    }

    #[test]
    fn snoozed_disposition_rejects_blank_snoozed_until() {
        let db = fixture();
        let result = db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Snoozed,
                    "digest-1",
                    Some("   "),
                    "req-1",
                    0,
                ),
            )
        });
        assert!(result.is_err());
    }

    // -- OCC / request idempotency / mandatory actor ------------------------

    #[test]
    fn set_rejects_a_stale_expected_version() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-1",
                    None,
                    "req-1",
                    0,
                ),
            )
        })
        .expect("first set");

        // A second window still believes the row does not exist.
        let error = db
            .with_conn(|conn| {
                set_attention_in_tx(
                    conn,
                    request(AttentionDisposition::Flagged, "digest-1", None, "req-2", 0),
                )
            })
            .expect_err("stale expectedVersion must be rejected");
        assert!(
            error.to_string().contains("NEX_ATTENTION_VERSION_CONFLICT"),
            "unexpected error: {error}"
        );

        // The first decision is untouched -- no silent last-write-wins.
        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row exists");
        assert_eq!(row.disposition, AttentionDisposition::Dismissed);
        assert_eq!(row.version, 1);
    }

    #[test]
    fn replaying_the_same_request_id_is_a_no_op_even_with_a_stale_expected_version() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-1",
                    None,
                    "req-1",
                    0,
                ),
            )
        })
        .expect("first set");

        // The retry carries the expectedVersion it was originally built
        // with (0), which is now stale -- a replay, not a conflict.
        let outcome = db
            .with_conn(|conn| {
                set_attention_in_tx(
                    conn,
                    request(
                        AttentionDisposition::Dismissed,
                        "digest-1",
                        None,
                        "req-1",
                        0,
                    ),
                )
            })
            .expect("replay must succeed");
        assert!(outcome.replayed);
        assert_eq!(outcome.version, 1);

        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row exists");
        assert_eq!(row.version, 1, "a replay must not bump the version");
    }

    #[test]
    fn reusing_a_request_id_for_a_different_decision_is_a_conflict() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-1",
                    None,
                    "req-1",
                    0,
                ),
            )
        })
        .expect("first set");

        let error = db
            .with_conn(|conn| {
                set_attention_in_tx(
                    conn,
                    request(AttentionDisposition::Flagged, "digest-1", None, "req-1", 1),
                )
            })
            .expect_err("same requestId with a different decision must be rejected");
        assert!(
            error.to_string().contains("NEX_ATTENTION_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_different_actor_reusing_a_request_id_is_a_conflict_not_a_replay() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-1",
                    None,
                    "req-1",
                    0,
                ),
            )
        })
        .expect("first set");

        let error = db
            .with_conn(|conn| {
                let mut other = request(
                    AttentionDisposition::Dismissed,
                    "digest-1",
                    None,
                    "req-1",
                    0,
                );
                other.actor_id = "user-2";
                set_attention_in_tx(conn, other)
            })
            .expect_err("a different actor must not replay another's requestId");
        assert!(
            error.to_string().contains("NEX_ATTENTION_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn set_requires_an_actor_and_a_request_id() {
        let db = fixture();
        for (actor_id, request_id) in [
            ("", "req-1"),
            ("   ", "req-1"),
            ("user-1", ""),
            ("user-1", "  "),
        ] {
            let result = db.with_conn(|conn| {
                let mut invalid = request(
                    AttentionDisposition::Dismissed,
                    "digest-1",
                    None,
                    "req-1",
                    0,
                );
                invalid.actor_id = actor_id;
                invalid.request_id = request_id;
                set_attention_in_tx(conn, invalid)
            });
            assert!(
                result.is_err(),
                "actor '{actor_id}' / request '{request_id}' must be rejected"
            );
        }
    }

    #[test]
    fn clear_rejects_a_stale_expected_version_and_leaves_the_row() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                request(
                    AttentionDisposition::Dismissed,
                    "digest-1",
                    None,
                    "req-1",
                    0,
                ),
            )
        })
        .expect("set");

        let error = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-2", 0)
            })
            .expect_err("stale clear must be rejected");
        assert!(
            error.to_string().contains("NEX_ATTENTION_VERSION_CONFLICT"),
            "unexpected error: {error}"
        );
        assert!(db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get")
            .is_some());
    }

    #[test]
    fn clearing_an_absent_row_the_caller_expected_to_be_absent_succeeds_once() {
        let db = fixture();
        let first = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-1", 0)
            })
            .expect("clearing an absent row is not an error");
        // Nothing was deleted, but the request still happened: `replayed`
        // means "I have seen this requestId before", not "there was nothing
        // to do".
        assert!(!first.replayed);
        assert_eq!(first.version, 0);

        let retry = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-1", 0)
            })
            .expect("the retry replays");
        assert!(retry.replayed);
        assert_eq!(retry.version, 0);
    }

    // -- durable request receipts -------------------------------------------

    #[test]
    fn a_cleared_finding_still_replays_its_clear_request() {
        let db = fixture();
        db.with_conn(|conn| set_attention_in_tx(conn, dismiss_request("finding-a", "req-set", 0)))
            .expect("set");
        let cleared = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-clear", 1)
            })
            .expect("clear");
        assert!(!cleared.replayed);
        assert!(db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get")
            .is_none());

        // The row is gone, so the row cannot be the replay record. The
        // receipt is, and it still carries the same stale expectedVersion
        // the original call was built with.
        let retry = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-clear", 1)
            })
            .expect("a retry of a landed clear replays instead of conflicting");
        assert!(retry.replayed);
        assert_eq!(retry.version, 0);
        assert!(db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get")
            .is_none());
    }

    #[test]
    fn a_clear_receipt_records_who_cleared_what() {
        let db = fixture();
        db.with_conn(|conn| set_attention_in_tx(conn, dismiss_request("finding-a", "req-set", 0)))
            .expect("set");
        db.with_conn(|conn| {
            clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-clear", 1)
        })
        .expect("clear");

        // The delete destroys the row's own actor/request columns, so the
        // receipt is the only surviving record of the decision.
        let receipt = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT tombstone_json FROM idempotency_requests
                      WHERE domain = ?1 AND request_id = 'req-clear'",
                    params![ATTENTION_IDEMPOTENCY_DOMAIN],
                    |row| row.get::<_, String>(0),
                )
                .map_err(Into::into)
            })
            .expect("the clear left a receipt");
        let receipt: serde_json::Value = serde_json::from_str(&receipt).expect("receipt is json");
        assert_eq!(receipt["operation"].as_str(), Some("clear"));
        assert_eq!(receipt["projectId"].as_str(), Some("proj-1"));
        assert_eq!(receipt["findingKey"].as_str(), Some("finding-a"));
        assert_eq!(receipt["actorId"].as_str(), Some("user-1"));
    }

    #[test]
    fn reusing_a_clear_request_id_for_a_different_finding_fails_closed() {
        let db = fixture();
        db.with_conn(|conn| {
            clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-1", 0)
        })
        .expect("first clear");

        let error = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-b", "user-1", "req-1", 0)
            })
            .expect_err("one requestId identifies one request, not one per finding");
        assert!(
            error.to_string().contains("NEX_ATTENTION_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_different_actor_may_not_replay_another_actors_clear() {
        let db = fixture();
        db.with_conn(|conn| {
            clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-1", 0)
        })
        .expect("first clear");

        let error = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-a", "user-2", "req-1", 0)
            })
            .expect_err("a different actor reusing a requestId is a conflict, not a replay");
        assert!(
            error.to_string().contains("NEX_ATTENTION_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_clear_may_not_replay_a_set_under_the_same_request_id() {
        let db = fixture();
        db.with_conn(|conn| set_attention_in_tx(conn, dismiss_request("finding-a", "req-1", 0)))
            .expect("set");

        let error = db
            .with_conn(|conn| {
                clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-1", 1)
            })
            .expect_err("set and clear are different operations, not a replay of each other");
        assert!(
            error.to_string().contains("NEX_ATTENTION_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
        assert!(
            db.with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
                .expect("get")
                .is_some(),
            "the rejected clear must not have deleted anything"
        );
    }

    #[test]
    fn a_set_replays_from_the_receipt_even_after_the_row_was_cleared() {
        let db = fixture();
        db.with_conn(|conn| set_attention_in_tx(conn, dismiss_request("finding-a", "req-set", 0)))
            .expect("set");
        db.with_conn(|conn| {
            clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "req-clear", 1)
        })
        .expect("clear");

        // A delayed retry of the original set must not resurrect the row the
        // user has since cleared.
        let replay = db
            .with_conn(|conn| set_attention_in_tx(conn, dismiss_request("finding-a", "req-set", 0)))
            .expect("the retry replays");
        assert!(replay.replayed);
        assert_eq!(replay.version, 1);
        assert!(
            db.with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
                .expect("get")
                .is_none(),
            "a replayed set must not resurrect a cleared row"
        );
    }

    #[test]
    fn clear_requires_an_actor_and_a_request_id() {
        let db = fixture();
        assert!(db
            .with_conn(|conn| clear_attention_in_tx(conn, "proj-1", "finding-a", "", "req-1", 0))
            .is_err());
        assert!(db
            .with_conn(|conn| clear_attention_in_tx(conn, "proj-1", "finding-a", "user-1", "", 0))
            .is_err());
    }

    #[test]
    fn disposition_round_trips_through_as_str_and_try_from() {
        for disposition in [
            AttentionDisposition::Snoozed,
            AttentionDisposition::Dismissed,
            AttentionDisposition::Flagged,
        ] {
            let parsed = AttentionDisposition::try_from(disposition.as_str()).expect("parse");
            assert_eq!(parsed, disposition);
        }
        assert!(AttentionDisposition::try_from("unknown-disposition").is_err());
    }

    fn dismissed_row(material_basis_digest: &str) -> AttentionRow {
        AttentionRow {
            project_id: "proj-1".to_string(),
            finding_key: "finding-a".to_string(),
            finding_identity: None,
            identity_resolution_status: "resolved".to_string(),
            disposition: AttentionDisposition::Dismissed,
            material_basis_digest: material_basis_digest.to_string(),
            snoozed_until: None,
            set_at: "2026-08-15T00:00:00.000Z".to_string(),
            actor_id: "user-1".to_string(),
            request_id: "req-1".to_string(),
            payload_digest: "sha256:test".to_string(),
            reason: None,
            version: 1,
        }
    }

    fn snoozed_row(snoozed_until: &str) -> AttentionRow {
        AttentionRow {
            project_id: "proj-1".to_string(),
            finding_key: "finding-a".to_string(),
            finding_identity: None,
            identity_resolution_status: "resolved".to_string(),
            disposition: AttentionDisposition::Snoozed,
            material_basis_digest: "digest-1".to_string(),
            snoozed_until: Some(snoozed_until.to_string()),
            set_at: "2026-08-15T00:00:00.000Z".to_string(),
            actor_id: "user-1".to_string(),
            request_id: "req-1".to_string(),
            payload_digest: "sha256:test".to_string(),
            reason: None,
            version: 1,
        }
    }

    #[test]
    fn applicable_is_false_on_material_basis_digest_mismatch() {
        let row = dismissed_row("digest-1");
        assert!(!is_attention_applicable(
            &row,
            "digest-2",
            "2026-08-15T00:00:00.000Z"
        ));
    }

    #[test]
    fn legacy_unresolved_identity_is_never_applicable_even_when_digest_matches() {
        let mut row = dismissed_row("digest-1");
        row.identity_resolution_status = "legacy-unresolved".to_string();
        assert!(!is_attention_applicable(
            &row,
            "digest-1",
            "2026-08-15T01:00:00.000Z"
        ));
    }

    #[test]
    fn applicable_snoozed_row_is_false_once_snoozed_until_has_lapsed() {
        let row = snoozed_row("2026-08-15T00:00:00.000Z");
        // snoozed_until <= now: expired.
        assert!(!is_attention_applicable(
            &row,
            "digest-1",
            "2026-08-15T00:00:00.000Z"
        ));
        assert!(!is_attention_applicable(
            &row,
            "digest-1",
            "2026-08-16T00:00:00.000Z"
        ));
    }

    #[test]
    fn applicable_snoozed_row_is_true_while_snoozed_until_is_in_the_future() {
        let row = snoozed_row("2026-09-01T00:00:00.000Z");
        assert!(is_attention_applicable(
            &row,
            "digest-1",
            "2026-08-15T00:00:00.000Z"
        ));
    }

    #[test]
    fn applicable_dismissed_and_flagged_rows_have_no_expiry() {
        let dismissed = dismissed_row("digest-1");
        assert!(is_attention_applicable(
            &dismissed,
            "digest-1",
            "9999-01-01T00:00:00.000Z"
        ));
        let flagged = AttentionRow {
            disposition: AttentionDisposition::Flagged,
            ..dismissed_row("digest-1")
        };
        assert!(is_attention_applicable(
            &flagged,
            "digest-1",
            "9999-01-01T00:00:00.000Z"
        ));
    }

    #[test]
    fn get_attention_does_not_auto_delete_or_mutate_an_expired_snoozed_row() {
        let db = fixture();
        db.with_conn(|conn| {
            let mut expired = request(
                AttentionDisposition::Snoozed,
                "digest-1",
                Some("2026-08-01T00:00:00.000Z"),
                "req-1",
                0,
            );
            expired.set_at = "2026-07-01T00:00:00.000Z";
            set_attention_in_tx(conn, expired)
        })
        .expect("set snoozed");

        // Read as of a time well after snoozed_until has lapsed.
        let now = "2026-08-15T00:00:00.000Z";
        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row still present, unmutated");
        assert!(!is_attention_applicable(&row, "digest-1", now));

        // Reading again confirms the row was not deleted or rewritten by the
        // read above.
        let row_again = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention again")
            .expect("row still present after prior read");
        assert_eq!(row_again, row);
    }
}
