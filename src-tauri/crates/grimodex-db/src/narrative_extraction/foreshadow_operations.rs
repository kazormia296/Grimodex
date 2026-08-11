//! Aggregate foreshadow operations used by narrative commits.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::codex_operations::PatchFieldString;

pub(crate) const OP_KIND_FORESHADOW_AGGREGATE_CREATE: &str = "foreshadow.aggregate.create";
pub(crate) const OP_KIND_FORESHADOW_AGGREGATE_PATCH: &str = "foreshadow.aggregate.patch";

type PrimaryPayoffMirror = (String, Option<i64>, Option<i64>, i64);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Setup {
    pub setup_id: String,
    pub scene_id: String,
    pub from_pos: i64,
    pub to_pos: i64,
    pub role: String,
    pub kind: String,
    #[serde(default)]
    pub ai_strength: Option<String>,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(default)]
    pub semantic_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Payoff {
    pub payoff_id: String,
    pub scene_id: String,
    pub from_pos: i64,
    pub to_pos: i64,
    pub role: String,
    pub confirmed: bool,
    pub primary: bool,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(default)]
    pub semantic_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Edge {
    pub setup_id: String,
    pub payoff_id: String,
    pub bridge_kind: String,
    #[serde(default)]
    pub explanation: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatePayload {
    pub foreshadow_id: String,
    pub hypothesis_id: String,
    pub title: String,
    #[serde(default)]
    pub intent: Option<String>,
    #[serde(default)]
    pub mechanism: Option<String>,
    pub secret: bool,
    #[serde(default)]
    pub setups: Vec<Setup>,
    #[serde(default)]
    pub payoffs: Vec<Payoff>,
    #[serde(default)]
    pub support_edges: Vec<Edge>,
    #[serde(default)]
    pub codex_entry_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PatchPayload {
    pub foreshadow_id: String,
    pub hypothesis_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub intent: Option<PatchFieldString>,
    #[serde(default)]
    pub mechanism: Option<PatchFieldString>,
    #[serde(default)]
    pub add_setups: Vec<Setup>,
    #[serde(default)]
    pub add_payoffs: Vec<Payoff>,
    #[serde(default)]
    pub add_support_edges: Vec<Edge>,
    #[serde(default)]
    pub add_codex_entry_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Result {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    pub before_snapshot: Option<Value>,
    pub op_kind: &'static str,
}

/// The complete domain state of a foreshadow aggregate. Timestamps are deliberately
/// excluded: replay preserves every author-visible field and child row while the root
/// OCC version and updated timestamp advance monotonically.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowAggregateSnapshot {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) title: String,
    pub(crate) intent: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) payoff_scene_id: Option<String>,
    pub(crate) payoff_from_pos: Option<i64>,
    pub(crate) payoff_to_pos: Option<i64>,
    pub(crate) payoff_confirmed: i64,
    pub(crate) abandoned: i64,
    pub(crate) secret: i64,
    pub(crate) load_bearing: Option<String>,
    pub(crate) mechanism: Option<String>,
    pub(crate) version: i64,
    pub(crate) codex_link_dirty_at: Option<i64>,
    pub(crate) setups: Vec<ForeshadowSetupSnapshot>,
    pub(crate) payoffs: Vec<ForeshadowPayoffSnapshot>,
    pub(crate) support_edges: Vec<ForeshadowSupportEdgeSnapshot>,
    pub(crate) codex_entry_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowSetupSnapshot {
    pub(crate) id: String,
    pub(crate) foreshadow_id: String,
    pub(crate) scene_id: String,
    pub(crate) from_pos: i64,
    pub(crate) to_pos: i64,
    pub(crate) kind: String,
    pub(crate) role: String,
    pub(crate) strength: Option<String>,
    pub(crate) ai_strength: Option<String>,
    pub(crate) ai_reasoning: Option<String>,
    pub(crate) attribution: String,
    pub(crate) ai_rationale: Option<String>,
    pub(crate) last_evaluated_at: Option<i64>,
    pub(crate) is_orphan: i64,
    pub(crate) evidence_anchor_id: Option<String>,
    pub(crate) semantic_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowPayoffSnapshot {
    pub(crate) id: String,
    pub(crate) foreshadow_id: String,
    pub(crate) scene_id: String,
    pub(crate) from_pos: Option<i64>,
    pub(crate) to_pos: Option<i64>,
    pub(crate) role: String,
    pub(crate) confirmed: i64,
    pub(crate) is_primary: i64,
    pub(crate) attribution: String,
    pub(crate) ai_rationale: Option<String>,
    pub(crate) is_orphan: i64,
    pub(crate) evidence_anchor_id: Option<String>,
    pub(crate) semantic_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowSupportEdgeSnapshot {
    pub(crate) foreshadow_id: String,
    pub(crate) setup_id: String,
    pub(crate) payoff_id: String,
    pub(crate) bridge_kind: String,
    pub(crate) explanation: Option<String>,
}

pub(crate) fn parse_create(value: &Value) -> anyhow::Result<CreatePayload> {
    serde_json::from_value(value.clone())
        .map_err(|err| anyhow::anyhow!("invalid foreshadow.aggregate.create payload: {err}"))
}

pub(crate) fn parse_patch(value: &Value) -> anyhow::Result<PatchPayload> {
    serde_json::from_value(value.clone())
        .map_err(|err| anyhow::anyhow!("invalid foreshadow.aggregate.patch payload: {err}"))
}

pub(crate) fn ensure_id_available(
    conn: &Connection,
    project_id: &str,
    id: &str,
) -> anyhow::Result<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM foreshadows WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        None => Ok(()),
        Some(owner) if owner == project_id => {
            anyhow::bail!("foreshadow '{id}' already exists in project '{project_id}'")
        }
        Some(owner) => {
            anyhow::bail!("foreshadow '{id}' belongs to project '{owner}', not '{project_id}'")
        }
    }
}

pub(crate) fn ensure_version(
    conn: &Connection,
    project_id: &str,
    id: &str,
    version: i64,
) -> anyhow::Result<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT version FROM foreshadows WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    match found {
        Some(found) if found == version => Ok(()),
        Some(found) => anyhow::bail!(
            "NEX_FORESHADOW_VERSION_MISMATCH: foreshadow '{id}' expected version {version}, found {found}"
        ),
        None => anyhow::bail!("foreshadow '{id}' not found in project '{project_id}'"),
    }
}

fn ensure_scene_in_project(conn: &Connection, project_id: &str, id: &str) -> anyhow::Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
        params![id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        count == 1,
        "scene '{id}' not found in project '{project_id}'"
    );
    Ok(())
}

