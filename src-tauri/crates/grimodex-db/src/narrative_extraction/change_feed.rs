//! Narrative Maintenance Change Feed foundation (SCHEMA_VERSION 14).
//!
//! An ordered, per-project change transaction/event log that downstream
//! maintenance consumers (dependency tracking, freshness evaluation,
//! application health) can page through via monotonic cursors. This module
//! only covers the append/read/acknowledge primitives; dependency edges,
//! freshness records, and application contribution/health bookkeeping are
//! separate persistence surfaces built on top of this feed.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::Database;

/// The cause metadata `kind` that marks an event as produced by a narrative
/// application commit. [`events_affecting_application`] uses this, together
/// with a matching `applicationId`, to exclude an application's own writes
/// from the changes it evaluates for staleness.
const CAUSE_KIND_NARRATIVE_COMMIT: &str = "narrative-commit";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendChangeEventInput {
    #[serde(default)]
    pub event_id: Option<String>,
    pub object_key_json: Value,
    pub change_kind: String,
    #[serde(default)]
    pub before_version: Option<i64>,
    #[serde(default)]
    pub before_digest: Option<String>,
    #[serde(default)]
    pub after_version: Option<i64>,
    #[serde(default)]
    pub after_digest: Option<String>,
    pub changed_paths_json: Value,
    #[serde(default)]
    pub text_impact_json: Option<Value>,
    #[serde(default)]
    pub structural_impact_json: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendChangeTransactionInput {
    #[serde(default)]
    pub transaction_id: Option<String>,
    pub project_id: String,
    pub cause_json: Value,
    pub events: Vec<AppendChangeEventInput>,
}

/// A single durable change event row, as read back from
/// `narrative_change_events`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEventRecord {
    pub event_id: String,
    pub project_id: String,
    pub transaction_id: String,
    pub project_sequence: i64,
    pub event_ordinal: i64,
    pub object_key_json: Value,
    pub change_kind: String,
    pub before_version: Option<i64>,
    pub before_digest: Option<String>,
    pub after_version: Option<i64>,
    pub after_digest: Option<String>,
    pub changed_paths_json: Value,
    pub text_impact_json: Option<Value>,
    pub structural_impact_json: Option<Value>,
    pub cause_json: Value,
    pub occurred_at: String,
}

/// Appends one transaction and its ordered events in a single write.
/// Allocates `project_sequence` as `MAX(existing) + 1` for the project and
/// stamps every event in the transaction with that same sequence, ordered by
/// `event_ordinal` (0-based, insertion order).
pub fn append_change_transaction(
    db: &Database,
    input: AppendChangeTransactionInput,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !input.events.is_empty(),
        "change transaction requires at least one event"
    );
    let transaction_id = input
        .transaction_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now();
    let cause_json = input.cause_json.to_string();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            let next_sequence: i64 = conn.query_row(
                "SELECT COALESCE(MAX(project_sequence), 0) + 1
                   FROM narrative_change_transactions
                  WHERE project_id = ?1",
                [&input.project_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO narrative_change_transactions (
                    id, project_id, project_sequence, cause_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![transaction_id, input.project_id, next_sequence, cause_json, now],
            )?;

            let mut event_ids = Vec::with_capacity(input.events.len());
            for (ordinal, event) in input.events.iter().enumerate() {
                let event_id = event
                    .event_id
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                conn.execute(
                    "INSERT INTO narrative_change_events (
                        id, project_id, transaction_id, project_sequence, event_ordinal,
                        object_key_json, change_kind, before_version, before_digest,
                        after_version, after_digest, changed_paths_json, text_impact_json,
                        structural_impact_json, cause_json, occurred_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![
                        event_id,
                        input.project_id,
                        transaction_id,
                        next_sequence,
                        ordinal as i64,
                        event.object_key_json.to_string(),
                        event.change_kind,
                        event.before_version,
                        event.before_digest,
                        event.after_version,
                        event.after_digest,
                        event.changed_paths_json.to_string(),
                        event.text_impact_json.as_ref().map(Value::to_string),
                        event.structural_impact_json.as_ref().map(Value::to_string),
                        cause_json,
                        now,
                    ],
                )?;
                event_ids.push(event_id);
            }

            Ok(json!({
                "transactionId": transaction_id,
                "projectSequence": next_sequence,
                "eventIds": event_ids,
            }))
        })();
        complete_transaction(conn, result)
    })
}

/// Returns every event with `project_sequence > after_sequence` for the
/// project, ordered by `(project_sequence, event_ordinal)` so a consumer can
/// replay both transaction order and intra-transaction order.
pub fn get_changes_since(
    db: &Database,
    project_id: &str,
    after_sequence: i64,
) -> anyhow::Result<Vec<ChangeEventRecord>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, project_id, transaction_id, project_sequence, event_ordinal,
                    object_key_json, change_kind, before_version, before_digest,
                    after_version, after_digest, changed_paths_json, text_impact_json,
                    structural_impact_json, cause_json, occurred_at
               FROM narrative_change_events
              WHERE project_id = ?1 AND project_sequence > ?2
              ORDER BY project_sequence, event_ordinal",
        )?;
        let events = statement
            .query_map(params![project_id, after_sequence], row_to_change_event)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(events)
    })
}

