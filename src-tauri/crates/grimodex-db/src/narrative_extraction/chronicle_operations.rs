//! Chronicle domain operations for narrative apply commits.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::chronicle_approval_date::{resolve_approval_date, EventDate};
use crate::agent_writes::{apply_event_create_in_tx, EventCreateTxInput, EventCreateTxResult};

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
    #[serde(flatten)]
    date: EventDate,
}

pub(crate) fn parse_event_create_payload(
    payload: &Value,
) -> anyhow::Result<ChronicleEventCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid chronicle.event.create payload: {err}"))
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
    crate::domain_writes::generate_n_keys_between(after, None, count)
}

pub(crate) struct ChronicleEventCreateContext<'a> {
    pub conn: &'a Connection,
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: Option<&'a str>,
    pub payload: &'a ChronicleEventCreatePayload,
    pub ordinal: &'a str,
    pub now: &'a str,
    pub timestamp: i64,
}

pub(crate) fn apply_chronicle_event_create(
    ctx: ChronicleEventCreateContext<'_>,
) -> anyhow::Result<(EventCreateTxResult, bool)> {
    anyhow::ensure!(
        ctx.payload.placement.mode == "append-tail",
        "unsupported placement mode: {}",
        ctx.payload.placement.mode
    );

    let scene_ids: Vec<String> = ctx
        .payload
        .evidence_scene_links
        .iter()
        .map(|link| link.scene_id.clone())
        .collect();
    let reveal_scene_id = ctx
        .payload
        .reveal_scene_id
        .clone()
        .filter(|value| !value.is_empty());

    let supplied = &ctx.payload.date;
    let assign_date = supplied.start_time.is_none()
        || supplied.start_granularity.as_deref().unwrap_or("none") == "none";
    let assigned;
    let (date, precision) = if assign_date {
        assigned = resolve_approval_date(ctx.conn, ctx.project_id, &scene_ids)?;
        (&assigned, "unknown")
    } else {
        (supplied, ctx.payload.precision.as_deref().unwrap_or("unknown"))
    };
    let kind = ctx
        .payload
        .kind
        .clone()
        .unwrap_or_else(|| "generic".to_string());
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();

    let result = apply_event_create_in_tx(
        ctx.conn,
        EventCreateTxInput {
            project_id: ctx.project_id,
            session_id: ctx.session_id,
            surface: ctx.surface,
            event_id: &ctx.payload.event_id,
            undo_id: &undo_id,
            event_uid: &event_uid,
            title: &ctx.payload.title,
            note: ctx.payload.note.as_deref(),
            detail: ctx.payload.detail.as_deref(),
            ordinal: ctx.ordinal,
            primary_codex_id: ctx.payload.primary_codex_id.as_deref(),
            lane_group: None,
            location_codex_id: ctx.payload.location_codex_id.as_deref(),
            start_time: date.start_time,
            end_time: date.end_time,
            start_minute: date.start_minute,
            end_minute: date.end_minute,
            start_granularity: date.start_granularity.as_deref().unwrap_or("none"),
            end_granularity: date.end_granularity.as_deref().unwrap_or("none"),
            precision,
            kind: &kind,
            secret: ctx.payload.secret,
            reveal_scene_id: reveal_scene_id.as_deref(),
            participants: &ctx.payload.participants,
            scene_ids: &scene_ids,
            request_hash: None,
            now: ctx.now,
            timestamp: ctx.timestamp,
            write_undo_journal: false,
            write_change_event: false,
        },
    )?;
    Ok((result, assign_date))
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

    fn assert_js_append_vectors(
        append: impl Fn(Option<&str>, usize) -> anyhow::Result<Vec<String>>,
    ) -> anyhow::Result<()> {
        let keys = append(None, 130)?;
        assert_eq!(keys.len(), 130);
        assert_eq!(keys[..3], ["a0", "a1", "a2"]);
        assert_eq!(keys[60..66], ["ay", "az", "b00", "b01", "b02", "b03"]);
        assert_eq!(keys[128..], ["b14", "b15"]);
        for (tail, next) in [
            ("az", "b00"),
            ("b00", "b01"),
            ("b0z", "b10"),
            ("bzz", "c000"),
        ] {
            assert_eq!(append(Some(tail), 1)?, [next]);
        }
        assert_eq!(append(Some("a5"), 3)?, ["a6", "a7", "a8"]);
        for invalid in ["zz", "b0", "b000", "aé"] {
            assert!(append(Some(invalid), 1).is_err(), "{invalid}");
        }
        let keys = append(None, 2_000)?;
        assert_eq!(keys.len(), 2_000);
        assert_eq!(keys[61..63], ["az", "b00"]);
        assert_eq!(keys[1999], "bVF");
        Ok(())
    }

    #[test]
    fn shared_keys_match_js_append_vectors() -> anyhow::Result<()> {
        assert_js_append_vectors(|after, count| {
            crate::domain_writes::generate_n_keys_between(after, None, count)
        })
    }

    #[test]
    fn append_ordinals_match_js_append_vectors() -> anyhow::Result<()> {
        assert_js_append_vectors(generate_append_ordinals)
    }
}