fn ensure_codex_entry_in_project(
    conn: &Connection,
    project_id: &str,
    id: &str,
) -> anyhow::Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        count == 1,
        "codex entry '{id}' not found in project '{project_id}'"
    );
    Ok(())
}

fn semantic_key(
    root_id: &str,
    scene_id: &str,
    from_pos: i64,
    to_pos: i64,
    given: &Option<String>,
) -> String {
    given
        .clone()
        .unwrap_or_else(|| format!("{root_id}|{scene_id}|{from_pos}|{to_pos}"))
}

fn existing_setup_in_aggregate(
    conn: &Connection,
    project_id: &str,
    root_id: &str,
    setup_id: &str,
) -> anyhow::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM foreshadow_setups setup
              JOIN foreshadows root ON root.id = setup.foreshadow_id
             WHERE setup.id = ?1 AND setup.foreshadow_id = ?2 AND root.project_id = ?3
         )",
        params![setup_id, root_id, project_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn existing_payoff_in_aggregate(
    conn: &Connection,
    project_id: &str,
    root_id: &str,
    payoff_id: &str,
) -> anyhow::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM foreshadow_payoffs payoff
              JOIN foreshadows root ON root.id = payoff.foreshadow_id
             WHERE payoff.id = ?1 AND payoff.foreshadow_id = ?2 AND root.project_id = ?3
         )",
        params![payoff_id, root_id, project_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn validate_items(
    conn: &Connection,
    project_id: &str,
    root_id: &str,
    setups: &[Setup],
    payoffs: &[Payoff],
    edges: &[Edge],
    codex_entry_ids: &[String],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !setups.is_empty() || !payoffs.is_empty(),
        "foreshadow aggregate requires at least one setup or payoff"
    );

    for setup in setups {
        anyhow::ensure!(
            setup.from_pos >= 0 && setup.to_pos >= setup.from_pos,
            "invalid setup range"
        );
        ensure_scene_in_project(conn, project_id, &setup.scene_id)?;
    }
    for payoff in payoffs {
        anyhow::ensure!(
            payoff.from_pos >= 0 && payoff.to_pos >= payoff.from_pos,
            "invalid payoff range"
        );
        ensure_scene_in_project(conn, project_id, &payoff.scene_id)?;
    }
    for setup in setups {
        for payoff in payoffs {
            if setup.scene_id == payoff.scene_id {
                anyhow::ensure!(
                    setup.from_pos < payoff.from_pos,
                    "setup must precede payoff in the same scene"
                );
            }
        }
    }
    for edge in edges {
        let setup_owned = setups.iter().any(|setup| setup.setup_id == edge.setup_id)
            || existing_setup_in_aggregate(conn, project_id, root_id, &edge.setup_id)?;
        anyhow::ensure!(
            setup_owned,
            "support edge setup '{}' is not owned by foreshadow '{}' in project '{}'",
            edge.setup_id,
            root_id,
            project_id
        );
        let payoff_owned = payoffs
            .iter()
            .any(|payoff| payoff.payoff_id == edge.payoff_id)
            || existing_payoff_in_aggregate(conn, project_id, root_id, &edge.payoff_id)?;
        anyhow::ensure!(
            payoff_owned,
            "support edge payoff '{}' is not owned by foreshadow '{}' in project '{}'",
            edge.payoff_id,
            root_id,
            project_id
        );
    }
    for codex_entry_id in codex_entry_ids {
        ensure_codex_entry_in_project(conn, project_id, codex_entry_id)?;
    }
    Ok(())
}

