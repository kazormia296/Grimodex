//! Test-only setters for the declaration columns.
//!
//! The only production path that may set the columns to non-NULL is the
//! declaration writer that consumes a Main confirmation (CB-2). Until it
//! exists these helpers stand in for it, so that every CB-1 test and the S3/S4
//! restore tests can place a declaration. They are `#[cfg(test)]` and are not
//! reachable from a product build.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;
use uuid::Uuid;

use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationBindingV1, NarrativeSceneBodyDeclarationV1,
    NarrativeSceneBodySourceV1,
};

use super::{canonical_scene_body_declaration_snapshot, scene_body_declaration_feed_event};
use crate::change_events::AppendChangeEvent;
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};

pub(crate) const TEST_DECLARED_AT: &str = "2026-10-17T00:00:00.000Z";

pub(crate) fn test_digest(seed: char) -> String {
    format!("sha256:{}", seed.to_string().repeat(64))
}

/// A well-formed binding for the Scene as it is right now: its incarnation and
/// v1 token are read from the binding row; the body, title, workspace and
/// locator components are fixed placeholders.
pub(crate) fn test_declaration_binding(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<NarrativeSceneBodyDeclarationBindingV1> {
    let (incarnation, scope_token): (String, String) = conn.query_row(
        "SELECT scene_incarnation_id, source_token
           FROM narrative_scene_scope_bindings
          WHERE project_id = ?1 AND scene_id = ?2",
        params![project_id, scene_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (version, updated_at): (i64, String) = conn.query_row(
        "SELECT version, updated_at FROM tree_nodes WHERE id = ?1",
        params![scene_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(NarrativeSceneBodyDeclarationBindingV1 {
        project_id: project_id.to_owned(),
        scene_id: scene_id.to_owned(),
        scene_incarnation_id: incarnation,
        scope_source_token: scope_token,
        body_source: NarrativeSceneBodySourceV1 {
            source_identity: format!("project:scene:{scene_id}"),
            source_token: format!("v{version}@{updated_at}"),
            storage_digest: test_digest('b'),
            canonical_digest: test_digest('c'),
            normalizer_version: "gdx-canonical-text/1".to_owned(),
            utf16_length: 42,
        },
        title_digest: test_digest('d'),
        workspace_id: "test-workspace".to_owned(),
        canonical_locator_digest: test_digest('e'),
    })
}

pub(crate) fn test_declaration(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<NarrativeSceneBodyDeclarationV1> {
    NarrativeSceneBodyDeclarationV1::new(
        Uuid::new_v4().to_string(),
        TEST_DECLARED_AT,
        test_declaration_binding(conn, project_id, scene_id)?,
    )
}

/// Writes the two declaration columns (and nothing else on the row) and the
/// canonical and feed events of the change, in the caller's transaction.
pub(crate) fn set_scene_body_declaration_for_test(
    conn: &Connection,
    declaration: &NarrativeSceneBodyDeclarationV1,
) -> Result<()> {
    let project_id = &declaration.binding.project_id;
    let scene_id = &declaration.binding.scene_id;
    let before = canonical_scene_body_declaration_snapshot(conn, project_id, scene_id)?;
    let changed = conn.execute(
        "UPDATE narrative_scene_scope_bindings
            SET body_declaration_json = ?3, body_declaration_token = ?4
          WHERE project_id = ?1 AND scene_id = ?2",
        params![
            project_id,
            scene_id,
            declaration.canonical_json()?,
            declaration.token()?
        ],
    )?;
    anyhow::ensure!(changed == 1, "scene scope binding row is missing");
    let after = canonical_scene_body_declaration_snapshot(conn, project_id, scene_id)?;
    append_declaration_change_for_test(conn, project_id, scene_id, &before, &after)
}

/// Sets raw cell values with no validation and no feed event, to build the
/// half-declared, corrupted and oversized rows the reader and the clear must
/// survive.
pub(crate) fn set_raw_declaration_cells_for_test(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    json_cell: rusqlite::types::Value,
    token_cell: rusqlite::types::Value,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE narrative_scene_scope_bindings
            SET body_declaration_json = ?3, body_declaration_token = ?4
          WHERE project_id = ?1 AND scene_id = ?2",
        params![project_id, scene_id, json_cell, token_cell],
    )?;
    anyhow::ensure!(changed == 1, "scene scope binding row is missing");
    Ok(())
}

pub(crate) fn append_declaration_change_for_test(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    before: &serde_json::Value,
    after: &serde_json::Value,
) -> Result<()> {
    append_events_for_test(
        conn,
        project_id,
        scene_id,
        vec![scene_body_declaration_feed_event(scene_id, before, after)?],
    )
}

/// Appends one canonical event and one feed transaction made of `events`.
pub(crate) fn append_events_for_test(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    events: Vec<NarrativeChangeEventInput>,
) -> Result<()> {
    let event_uid = Uuid::new_v4().to_string();
    append_canonical_and_narrative_change_in_tx(
        conn,
        project_id,
        "declaration-test-session",
        &AppendChangeEvent {
            event_uid: event_uid.clone(),
            scene_id: Some(scene_id.to_owned()),
            domain: "narrative".to_owned(),
            op_type: "scene.body-declaration.test".to_owned(),
            entity_type: Some("scene_body_declaration".to_owned()),
            entity_id: Some(scene_id.to_owned()),
            payload: json!({ "sceneId": scene_id }).to_string(),
            timestamp: 1_792_000_000_000,
        },
        &AppendNarrativeChangeTransactionInput {
            project_id: project_id.to_owned(),
            request_id: Uuid::new_v4().to_string(),
            source_domain: "scene.body-declaration.test".to_owned(),
            source_change_event_uid: event_uid,
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: Vec::new(),
            occurred_at: TEST_DECLARED_AT.to_owned(),
            events,
        },
    )?;
    Ok(())
}
