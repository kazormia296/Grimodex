//! Durable idempotency for renderer-owned create requests.
//!
//! The entity row itself cannot be the replay record: delete/cascade/prune can
//! remove it after a successful create, and a delayed retry would then recreate
//! ("resurrect") the entity. `idempotency_requests` survives entity deletion
//! and stores only a content-free entity tombstone. The request check, entity
//! mutation, and ledger append all run under the same `BEGIN IMMEDIATE`
//! transaction.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::Database;

const WIRE_METADATA_KEY: &str = "__idempotency";
const MAINTENANCE_TRANSACTION_ID_KEY: &str = "maintenanceTransactionId";

pub(crate) struct IdempotencyRequest<'a> {
    pub domain: &'a str,
    pub request_id: Option<&'a str>,
    pub payload_hash: &'a str,
    pub conflict_marker: &'a str,
}

pub(crate) struct IdempotentCreateOutcome {
    response: Value,
    replayed: bool,
    entity_present: bool,
}

/// Load the exact response recorded for a completed non-create request.
///
/// Composite mutations cannot reconstruct their response from one entity row:
/// the response owns an undo journal id plus multiple event/scene result tokens.
/// Their ledger therefore stores that small, content-free response directly.
pub(crate) fn load_idempotent_response(
    conn: &Connection,
    request: &IdempotencyRequest<'_>,
) -> anyhow::Result<Option<Value>> {
    let Some(request_id) = request.request_id else {
        return Ok(None);
    };
    let stored = conn
        .query_row(
            "SELECT payload_hash, tombstone_json
               FROM idempotency_requests
              WHERE domain = ?1 AND request_id = ?2",
            rusqlite::params![request.domain, request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((stored_hash, response_json)) = stored else {
        return Ok(None);
    };
    if stored_hash != request.payload_hash {
        anyhow::bail!(
            "{}: request id reused with different payload",
            request.conflict_marker
        );
    }
    Ok(Some(serde_json::from_str(&response_json)?))
}

/// Record the exact response for a completed non-create request in the
/// caller-owned transaction.
pub(crate) fn insert_idempotent_response(
    conn: &Connection,
    request: &IdempotencyRequest<'_>,
    project_id: &str,
    response: &Value,
) -> anyhow::Result<()> {
    let Some(request_id) = request.request_id else {
        return Ok(());
    };
    conn.execute(
        "INSERT INTO idempotency_requests
             (domain, request_id, project_id, payload_hash, tombstone_json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            request.domain,
            request_id,
            project_id,
            request.payload_hash,
            serde_json::to_string(response)?,
        ],
    )?;
    Ok(())
}

impl IdempotentCreateOutcome {
    /// Preserve the historical entity-row wire shape while adding non-DB
    /// metadata that lets renderer stores avoid publishing a deleted replay.
    pub(crate) fn into_wire_value(mut self) -> Value {
        if let Value::Object(row) = &mut self.response {
            row.insert(
                WIRE_METADATA_KEY.to_string(),
                json!({
                    "replayed": self.replayed,
                    "entityPresent": self.entity_present,
                }),
            );
        }
        self.response
    }
}

pub(crate) fn payload_fingerprint<T: Serialize>(
    domain: &str,
    payload: &T,
) -> anyhow::Result<String> {
    let mut canonical_value = serde_json::to_value((domain, payload))?;
    canonicalize_json(&mut canonical_value);
    let canonical = serde_json::to_vec(&canonical_value)?;
    Ok(hex::encode(Sha256::digest(canonical)))
}

/// Hash domain intent without transport identities that can change when the
/// same durable request is replayed after a renderer/recorder restart.
pub(crate) fn canonical_write_payload_fingerprint<T: Serialize>(
    domain: &str,
    payload: &T,
) -> anyhow::Result<String> {
    let mut normalized = serde_json::to_value(payload)?;
    if let Some(object) = normalized.as_object_mut() {
        object.remove("requestId");
        object.remove("sessionId");
        object.remove("eventUid");
        if let Some(change_event) = object.get_mut("changeEvent").and_then(Value::as_object_mut) {
            change_event.remove("requestId");
            change_event.remove("sessionId");
            change_event.remove("eventUid");
        }
    }
    payload_fingerprint(domain, &normalized)
}

fn canonicalize_json(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                canonicalize_json(value);
            }
        }
        Value::Object(object) => {
            let old = std::mem::take(object);
            let mut entries = old.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (key, mut value) in entries {
                canonicalize_json(&mut value);
                object.insert(key, value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn finish_transaction<T>(conn: &Connection, result: anyhow::Result<T>) -> anyhow::Result<T> {
    match result {
        Ok(value) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error.into())
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Run a create and its durable replay record atomically.
///
/// `create` returns the owning project plus the initial entity response.
/// `load_entity` is evaluated only for a replay, while the transaction lock is
/// still held, so a delete cannot race the row/metadata reported to renderer.
/// The ledger persists only `{id}`; manuscript content remains governed by the
/// entity's own delete/prune retention policy.
pub(crate) fn run_atomic_create<Create, Load>(
    db: &Database,
    request: IdempotencyRequest<'_>,
    create: Create,
    load_entity: Load,
) -> anyhow::Result<IdempotentCreateOutcome>
where
    Create: FnOnce(&Connection) -> anyhow::Result<(String, Value)>,
    Load: FnOnce(&Connection) -> anyhow::Result<Option<Value>>,
{
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            if let Some(request_id) = request.request_id {
                let stored = conn
                    .query_row(
                        "SELECT payload_hash, tombstone_json
                           FROM idempotency_requests
                          WHERE domain = ?1 AND request_id = ?2",
                        rusqlite::params![request.domain, request_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()?;
                if let Some((stored_hash, tombstone_json)) = stored {
                    if stored_hash != request.payload_hash {
                        anyhow::bail!(
                            "{}: request id reused with different payload",
                            request.conflict_marker
                        );
                    }
                    let current = load_entity(conn)?;
                    let entity_present = current.is_some();
                    let tombstone: Value = serde_json::from_str(&tombstone_json)?;
                    let response = match current {
                        Some(mut row) => {
                            if let (Value::Object(row), Value::Object(tombstone)) =
                                (&mut row, &tombstone)
                            {
                                if let Some(transaction_id) =
                                    tombstone.get(MAINTENANCE_TRANSACTION_ID_KEY)
                                {
                                    row.insert(
                                        MAINTENANCE_TRANSACTION_ID_KEY.to_string(),
                                        transaction_id.clone(),
                                    );
                                }
                            }
                            row
                        }
                        None => tombstone,
                    };
                    return Ok(IdempotentCreateOutcome {
                        response,
                        replayed: true,
                        entity_present,
                    });
                }
            }

            let (project_id, response) = create(conn)?;
            if let Some(request_id) = request.request_id {
                let entity_id = response.get("id").and_then(Value::as_str).ok_or_else(|| {
                    anyhow::anyhow!("idempotent create response has no entity id")
                })?;
                let mut tombstone = json!({ "id": entity_id });
                if let (Value::Object(tombstone), Some(transaction_id)) =
                    (&mut tombstone, response.get(MAINTENANCE_TRANSACTION_ID_KEY))
                {
                    tombstone.insert(
                        MAINTENANCE_TRANSACTION_ID_KEY.to_string(),
                        transaction_id.clone(),
                    );
                }
                conn.execute(
                    "INSERT INTO idempotency_requests
                         (domain, request_id, project_id, payload_hash, tombstone_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        request.domain,
                        request_id,
                        project_id,
                        request.payload_hash,
                        serde_json::to_string(&tombstone)?,
                    ],
                )?;
            }
            Ok(IdempotentCreateOutcome {
                response,
                replayed: false,
                entity_present: true,
            })
        })();
        finish_transaction(conn, result)
    })
}

pub(crate) fn load_row(conn: &Connection, table: &str, id: &str) -> anyhow::Result<Option<Value>> {
    // Every caller supplies a static, reviewed table literal.
    let sql = format!("SELECT * FROM {table} WHERE id = ?");
    let rows = Database::execute_with_conn(conn, &sql, &[Value::String(id.to_string())], "get")?;
    Ok(rows.first().cloned().map(Value::Object))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    struct Payload<'a> {
        title: &'a str,
        optional: Option<&'a str>,
    }

    #[test]
    fn fingerprint_is_stable_and_domain_separated() {
        let payload = Payload {
            title: "伏線",
            optional: None,
        };
        let first = payload_fingerprint("a", &payload).expect("hash");
        let same = payload_fingerprint("a", &payload).expect("hash");
        let other_domain = payload_fingerprint("b", &payload).expect("hash");
        assert_eq!(first, same);
        assert_ne!(first, other_domain);
    }

    #[test]
    fn fingerprint_canonicalizes_recursive_object_key_order() {
        let first = serde_json::json!({
            "nested": {"b": 2, "a": 1},
            "outer": "same",
        });
        let second = serde_json::json!({
            "outer": "same",
            "nested": {"a": 1, "b": 2},
        });
        assert_eq!(
            payload_fingerprint("domain", &first).expect("first"),
            payload_fingerprint("domain", &second).expect("second")
        );
    }
}
