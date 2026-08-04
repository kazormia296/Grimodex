//! Typed persistence for Editor-only visual sticky notes.
//!
//! Sticky bodies are deliberately not part of the manuscript/content
//! pipelines. This module keeps their ownership, placement, and optimistic
//! concurrency checks in the native database boundary so the renderer does
//! not issue generic SQL for a display-only UI feature.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::Database;

const CONFLICT_MARKER: &str = "EDITOR_STICKY_CONFLICT";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePayload {
    pub project_id: String,
    pub document_key: String,
    pub body: String,
    pub palette_id: String,
    pub color_slot: i64,
    pub inline_offset: f64,
    pub block_offset: f64,
    pub z_index: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePayload {
    pub project_id: String,
    pub sticky_id: String,
    pub patch: Patch,
    pub base_version: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub body: Option<String>,
    pub palette_id: Option<String>,
    pub color_slot: Option<i64>,
    pub inline_offset: Option<f64>,
    pub block_offset: Option<f64>,
    pub z_index: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePayload {
    pub project_id: String,
    pub sticky_id: String,
    pub base_version: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub project_id: String,
    pub document_key: String,
    pub body: String,
    pub palette_id: String,
    pub color_slot: i64,
    pub inline_offset: f64,
    pub block_offset: f64,
    pub z_index: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Default)]
struct Owners {
    tree_node_id: Option<String>,
    codex_entry_id: Option<String>,
    phase_id: Option<String>,
    snippet_id: Option<String>,
    chronicle_event_id: Option<String>,
}

fn require_non_empty(value: &str, field: &str) -> Result<()> {
    if value.is_empty() {
        bail!("editor sticky {field} must not be empty");
    }
    Ok(())
}

fn require_finite(value: f64, field: &str) -> Result<()> {
    if !value.is_finite() {
        bail!("editor sticky {field} must be finite");
    }
    Ok(())
}

fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn decode_component(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            bail!("invalid percent-encoded document key");
        }
        let high = decode_hex(bytes[index + 1]).context("invalid document key escape")?;
        let low = decode_hex(bytes[index + 2]).context("invalid document key escape")?;
        decoded.push(high * 16 + low);
        index += 3;
    }
    String::from_utf8(decoded).context("document key is not valid UTF-8")
}

fn owners_for_document_key(document_key: &str) -> Result<Owners> {
    if let Some(id) = document_key
        .strip_prefix("tree:database:")
        .or_else(|| document_key.strip_prefix("tree:file:"))
    {
        return Ok(Owners {
            tree_node_id: Some(decode_component(id)?),
            ..Owners::default()
        });
    }
    if let Some(rest) = document_key.strip_prefix("codex:") {
        let (id, variant) = rest
            .split_once(':')
            .context("codex document key is missing its mode")?;
        let entry_id = decode_component(id)?;
        let phase_id = if variant == "base" {
            None
        } else if let Some(phase) = variant.strip_prefix("phase:") {
            Some(decode_component(phase)?)
        } else {
            bail!("unsupported codex document key mode");
        };
        return Ok(Owners {
            codex_entry_id: Some(entry_id),
            phase_id,
            ..Owners::default()
        });
    }
    if let Some(id) = document_key.strip_prefix("snippet:") {
        return Ok(Owners {
            snippet_id: Some(decode_component(id)?),
            ..Owners::default()
        });
    }
    if let Some(id) = document_key.strip_prefix("chronicle-event:") {
        return Ok(Owners {
            chronicle_event_id: Some(decode_component(id)?),
            ..Owners::default()
        });
    }
    bail!("unsupported editor sticky document key")
}

fn ensure_owner_in_project(conn: &Connection, project_id: &str, owners: &Owners) -> Result<()> {
    if let Some(id) = &owners.tree_node_id {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                params![id, project_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            bail!("editor sticky tree document is not in the requested project");
        }
    } else if let Some(id) = &owners.codex_entry_id {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                params![id, project_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            bail!("editor sticky Codex document is not in the requested project");
        }
        if let Some(phase_id) = &owners.phase_id {
            let phase_exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM codex_entry_phases
                      WHERE id = ?1 AND entry_id = ?2",
                    params![phase_id, id],
                    |row| row.get(0),
                )
                .optional()?;
            if phase_exists.is_none() {
                bail!("editor sticky Codex phase is not owned by the entry");
            }
        }
    } else if let Some(id) = &owners.snippet_id {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM snippets WHERE id = ?1 AND project_id = ?2",
                params![id, project_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            bail!("editor sticky snippet is not in the requested project");
        }
    } else if let Some(id) = &owners.chronicle_event_id {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM events WHERE id = ?1 AND project_id = ?2",
                params![id, project_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            bail!("editor sticky chronicle event is not in the requested project");
        }
    } else {
        bail!("editor sticky document has no typed owner");
    }
    Ok(())
}

fn validate_patch(patch: &Patch) -> Result<()> {
    if patch.body.is_none()
        && patch.palette_id.is_none()
        && patch.color_slot.is_none()
        && patch.inline_offset.is_none()
        && patch.block_offset.is_none()
        && patch.z_index.is_none()
    {
        bail!("editor sticky update must contain a patch");
    }
    if let Some(body) = &patch.body {
        require_non_empty(body, "body")?;
    }
    if let Some(palette_id) = &patch.palette_id {
        require_non_empty(palette_id, "paletteId")?;
    }
    if let Some(color_slot) = patch.color_slot {
        if color_slot < 0 {
            bail!("editor sticky colorSlot must not be negative");
        }
    }
    if let Some(inline_offset) = patch.inline_offset {
        require_finite(inline_offset, "inlineOffset")?;
    }
    if let Some(block_offset) = patch.block_offset {
        require_finite(block_offset, "blockOffset")?;
    }
    Ok(())
}

