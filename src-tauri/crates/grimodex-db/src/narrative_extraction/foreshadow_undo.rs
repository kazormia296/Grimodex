//! Undo / redo helpers for aggregate foreshadows.
//!
//! A journal snapshot owns the root plus every setup, payoff, support edge, and Codex
//! link. Replaying a patch replaces that aggregate atomically while the root OCC version
//! always advances; replaying a create recreates the same aggregate with a newer version.

use std::collections::HashSet;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::foreshadow_operations::{
    collect_aggregate_snapshot, ForeshadowAggregateSnapshot, ForeshadowPayoffSnapshot,
    ForeshadowSetupSnapshot, ForeshadowSupportEdgeSnapshot,
};

const EDITED: &str = "NEX_COMMIT_FORESHADOW_EDITED";

fn parse_snapshot(value: &Value) -> anyhow::Result<ForeshadowAggregateSnapshot> {
    serde_json::from_value(value.clone())
        .map_err(|err| anyhow::anyhow!("foreshadow aggregate snapshot is invalid: {err}"))
}

fn ensure_scene_in_project(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
        params![scene_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        count == 1,
        "foreshadow replay scene '{scene_id}' is not owned by project '{project_id}'"
    );
    Ok(())
}

fn ensure_codex_entry_in_project(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
) -> anyhow::Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![entry_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        count == 1,
        "foreshadow replay Codex entry '{entry_id}' is not owned by project '{project_id}'"
    );
    Ok(())
}

fn validate_snapshot(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    snapshot: &ForeshadowAggregateSnapshot,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        snapshot.id == entity_id,
        "foreshadow snapshot id '{}' does not match journal entity '{}'",
        snapshot.id,
        entity_id
    );
    anyhow::ensure!(
        snapshot.project_id == project_id,
        "foreshadow snapshot project '{}' does not match replay project '{}'",
        snapshot.project_id,
        project_id
    );

    if let Some(scene_id) = snapshot.payoff_scene_id.as_deref() {
        ensure_scene_in_project(conn, project_id, scene_id)?;
    }

    let mut setup_ids = HashSet::new();
    for setup in &snapshot.setups {
        anyhow::ensure!(
            setup.foreshadow_id == entity_id,
            "foreshadow setup '{}' belongs to aggregate '{}', not '{}'",
            setup.id,
            setup.foreshadow_id,
            entity_id
        );
        anyhow::ensure!(
            setup_ids.insert(setup.id.as_str()),
            "duplicate foreshadow setup '{}' in replay snapshot",
            setup.id
        );
        ensure_scene_in_project(conn, project_id, &setup.scene_id)?;
    }

    let mut payoff_ids = HashSet::new();
    for payoff in &snapshot.payoffs {
        anyhow::ensure!(
            payoff.foreshadow_id == entity_id,
            "foreshadow payoff '{}' belongs to aggregate '{}', not '{}'",
            payoff.id,
            payoff.foreshadow_id,
            entity_id
        );
        anyhow::ensure!(
            payoff_ids.insert(payoff.id.as_str()),
            "duplicate foreshadow payoff '{}' in replay snapshot",
            payoff.id
        );
        ensure_scene_in_project(conn, project_id, &payoff.scene_id)?;
    }

    let mut edge_keys = HashSet::new();
    for edge in &snapshot.support_edges {
        anyhow::ensure!(
            edge.foreshadow_id == entity_id,
            "foreshadow support edge belongs to aggregate '{}', not '{}'",
            edge.foreshadow_id,
            entity_id
        );
        anyhow::ensure!(
            setup_ids.contains(edge.setup_id.as_str()),
            "foreshadow support edge setup '{}' is outside aggregate '{}'",
            edge.setup_id,
            entity_id
        );
        anyhow::ensure!(
            payoff_ids.contains(edge.payoff_id.as_str()),
            "foreshadow support edge payoff '{}' is outside aggregate '{}'",
            edge.payoff_id,
            entity_id
        );
        anyhow::ensure!(
            edge_keys.insert((edge.setup_id.as_str(), edge.payoff_id.as_str())),
            "duplicate foreshadow support edge '{} -> {}' in replay snapshot",
            edge.setup_id,
            edge.payoff_id
        );
    }

    let mut codex_ids = HashSet::new();
    for entry_id in &snapshot.codex_entry_ids {
        anyhow::ensure!(
            codex_ids.insert(entry_id.as_str()),
            "duplicate Codex link '{}' in foreshadow replay snapshot",
            entry_id
        );
        ensure_codex_entry_in_project(conn, project_id, entry_id)?;
    }
    Ok(())
}