/// Advances a consumer's cursor. The acknowledged sequence is monotonic: a
/// call with `through_sequence` behind the currently acknowledged value is a
/// no-op rather than an error, so retried/out-of-order acknowledgements from
/// a consumer cannot rewind its progress.
pub fn acknowledge_cursor(
    db: &Database,
    project_id: &str,
    consumer_id: &str,
    through_sequence: i64,
) -> anyhow::Result<Value> {
    let now = now();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            let current: Option<i64> = conn
                .query_row(
                    "SELECT acknowledged_through_sequence
                       FROM narrative_change_cursors
                      WHERE project_id = ?1 AND consumer_id = ?2",
                    params![project_id, consumer_id],
                    |row| row.get(0),
                )
                .optional()?;
            match current {
                None => {
                    conn.execute(
                        "INSERT INTO narrative_change_cursors (
                            project_id, consumer_id, acknowledged_through_sequence, updated_at
                         ) VALUES (?1, ?2, ?3, ?4)",
                        params![project_id, consumer_id, through_sequence, now],
                    )?;
                }
                Some(existing) if through_sequence >= existing => {
                    conn.execute(
                        "UPDATE narrative_change_cursors
                            SET acknowledged_through_sequence = ?1, updated_at = ?2
                          WHERE project_id = ?3 AND consumer_id = ?4",
                        params![through_sequence, now, project_id, consumer_id],
                    )?;
                }
                Some(_) => {
                    // Stale acknowledgement behind the current cursor: leave the
                    // monotonic value untouched instead of rewinding it.
                }
            }
            get_cursor_value(conn, project_id, consumer_id)?.ok_or_else(|| {
                anyhow::anyhow!(
                    "narrative change cursor for project '{project_id}' consumer '{consumer_id}' was not found"
                )
            })
        })();
        complete_transaction(conn, result)
    })
}

/// Self-stale guard: filters `events` down to the ones that should actually
/// be treated as invalidating an application's contribution. Excludes
/// events at or below the application's recorded baseline sequence, and
/// events whose cause is the application's own narrative-commit (so
/// committing a proposal never immediately marks its own contributions
/// stale).
pub fn events_affecting_application(
    events: &[ChangeEventRecord],
    application_id: &str,
    committed_at_sequence: i64,
) -> Vec<ChangeEventRecord> {
    events
        .iter()
        .filter(|event| {
            if event.project_sequence <= committed_at_sequence {
                return false;
            }
            !is_own_narrative_commit(&event.cause_json, application_id)
        })
        .cloned()
        .collect()
}

fn is_own_narrative_commit(cause_json: &Value, application_id: &str) -> bool {
    cause_json.get("kind").and_then(Value::as_str) == Some(CAUSE_KIND_NARRATIVE_COMMIT)
        && cause_json.get("applicationId").and_then(Value::as_str) == Some(application_id)
}

fn row_to_change_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChangeEventRecord> {
    Ok(ChangeEventRecord {
        event_id: row.get("id")?,
        project_id: row.get("project_id")?,
        transaction_id: row.get("transaction_id")?,
        project_sequence: row.get("project_sequence")?,
        event_ordinal: row.get("event_ordinal")?,
        object_key_json: parse_json_column(row.get("object_key_json")?)?,
        change_kind: row.get("change_kind")?,
        before_version: row.get("before_version")?,
        before_digest: row.get("before_digest")?,
        after_version: row.get("after_version")?,
        after_digest: row.get("after_digest")?,
        changed_paths_json: parse_json_column(row.get("changed_paths_json")?)?,
        text_impact_json: row
            .get::<_, Option<String>>("text_impact_json")?
            .map(parse_json_column)
            .transpose()?,
        structural_impact_json: row
            .get::<_, Option<String>>("structural_impact_json")?
            .map(parse_json_column)
            .transpose()?,
        cause_json: parse_json_column(row.get("cause_json")?)?,
        occurred_at: row.get("occurred_at")?,
    })
}

fn get_cursor_value(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
) -> anyhow::Result<Option<Value>> {
    conn.query_row(
        "SELECT project_id, consumer_id, acknowledged_through_sequence, lease_owner,
                lease_expires_at, last_error, updated_at
           FROM narrative_change_cursors
          WHERE project_id = ?1 AND consumer_id = ?2",
        params![project_id, consumer_id],
        |row| {
            Ok(json!({
                "projectId": row.get::<_, String>(0)?,
                "consumerId": row.get::<_, String>(1)?,
                "acknowledgedThroughSequence": row.get::<_, i64>(2)?,
                "leaseOwner": row.get::<_, Option<String>>(3)?,
                "leaseExpiresAt": row.get::<_, Option<String>>(4)?,
                "lastError": row.get::<_, Option<String>>(5)?,
                "updatedAt": row.get::<_, String>(6)?,
            }))
        },
    )
    .optional()
    .map_err(Into::into)
}

fn parse_json_column(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn complete_transaction<T>(conn: &Connection, result: anyhow::Result<T>) -> anyhow::Result<T> {
    match result {
        Ok(value) => {
            grimodex_core::commit_or_rollback(conn)?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
