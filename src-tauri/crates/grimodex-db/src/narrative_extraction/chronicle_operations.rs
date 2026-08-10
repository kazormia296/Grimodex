//! Chronicle domain operations for narrative apply commits.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use crate::agent_writes::{apply_event_create_in_tx, EventCreateTxInput, EventCreateTxResult};

const OP_KIND_EVENT_CREATE: &str = "chronicle.event.create";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FractionalPlacement {
    pub mode: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub after_ordinal: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvidenceSceneLink {
    pub scene_id: String,
    pub expected_scene_version: i64,
    #[serde(default)]
    #[allow(dead_code)]
    pub evidence_anchor_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChronicleEventCreatePayload {
    pub event_id: String,
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub precision: Option<String>,
    pub placement: FractionalPlacement,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub reveal_scene_id: Option<String>,
    #[serde(default)]
    pub evidence_scene_links: Vec<EvidenceSceneLink>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub primary_codex_id: Option<String>,
    #[serde(default)]
    pub location_codex_id: Option<String>,
    #[serde(default)]
    pub participants: Vec<String>,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default)]
    pub end_time: Option<i64>,
    #[serde(default)]
    pub start_minute: Option<i64>,
    #[serde(default)]
    pub end_minute: Option<i64>,
    #[serde(default)]
    pub start_granularity: Option<String>,
    #[serde(default)]
    pub end_granularity: Option<String>,
}

pub(crate) fn parse_event_create_payload(payload: &Value) -> anyhow::Result<ChronicleEventCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid chronicle.event.create payload: {err}"))
}

pub(crate) fn ensure_operation_kind(kind: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        kind == OP_KIND_EVENT_CREATE,
        "unsupported commit operation kind: {kind}"
    );
    Ok(())
}