fn ensure_no_cross_aggregate_edges(conn: &Connection, entity_id: &str) -> anyhow::Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM foreshadow_setup_payoff_links edge
           JOIN foreshadow_setups setup ON setup.id = edge.setup_id
           JOIN foreshadow_payoffs payoff ON payoff.id = edge.payoff_id
          WHERE (edge.foreshadow_id = ?1
                 AND (setup.foreshadow_id <> ?1 OR payoff.foreshadow_id <> ?1))
             OR (edge.foreshadow_id <> ?1
                 AND (setup.foreshadow_id = ?1 OR payoff.foreshadow_id = ?1))",
        params![entity_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        count == 0,
        "NEX_UNDO_EXTERNAL_DEPENDENCY: foreshadow '{entity_id}' has a cross-aggregate support edge"
    );
    Ok(())
}

pub(crate) fn ensure_matches_snapshot(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    expected: &Value,
    expected_version: i64,
) -> anyhow::Result<()> {
    let expected_snapshot = parse_snapshot(expected)?;
    validate_snapshot(conn, project_id, entity_id, &expected_snapshot)?;
    anyhow::ensure!(
        expected_snapshot.version == expected_version,
        "foreshadow journal version {} does not match snapshot version {}",
        expected_version,
        expected_snapshot.version
    );
    ensure_no_cross_aggregate_edges(conn, entity_id)?;

    let current = collect_aggregate_snapshot(conn, project_id, entity_id).map_err(|err| {
        anyhow::anyhow!(
            "{EDITED}: foreshadow '{entity_id}' is missing or no longer project-owned: {err}"
        )
    })?;
    let expected_value = serde_json::to_value(expected_snapshot)?;
    anyhow::ensure!(
        current == expected_value,
        "{EDITED}: foreshadow '{entity_id}' aggregate was modified after commit"
    );
    Ok(())
}

pub(crate) fn ensure_absent_for_redo(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    snapshot: &Value,
) -> anyhow::Result<()> {
    let parsed = parse_snapshot(snapshot)?;
    validate_snapshot(conn, project_id, entity_id, &parsed)?;
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM foreshadows WHERE id = ?1",
            params![entity_id],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        owner.is_none(),
        "{EDITED}: foreshadow '{entity_id}' still exists before redo"
    );
    Ok(())
}