fn insert_children(
    conn: &Connection,
    root_id: &str,
    setups: &[Setup],
    payoffs: &[Payoff],
    edges: &[Edge],
    codex_entry_ids: &[String],
) -> anyhow::Result<()> {
    let now = Utc::now().timestamp_millis();
    for setup in setups {
        conn.execute(
            "INSERT INTO foreshadow_setups
                (id, foreshadow_id, scene_id, from_pos, to_pos, kind, ai_strength,
                 ai_rationale, role, semantic_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                setup.setup_id,
                root_id,
                setup.scene_id,
                setup.from_pos,
                setup.to_pos,
                setup.kind,
                setup.ai_strength,
                setup.rationale,
                setup.role,
                semantic_key(
                    root_id,
                    &setup.scene_id,
                    setup.from_pos,
                    setup.to_pos,
                    &setup.semantic_key
                ),
                now,
            ],
        )?;
    }
    for payoff in payoffs {
        conn.execute(
            "INSERT INTO foreshadow_payoffs
                (id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
                 is_primary, attribution, ai_rationale, semantic_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ai', ?9, ?10, ?11, ?11)",
            params![
                payoff.payoff_id,
                root_id,
                payoff.scene_id,
                payoff.from_pos,
                payoff.to_pos,
                payoff.role,
                payoff.confirmed as i64,
                payoff.primary as i64,
                payoff.rationale,
                semantic_key(
                    root_id,
                    &payoff.scene_id,
                    payoff.from_pos,
                    payoff.to_pos,
                    &payoff.semantic_key
                ),
                now,
            ],
        )?;
    }
    for edge in edges {
        conn.execute(
            "INSERT INTO foreshadow_setup_payoff_links
                (foreshadow_id, setup_id, payoff_id, bridge_kind, explanation, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                root_id,
                edge.setup_id,
                edge.payoff_id,
                edge.bridge_kind,
                edge.explanation,
                now,
            ],
        )?;
    }
    for codex_entry_id in codex_entry_ids {
        conn.execute(
            "INSERT OR IGNORE INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
             VALUES (?1, ?2)",
            params![root_id, codex_entry_id],
        )?;
    }
    Ok(())
}

fn mirror_primary_payoff(conn: &Connection, root_id: &str) -> anyhow::Result<()> {
    let primary: Option<PrimaryPayoffMirror> = conn
        .query_row(
            "SELECT scene_id, from_pos, to_pos, confirmed
               FROM foreshadow_payoffs
              WHERE foreshadow_id = ?1 AND is_primary = 1
              ORDER BY id
              LIMIT 1",
            params![root_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    match primary {
        Some((scene_id, from_pos, to_pos, confirmed)) => {
            conn.execute(
                "UPDATE foreshadows
                    SET payoff_scene_id = ?1,
                        payoff_from_pos = ?2,
                        payoff_to_pos = ?3,
                        payoff_confirmed = ?4
                  WHERE id = ?5",
                params![scene_id, from_pos, to_pos, confirmed, root_id],
            )?;
        }
        None => {
            conn.execute(
                "UPDATE foreshadows
                    SET payoff_scene_id = NULL,
                        payoff_from_pos = NULL,
                        payoff_to_pos = NULL,
                        payoff_confirmed = 0
                  WHERE id = ?1",
                params![root_id],
            )?;
        }
    }
    Ok(())
}

pub(crate) fn collect_aggregate_snapshot(
    conn: &Connection,
    project_id: &str,
    id: &str,
) -> anyhow::Result<Value> {
    let mut snapshot: ForeshadowAggregateSnapshot = conn
        .query_row(
            "SELECT id, project_id, title, intent, notes, payoff_scene_id,
                    payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned,
                    secret, load_bearing, mechanism, version, codex_link_dirty_at
               FROM foreshadows
              WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |row| {
                Ok(ForeshadowAggregateSnapshot {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    intent: row.get(3)?,
                    notes: row.get(4)?,
                    payoff_scene_id: row.get(5)?,
                    payoff_from_pos: row.get(6)?,
                    payoff_to_pos: row.get(7)?,
                    payoff_confirmed: row.get(8)?,
                    abandoned: row.get(9)?,
                    secret: row.get(10)?,
                    load_bearing: row.get(11)?,
                    mechanism: row.get(12)?,
                    version: row.get(13)?,
                    codex_link_dirty_at: row.get(14)?,
                    setups: Vec::new(),
                    payoffs: Vec::new(),
                    support_edges: Vec::new(),
                    codex_entry_ids: Vec::new(),
                })
            },
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("foreshadow '{id}' not found in project '{project_id}'"))?;

    {
        let mut stmt = conn.prepare(
            "SELECT id, foreshadow_id, scene_id, from_pos, to_pos, kind, role,
                    strength, ai_strength, ai_reasoning, attribution, ai_rationale,
                    last_evaluated_at, is_orphan, evidence_anchor_id, semantic_key
               FROM foreshadow_setups
              WHERE foreshadow_id = ?1
              ORDER BY id",
        )?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(ForeshadowSetupSnapshot {
                id: row.get(0)?,
                foreshadow_id: row.get(1)?,
                scene_id: row.get(2)?,
                from_pos: row.get(3)?,
                to_pos: row.get(4)?,
                kind: row.get(5)?,
                role: row.get(6)?,
                strength: row.get(7)?,
                ai_strength: row.get(8)?,
                ai_reasoning: row.get(9)?,
                attribution: row.get(10)?,
                ai_rationale: row.get(11)?,
                last_evaluated_at: row.get(12)?,
                is_orphan: row.get(13)?,
                evidence_anchor_id: row.get(14)?,
                semantic_key: row.get(15)?,
            })
        })?;
        for row in rows {
            snapshot.setups.push(row?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
                    is_primary, attribution, ai_rationale, is_orphan,
                    evidence_anchor_id, semantic_key
               FROM foreshadow_payoffs
              WHERE foreshadow_id = ?1
              ORDER BY id",
        )?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(ForeshadowPayoffSnapshot {
                id: row.get(0)?,
                foreshadow_id: row.get(1)?,
                scene_id: row.get(2)?,
                from_pos: row.get(3)?,
                to_pos: row.get(4)?,
                role: row.get(5)?,
                confirmed: row.get(6)?,
                is_primary: row.get(7)?,
                attribution: row.get(8)?,
                ai_rationale: row.get(9)?,
                is_orphan: row.get(10)?,
                evidence_anchor_id: row.get(11)?,
                semantic_key: row.get(12)?,
            })
        })?;
        for row in rows {
            snapshot.payoffs.push(row?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT foreshadow_id, setup_id, payoff_id, bridge_kind, explanation
               FROM foreshadow_setup_payoff_links
              WHERE foreshadow_id = ?1
              ORDER BY setup_id, payoff_id",
        )?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(ForeshadowSupportEdgeSnapshot {
                foreshadow_id: row.get(0)?,
                setup_id: row.get(1)?,
                payoff_id: row.get(2)?,
                bridge_kind: row.get(3)?,
                explanation: row.get(4)?,
            })
        })?;
        for row in rows {
            snapshot.support_edges.push(row?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT codex_entry_id
               FROM foreshadow_codex_links
              WHERE foreshadow_id = ?1
              ORDER BY codex_entry_id",
        )?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        for row in rows {
            snapshot.codex_entry_ids.push(row?);
        }
    }

    serde_json::to_value(snapshot).map_err(Into::into)
}