pub(crate) fn project_tail_ordinal(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "SELECT ordinal FROM events
          WHERE project_id = ?1
          ORDER BY ordinal DESC, id DESC
          LIMIT 1",
        params![project_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(Into::into)
}

pub(crate) fn ensure_order_neighbor(
    conn: &Connection,
    project_id: &str,
    expected_tail_ordinal: Option<&str>,
) -> anyhow::Result<()> {
    let current = project_tail_ordinal(conn, project_id)?;
    if current.as_deref() != expected_tail_ordinal {
        anyhow::bail!(
            "NEX_ORDER_NEIGHBOR_CHANGED: expected tail {:?}, found {:?}",
            expected_tail_ordinal,
            current
        );
    }
    Ok(())
}

pub(crate) fn ensure_scene_versions(
    conn: &Connection,
    project_id: &str,
    links: &[EvidenceSceneLink],
) -> anyhow::Result<()> {
    for link in links {
        let version: Option<i64> = conn
            .query_row(
                "SELECT version FROM tree_nodes
                  WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
                params![link.scene_id, project_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(version) = version else {
            anyhow::bail!(
                "scene '{}' not found in project '{}'",
                link.scene_id,
                project_id
            );
        };
        if version != link.expected_scene_version {
            anyhow::bail!(
                "NEX_SCENE_VERSION_MISMATCH: scene '{}' expected version {}, found {}",
                link.scene_id,
                link.expected_scene_version,
                version
            );
        }
    }
    Ok(())
}

pub(crate) fn ensure_event_id_available(
    conn: &Connection,
    project_id: &str,
    event_id: &str,
) -> anyhow::Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
        params![event_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        exists == 0,
        "event '{event_id}' already exists in project '{project_id}'"
    );
    Ok(())
}

/// Append-only fractional keys compatible with JS `fractional-indexing`
/// for the common `generateKeyBetween(a, null)` / `generateNKeysBetween(a, null, n)` path.
pub(crate) fn generate_append_ordinals(
    after: Option<&str>,
    count: usize,
) -> anyhow::Result<Vec<String>> {
    let mut keys = Vec::with_capacity(count);
    let mut prev = after.map(str::to_string);
    for _ in 0..count {
        let next = generate_key_between(prev.as_deref(), None)?;
        keys.push(next.clone());
        prev = Some(next);
    }
    Ok(keys)
}

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit_index(ch: u8) -> anyhow::Result<usize> {
    DIGITS
        .iter()
        .position(|d| *d == ch)
        .ok_or_else(|| anyhow::anyhow!("invalid fractional-index digit"))
}

fn get_integer_part(key: &str) -> anyhow::Result<&str> {
    let bytes = key.as_bytes();
    anyhow::ensure!(!bytes.is_empty(), "empty fractional key");
    let head = bytes[0];
    let int_len = if (b'a'..=b'z').contains(&head) {
        (head - b'a' + 2) as usize
    } else if (b'A'..=b'Z').contains(&head) {
        (b'Z' - head + 2) as usize
    } else {
        anyhow::bail!("invalid fractional key integer head");
    };
    anyhow::ensure!(key.len() >= int_len, "fractional key too short");
    Ok(&key[..int_len])
}

fn validate_order_key(key: &str) -> anyhow::Result<()> {
    let integer = get_integer_part(key)?;
    anyhow::ensure!(
        !integer.ends_with('0') || integer == "a0" || integer == "A0" || key.len() > integer.len(),
        "invalid trailing zero in fractional key"
    );
    for b in key.bytes() {
        digit_index(b)?;
    }
    Ok(())
}

fn increment_integer(integer: &str) -> anyhow::Result<String> {
    let bytes = integer.as_bytes();
    anyhow::ensure!(!bytes.is_empty(), "empty integer part");
    let head = bytes[0];
    if head == b'z' || head == b'Z' {
        // Grow integer length by one (same as JS fractional-indexing).
        if head == b'z' {
            return Ok(format!("z{}", "0".repeat(integer.len())));
        }
        return Ok(format!("Z{}", "0".repeat(integer.len())));
    }
    let mut chars: Vec<u8> = integer.as_bytes().to_vec();
    for i in (1..chars.len()).rev() {
        let idx = digit_index(chars[i])?;
        if idx + 1 < DIGITS.len() {
            chars[i] = DIGITS[idx + 1];
            return Ok(String::from_utf8(chars)?);
        }
        chars[i] = DIGITS[0];
    }
    let head_idx = digit_index(chars[0])?;
    anyhow::ensure!(head_idx + 1 < DIGITS.len(), "integer overflow");
    chars[0] = DIGITS[head_idx + 1];
    // When head moves from 'a'..'y', integer length stays; from growing path handled above.
    Ok(String::from_utf8(chars)?)
}

fn generate_key_between(a: Option<&str>, b: Option<&str>) -> anyhow::Result<String> {
    match (a, b) {
        (None, None) => Ok("a0".to_string()),
        (Some(a), None) => {
            validate_order_key(a)?;
            let integer = get_integer_part(a)?;
            if a == integer {
                Ok(increment_integer(integer)?)
            } else {
                // Midpoint toward +∞: append a mid digit after `a`.
                Ok(format!("{a}{}", DIGITS[DIGITS.len() / 2] as char))
            }
        }
        (None, Some(b)) => {
            validate_order_key(b)?;
            // Only needed for completeness; append-tail path does not use this.
            anyhow::bail!("generate_key_between(null, Some) is not used by append-tail commits")
        }
        (Some(a), Some(b)) => {
            anyhow::ensure!(a < b, "fractional bounds out of order");
            validate_order_key(a)?;
            validate_order_key(b)?;
            anyhow::bail!("generate_key_between(Some, Some) is not used by append-tail commits")
        }
    }
}

pub(crate) fn apply_chronicle_event_create(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    surface: Option<&str>,
    payload: &ChronicleEventCreatePayload,
    ordinal: &str,
    now: &str,
    timestamp: i64,
) -> anyhow::Result<EventCreateTxResult> {
    anyhow::ensure!(
        payload.placement.mode == "append-tail",
        "unsupported placement mode: {}",
        payload.placement.mode
    );

    let scene_ids: Vec<String> = payload
        .evidence_scene_links
        .iter()
        .map(|link| link.scene_id.clone())
        .collect();
    let reveal_scene_id = payload
        .reveal_scene_id
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| scene_ids.first().cloned());

    let start_granularity = payload
        .start_granularity
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let end_granularity = payload
        .end_granularity
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let precision = payload
        .precision
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let kind = payload
        .kind
        .clone()
        .unwrap_or_else(|| "generic".to_string());
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();

    apply_event_create_in_tx(
        conn,
        EventCreateTxInput {
            project_id,
            session_id,
            surface,
            event_id: &payload.event_id,
            undo_id: &undo_id,
            event_uid: &event_uid,
            title: &payload.title,
            note: payload.note.as_deref(),
            detail: payload.detail.as_deref(),
            ordinal,
            primary_codex_id: payload.primary_codex_id.as_deref(),
            lane_group: None,
            location_codex_id: payload.location_codex_id.as_deref(),
            start_time: payload.start_time,
            end_time: payload.end_time,
            start_minute: payload.start_minute,
            end_minute: payload.end_minute,
            start_granularity: &start_granularity,
            end_granularity: &end_granularity,
            precision: &precision,
            kind: &kind,
            secret: payload.secret,
            reveal_scene_id: reveal_scene_id.as_deref(),
            participants: &payload.participants,
            scene_ids: &scene_ids,
            request_hash: None,
            now,
            timestamp,
            write_undo_journal: false,
            write_change_event: false,
        },
    )
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn append_ordinals_start_at_a0() {
        assert_eq!(
            generate_append_ordinals(None, 3).unwrap(),
            vec!["a0".to_string(), "a1".to_string(), "a2".to_string()]
        );
    }

    #[test]
    fn append_ordinals_continue_after_tail() {
        assert_eq!(
            generate_append_ordinals(Some("a0"), 2).unwrap(),
            vec!["a1".to_string(), "a2".to_string()]
        );
    }
}