/// Delete a restored aggregate only when every author-visible root and child field
/// still matches the journal snapshot. The snapshot's historical version is
/// normalized to the journal's current live token before comparison.
pub(crate) fn delete_snapshot_at_version(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    snapshot: &Value,
    expected_live_version: i64,
) -> anyhow::Result<()> {
    let mut expected = parse_snapshot(snapshot)?;
    expected.version = expected_live_version;
    validate_snapshot(conn, project_id, entity_id, &expected)?;
    ensure_no_cross_aggregate_edges(conn, entity_id)?;

    let current = collect_aggregate_snapshot(conn, project_id, entity_id).map_err(|err| {
        anyhow::anyhow!(
            "{EDITED}: foreshadow '{entity_id}' is missing or no longer project-owned: {err}"
        )
    })?;
    anyhow::ensure!(
        current == serde_json::to_value(&expected)?,
        "{EDITED}: foreshadow '{entity_id}' aggregate was modified after restore"
    );

    let deleted = conn.execute(
        "DELETE FROM foreshadows
          WHERE id = ?1 AND project_id = ?2 AND version = ?3",
        params![entity_id, project_id, expected_live_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "{EDITED}: foreshadow '{entity_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn undo_created(
    conn: &Connection,
    project_id: &str,
    id: &str,
    version: i64,
) -> anyhow::Result<()> {
    let deleted = conn.execute(
        "DELETE FROM foreshadows
          WHERE id = ?1 AND project_id = ?2 AND version = ?3",
        params![id, project_id, version],
    )?;
    anyhow::ensure!(deleted == 1, "{EDITED}: foreshadow '{id}' delete conflict");
    Ok(())
}

fn clear_children(conn: &Connection, entity_id: &str) -> anyhow::Result<()> {
    ensure_no_cross_aggregate_edges(conn, entity_id)?;
    conn.execute(
        "DELETE FROM foreshadow_setup_payoff_links WHERE foreshadow_id = ?1",
        params![entity_id],
    )?;
    conn.execute(
        "DELETE FROM foreshadow_codex_links WHERE foreshadow_id = ?1",
        params![entity_id],
    )?;
    conn.execute(
        "DELETE FROM foreshadow_setups WHERE foreshadow_id = ?1",
        params![entity_id],
    )?;
    conn.execute(
        "DELETE FROM foreshadow_payoffs WHERE foreshadow_id = ?1",
        params![entity_id],
    )?;
    Ok(())
}

fn insert_setup_snapshot(
    conn: &Connection,
    setup: &ForeshadowSetupSnapshot,
    timestamp: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO foreshadow_setups
            (id, foreshadow_id, scene_id, from_pos, to_pos, kind, role, strength,
             ai_strength, ai_reasoning, attribution, ai_rationale, last_evaluated_at,
             is_orphan, evidence_anchor_id, semantic_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?17)",
        params![
            setup.id,
            setup.foreshadow_id,
            setup.scene_id,
            setup.from_pos,
            setup.to_pos,
            setup.kind,
            setup.role,
            setup.strength,
            setup.ai_strength,
            setup.ai_reasoning,
            setup.attribution,
            setup.ai_rationale,
            setup.last_evaluated_at,
            setup.is_orphan,
            setup.evidence_anchor_id,
            setup.semantic_key,
            timestamp,
        ],
    )?;
    Ok(())
}

fn insert_payoff_snapshot(
    conn: &Connection,
    payoff: &ForeshadowPayoffSnapshot,
    timestamp: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO foreshadow_payoffs
            (id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
             is_primary, attribution, ai_rationale, is_orphan, evidence_anchor_id,
             semantic_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?14)",
        params![
            payoff.id,
            payoff.foreshadow_id,
            payoff.scene_id,
            payoff.from_pos,
            payoff.to_pos,
            payoff.role,
            payoff.confirmed,
            payoff.is_primary,
            payoff.attribution,
            payoff.ai_rationale,
            payoff.is_orphan,
            payoff.evidence_anchor_id,
            payoff.semantic_key,
            timestamp,
        ],
    )?;
    Ok(())
}

fn insert_support_edge_snapshot(
    conn: &Connection,
    edge: &ForeshadowSupportEdgeSnapshot,
    timestamp: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO foreshadow_setup_payoff_links
            (foreshadow_id, setup_id, payoff_id, bridge_kind, explanation, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            edge.foreshadow_id,
            edge.setup_id,
            edge.payoff_id,
            edge.bridge_kind,
            edge.explanation,
            timestamp,
        ],
    )?;
    Ok(())
}