pub(crate) fn apply_create(
    conn: &Connection,
    project_id: &str,
    payload: &CreatePayload,
    _now: &str,
) -> anyhow::Result<Result> {
    ensure_id_available(conn, project_id, &payload.foreshadow_id)?;
    validate_items(
        conn,
        project_id,
        &payload.foreshadow_id,
        &payload.setups,
        &payload.payoffs,
        &payload.support_edges,
        &payload.codex_entry_ids,
    )?;
    let stamp = Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO foreshadows
            (id, project_id, title, intent, mechanism, secret, notes, load_bearing,
             abandoned, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 0, 0, ?7, ?7)",
        params![
            payload.foreshadow_id,
            project_id,
            payload.title,
            payload.intent,
            payload.mechanism,
            payload.secret as i64,
            stamp,
        ],
    )?;
    insert_children(
        conn,
        &payload.foreshadow_id,
        &payload.setups,
        &payload.payoffs,
        &payload.support_edges,
        &payload.codex_entry_ids,
    )?;
    mirror_primary_payoff(conn, &payload.foreshadow_id)?;
    Ok(Result {
        entity_id: payload.foreshadow_id.clone(),
        version: 0,
        after_snapshot: collect_aggregate_snapshot(conn, project_id, &payload.foreshadow_id)?,
        before_snapshot: None,
        op_kind: "create",
    })
}