fn row_to_entry(row: &Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        document_key: row.get("document_key")?,
        body: row.get("body")?,
        palette_id: row.get("palette_id")?,
        color_slot: row.get("color_slot")?,
        inline_offset: row.get("inline_offset")?,
        block_offset: row.get("block_offset")?,
        z_index: row.get("z_index")?,
        version: row.get("version")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list(db: &Database, project_id: String, document_key: String) -> Result<Vec<Entry>> {
    require_non_empty(&project_id, "projectId")?;
    require_non_empty(&document_key, "documentKey")?;
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, project_id, document_key, body, palette_id, color_slot,
                    inline_offset, block_offset, z_index, version, created_at, updated_at
               FROM editor_stickies
              WHERE project_id = ?1 AND document_key = ?2
              ORDER BY z_index ASC, created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![project_id, document_key], row_to_entry)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    })
}

pub fn create(db: &Database, payload: CreatePayload) -> Result<Entry> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.document_key, "documentKey")?;
    require_non_empty(&payload.body, "body")?;
    require_non_empty(&payload.palette_id, "paletteId")?;
    if payload.color_slot < 0 {
        bail!("editor sticky colorSlot must not be negative");
    }
    require_finite(payload.inline_offset, "inlineOffset")?;
    require_finite(payload.block_offset, "blockOffset")?;
    let owners = owners_for_document_key(&payload.document_key)?;

    db.with_conn(|conn| {
        ensure_owner_in_project(conn, &payload.project_id, &owners)?;
        let id = Uuid::new_v4().to_string();
        Ok(conn.query_row(
            "INSERT INTO editor_stickies (
                 id, project_id, document_key, body, palette_id, color_slot,
                 inline_offset, block_offset, z_index, version,
                 tree_node_id, codex_entry_id, phase_id, snippet_id, chronicle_event_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13, ?14)
             RETURNING id, project_id, document_key, body, palette_id, color_slot,
                       inline_offset, block_offset, z_index, version, created_at, updated_at",
            params![
                id,
                payload.project_id,
                payload.document_key,
                payload.body,
                payload.palette_id,
                payload.color_slot,
                payload.inline_offset,
                payload.block_offset,
                payload.z_index,
                owners.tree_node_id,
                owners.codex_entry_id,
                owners.phase_id,
                owners.snippet_id,
                owners.chronicle_event_id,
            ],
            row_to_entry,
        )?)
    })
}

pub fn update(db: &Database, payload: UpdatePayload) -> Result<Entry> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.sticky_id, "stickyId")?;
    if payload.base_version < 0 {
        bail!("editor sticky baseVersion must not be negative");
    }
    validate_patch(&payload.patch)?;

    db.with_conn(|conn| {
        conn.query_row(
            "UPDATE editor_stickies
                SET body = COALESCE(?1, body),
                    palette_id = COALESCE(?2, palette_id),
                    color_slot = COALESCE(?3, color_slot),
                    inline_offset = COALESCE(?4, inline_offset),
                    block_offset = COALESCE(?5, block_offset),
                    z_index = COALESCE(?6, z_index),
                    version = version + 1,
                    updated_at = datetime('now')
              WHERE id = ?7 AND project_id = ?8 AND version = ?9
             RETURNING id, project_id, document_key, body, palette_id, color_slot,
                       inline_offset, block_offset, z_index, version, created_at, updated_at",
            params![
                payload.patch.body,
                payload.patch.palette_id,
                payload.patch.color_slot,
                payload.patch.inline_offset,
                payload.patch.block_offset,
                payload.patch.z_index,
                payload.sticky_id,
                payload.project_id,
                payload.base_version,
            ],
            row_to_entry,
        )
        .optional()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{CONFLICT_MARKER}:{}:{}",
                payload.sticky_id,
                payload.base_version
            )
        })
    })
}

pub fn delete(db: &Database, payload: DeletePayload) -> Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.sticky_id, "stickyId")?;
    if payload.base_version < 0 {
        bail!("editor sticky baseVersion must not be negative");
    }
    db.with_conn(|conn| {
        let deleted = conn.execute(
            "DELETE FROM editor_stickies
              WHERE id = ?1 AND project_id = ?2 AND version = ?3",
            params![payload.sticky_id, payload.project_id, payload.base_version],
        )?;
        if deleted == 0 {
            bail!(
                "{CONFLICT_MARKER}:{}:{}",
                payload.sticky_id,
                payload.base_version
            );
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{decode_component, owners_for_document_key};

    #[test]
    fn decodes_document_key_components_without_treating_slashes_as_paths() {
        assert_eq!(decode_component("scene%2F%E5%BA%8F").unwrap(), "scene/序");
    }

    #[test]
    fn maps_codex_phase_to_both_typed_owner_columns() {
        let owners = owners_for_document_key("codex:entry%3A1:phase:phase%2F1").unwrap();
        assert_eq!(owners.codex_entry_id.as_deref(), Some("entry:1"));
        assert_eq!(owners.phase_id.as_deref(), Some("phase/1"));
        assert!(owners.tree_node_id.is_none());
    }
}