fn insert_children_from_snapshot(
    conn: &Connection,
    snapshot: &ForeshadowAggregateSnapshot,
) -> anyhow::Result<()> {
    let timestamp = Utc::now().timestamp_millis();
    for setup in &snapshot.setups {
        insert_setup_snapshot(conn, setup, timestamp)?;
    }
    for payoff in &snapshot.payoffs {
        insert_payoff_snapshot(conn, payoff, timestamp)?;
    }
    for edge in &snapshot.support_edges {
        insert_support_edge_snapshot(conn, edge, timestamp)?;
    }
    for entry_id in &snapshot.codex_entry_ids {
        conn.execute(
            "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
             VALUES (?1, ?2)",
            params![snapshot.id, entry_id],
        )?;
    }
    Ok(())
}

fn expected_with_version(
    snapshot: &ForeshadowAggregateSnapshot,
    version: i64,
) -> anyhow::Result<Value> {
    let mut expected = snapshot.clone();
    expected.version = version;
    serde_json::to_value(expected).map_err(Into::into)
}

pub(crate) fn restore_patch(
    conn: &Connection,
    project_id: &str,
    id: &str,
    target: &Value,
    expected_live_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let target = parse_snapshot(target)?;
    validate_snapshot(conn, project_id, id, &target)?;
    ensure_no_cross_aggregate_edges(conn, id)?;

    let live_version: Option<i64> = conn
        .query_row(
            "SELECT version FROM foreshadows WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        live_version == Some(expected_live_version),
        "{EDITED}: foreshadow '{id}' version mismatch during aggregate replay"
    );
    let next_version = expected_live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("foreshadow version overflow during replay"))?;

    let updated = conn.execute(
        "UPDATE foreshadows
            SET title = ?1,
                intent = ?2,
                notes = ?3,
                payoff_scene_id = ?4,
                payoff_from_pos = ?5,
                payoff_to_pos = ?6,
                payoff_confirmed = ?7,
                abandoned = ?8,
                secret = ?9,
                load_bearing = ?10,
                mechanism = ?11,
                codex_link_dirty_at = ?12,
                version = ?13,
                updated_at = ?14
          WHERE id = ?15 AND project_id = ?16 AND version = ?17",
        params![
            target.title,
            target.intent,
            target.notes,
            target.payoff_scene_id,
            target.payoff_from_pos,
            target.payoff_to_pos,
            target.payoff_confirmed,
            target.abandoned,
            target.secret,
            target.load_bearing,
            target.mechanism,
            target.codex_link_dirty_at,
            next_version,
            now,
            id,
            project_id,
            expected_live_version,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "{EDITED}: foreshadow '{id}' aggregate restore conflict"
    );

    clear_children(conn, id)?;
    insert_children_from_snapshot(conn, &target)?;

    let restored = collect_aggregate_snapshot(conn, project_id, id)?;
    anyhow::ensure!(
        restored == expected_with_version(&target, next_version)?,
        "foreshadow '{id}' aggregate replay did not restore the exact target snapshot"
    );
    Ok(next_version)
}

pub(crate) fn reapply_created_snapshot(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    snapshot: &Value,
    previous_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let mut target = parse_snapshot(snapshot)?;
    validate_snapshot(conn, project_id, entity_id, &target)?;
    ensure_absent_for_redo(conn, project_id, entity_id, snapshot)?;

    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("foreshadow version overflow during redo"))?;
    target.version = replay_version;
    conn.execute(
        "INSERT INTO foreshadows
            (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos,
             payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing,
             mechanism, version, codex_link_dirty_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?16)",
        params![
            target.id,
            target.project_id,
            target.title,
            target.intent,
            target.notes,
            target.payoff_scene_id,
            target.payoff_from_pos,
            target.payoff_to_pos,
            target.payoff_confirmed,
            target.abandoned,
            target.secret,
            target.load_bearing,
            target.mechanism,
            replay_version,
            target.codex_link_dirty_at,
            now,
        ],
    )?;
    insert_children_from_snapshot(conn, &target)?;

    let restored = collect_aggregate_snapshot(conn, project_id, entity_id)?;
    anyhow::ensure!(
        restored == serde_json::to_value(&target)?,
        "foreshadow '{entity_id}' create redo did not restore the exact target snapshot"
    );
    Ok(replay_version)
}