pub(crate) fn apply_patch(
    conn: &Connection,
    project_id: &str,
    payload: &PatchPayload,
    now: &str,
) -> anyhow::Result<Result> {
    ensure_version(
        conn,
        project_id,
        &payload.foreshadow_id,
        payload.base_version,
    )?;
    validate_items(
        conn,
        project_id,
        &payload.foreshadow_id,
        &payload.add_setups,
        &payload.add_payoffs,
        &payload.add_support_edges,
        &payload.add_codex_entry_ids,
    )?;
    let before_snapshot = collect_aggregate_snapshot(conn, project_id, &payload.foreshadow_id)?;
    insert_children(
        conn,
        &payload.foreshadow_id,
        &payload.add_setups,
        &payload.add_payoffs,
        &payload.add_support_edges,
        &payload.add_codex_entry_ids,
    )?;

    let (intent, mechanism): (Option<String>, Option<String>) = conn.query_row(
        "SELECT intent, mechanism FROM foreshadows
          WHERE id = ?1 AND project_id = ?2",
        params![payload.foreshadow_id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let update = |field: &Option<PatchFieldString>, old: Option<String>| match field {
        None => Ok(old),
        Some(value) if value.kind == "leave" => Ok(old),
        Some(value) if value.kind == "fill-if-empty" || value.kind == "set-if-empty" => {
            if old.as_deref().map(str::trim).unwrap_or("").is_empty() {
                Ok(value.value.clone())
            } else {
                Ok(old)
            }
        }
        Some(value) => {
            anyhow::bail!("unsupported foreshadow patch kind '{}'", value.kind)
        }
    };
    let next_intent = update(&payload.intent, intent)?;
    let next_mechanism = update(&payload.mechanism, mechanism)?;
    let next_version = payload
        .base_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("foreshadow version overflow"))?;
    let changed = conn.execute(
        "UPDATE foreshadows
            SET intent = ?1,
                mechanism = ?2,
                version = ?3,
                updated_at = ?4
          WHERE id = ?5 AND project_id = ?6 AND version = ?7",
        params![
            next_intent,
            next_mechanism,
            next_version,
            now,
            payload.foreshadow_id,
            project_id,
            payload.base_version,
        ],
    )?;
    anyhow::ensure!(
        changed == 1,
        "NEX_FORESHADOW_VERSION_MISMATCH: patch conflict"
    );
    mirror_primary_payoff(conn, &payload.foreshadow_id)?;
    Ok(Result {
        entity_id: payload.foreshadow_id.clone(),
        version: next_version,
        after_snapshot: collect_aggregate_snapshot(conn, project_id, &payload.foreshadow_id)?,
        before_snapshot: Some(before_snapshot),
        op_kind: "patch",
    })
}
