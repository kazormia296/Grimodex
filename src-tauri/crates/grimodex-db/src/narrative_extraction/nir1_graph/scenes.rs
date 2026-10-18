//! Bounded, request-local Scene association and body source helpers.
//!
//! `scene_codex_pins` is only a locator.  A pin is not Relation evidence, a
//! body mention, or a substitute for the Entity/Relation A2/A3 proof.  The
//! caller must independently validate the target Scene scope and keep the
//! read-identity bracket around both the pin read and the returned result.
//!
//! The C-query worker uses only the locator readers (pin pages, the has-more
//! probe and the Scene token reader). It never reads a Scene body: the body
//! reader and the Scene scope/recheck helpers belong to the parent-side
//! qualification (CB-4) and carry item-level dead-code expectations.

use anyhow::{ensure, Result};
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneScopeBindingV1, NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1,
    NarrativeScopePrincipalV1,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::cell::RefCell;

use super::super::change_feed::{
    canonical_scene_storage_with_admission, CANONICAL_TEXT_NORMALIZER_VERSION,
};

/// The existing C-query owns one cumulative budget.  It must pass the same
/// instance to every pin/source helper; constructing one per candidate would
/// silently turn the Graph-wide limit into a per-Scene limit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct SceneJoinBudget {
    rows: usize,
    bytes: usize,
    max_rows: usize,
    max_bytes: usize,
}

impl SceneJoinBudget {
    pub(super) const fn new(max_rows: usize, max_bytes: usize) -> Self {
        Self {
            rows: 0,
            bytes: 0,
            max_rows,
            max_bytes,
        }
    }

    pub(super) fn admit(&mut self, rows: usize, bytes: usize) -> Result<()> {
        self.rows = self
            .rows
            .checked_add(rows)
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_READ_LIMIT"))?;
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))?;
        ensure!(
            self.rows <= self.max_rows && self.bytes <= self.max_bytes,
            "NIR1_GRAPH_SCENE_QUERY_RESOURCE_LIMIT"
        );
        Ok(())
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "cumulative-budget accessors for the parent-side CB-4 reader"
        )
    )]
    pub(super) const fn rows(&self) -> usize {
        self.rows
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "cumulative-budget accessors for the parent-side CB-4 reader"
        )
    )]
    pub(super) const fn bytes(&self) -> usize {
        self.bytes
    }

    pub(super) const fn remaining_rows(&self) -> usize {
        self.max_rows.saturating_sub(self.rows)
    }

    pub(super) const fn remaining_bytes(&self) -> usize {
        self.max_bytes.saturating_sub(self.bytes)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScenePinLocator {
    /// SQLite rowid is only a request-local cursor/fingerprint.  It is never
    /// treated as a durable identity across delete/reinsert or restore.
    pub rowid: i64,
    pub scene_id: String,
    pub entry_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SceneBodyAnchor {
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub excerpt: String,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SceneSourceBinding {
    pub source_kind: &'static str,
    pub source_key: String,
    pub revision_token: String,
    pub source_version: i64,
    pub normalizer_version: &'static str,
    pub storage_digest: String,
    pub canonical_digest: String,
    pub canonical_utf16_length: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SceneSourceLocator {
    pub pin: ScenePinLocator,
    pub source: SceneSourceBinding,
    pub anchor: SceneBodyAnchor,
}

/// All Scene scope checks are explicit inputs from the query owner.  In
/// particular, this type has no Entity POV/phase fields to accidentally copy
/// into the Scene candidate.
#[derive(Clone, Copy)]
pub(super) struct SceneScopeExpectation<'a> {
    pub project_id: &'a str,
    pub scene_id: &'a str,
    pub scene_incarnation_id: &'a str,
    pub scope_token: &'a str,
    pub timeline: &'a str,
    pub worldline: &'a str,
    pub narrative_layer: &'a str,
    pub knowledge_holder: &'a NarrativeScopePrincipalV1,
    pub audience: &'a NarrativeScopePrincipalV1,
    pub candidate_reading_rank: u64,
    pub query_reading_rank: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PinLengths {
    rowid: i64,
    scene_bytes: usize,
    entry_bytes: usize,
    created_at_bytes: usize,
}

/// One keyset page; the C-query also counts every page against its 32.
pub(super) const PIN_PAGE_ROWS: usize = 16;
const MAX_PIN_FIELD_BYTES: usize = 2 * 1024 * 1024;
const SHA256_DIGEST_BYTES: usize = "sha256:".len() + 64;
const SOURCE_KEY_PREFIX: &str = "project:scene:";
const MAX_I64_DECIMAL_BYTES: usize = 20;
// The exact Entity key and keyset cursor use the entry index; a missing index
// fails statement preparation instead of silently scanning the pin table.
const PIN_LENGTHS_SQL: &str = "SELECT p.rowid,
    octet_length(p.scene_id), octet_length(p.entry_id), octet_length(p.created_at)
    FROM scene_codex_pins p INDEXED BY idx_scene_codex_pins_entry
    JOIN tree_nodes scene
      ON scene.id = p.scene_id AND scene.project_id = ?1 AND scene.node_type = 'scene'
     AND scene.archived_at IS NULL
    JOIN codex_entries entry
      ON entry.id = p.entry_id AND entry.project_id = ?1
   WHERE p.entry_id = ?2 AND p.rowid > ?3
   ORDER BY p.rowid LIMIT ?4";

/// Has-more probe with exactly the page filters; it reads no row values.
const PIN_REMAIN_SQL: &str = "SELECT EXISTS(SELECT 1
    FROM scene_codex_pins p INDEXED BY idx_scene_codex_pins_entry
    JOIN tree_nodes scene
      ON scene.id = p.scene_id AND scene.project_id = ?1 AND scene.node_type = 'scene'
     AND scene.archived_at IS NULL
    JOIN codex_entries entry
      ON entry.id = p.entry_id AND entry.project_id = ?1
   WHERE p.entry_id = ?2 AND p.rowid > ?3)";

/// The keyset starts after rowid 0. Producer writes allocate positive rowids;
/// any other pin of this Entity would be skipped, so it refuses enumeration.
const PIN_NONPOSITIVE_ROWID_SQL: &str = "SELECT EXISTS(SELECT 1
    FROM scene_codex_pins INDEXED BY idx_scene_codex_pins_entry
   WHERE entry_id = ?1 AND rowid <= 0)";

const SCENE_TOKEN_LENGTHS_SQL: &str = "SELECT version, octet_length(updated_at)
    FROM tree_nodes
   WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene' AND archived_at IS NULL";

const SCENE_TOKEN_SQL: &str = "SELECT updated_at
    FROM tree_nodes
   WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene' AND archived_at IS NULL";

const SCENE_BINDING_LENGTHS_SQL: &str = "SELECT octet_length(scene_incarnation_id),
    octet_length(source_token)
    FROM narrative_scene_scope_bindings
   WHERE project_id = ?1 AND scene_id = ?2";

const SCENE_BINDING_SQL: &str = "SELECT scene_incarnation_id, source_token
    FROM narrative_scene_scope_bindings
   WHERE project_id = ?1 AND scene_id = ?2";

const PIN_POINT_LENGTHS_SQL: &str = "SELECT octet_length(p.scene_id),
    octet_length(p.entry_id), octet_length(p.created_at)
    FROM scene_codex_pins p
    JOIN tree_nodes scene
      ON scene.id = p.scene_id AND scene.project_id = ?1 AND scene.node_type = 'scene'
     AND scene.archived_at IS NULL
    JOIN codex_entries entry
      ON entry.id = p.entry_id AND entry.project_id = ?1
   WHERE p.rowid = ?2 AND p.entry_id = ?3";

const PIN_POINT_SQL: &str = "SELECT p.rowid, p.scene_id, p.entry_id, p.created_at
    FROM scene_codex_pins p
    JOIN tree_nodes scene
      ON scene.id = p.scene_id AND scene.project_id = ?1 AND scene.node_type = 'scene'
     AND scene.archived_at IS NULL
    JOIN codex_entries entry
      ON entry.id = p.entry_id AND entry.project_id = ?1
   WHERE p.rowid = ?2 AND p.entry_id = ?3";

fn require_identity(value: &str, name: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.trim() == value,
        "{name} is invalid"
    );
    Ok(())
}

fn checked_length(value: i64) -> Result<usize> {
    let value =
        usize::try_from(value).map_err(|_| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))?;
    ensure!(value <= MAX_PIN_FIELD_BYTES, "NIR1_GRAPH_SCENE_INPUT_LIMIT");
    Ok(value)
}

fn pin_bytes(scene: usize, entry: usize, created_at: usize) -> Result<usize> {
    scene
        .checked_add(entry)
        .and_then(|value| value.checked_add(created_at))
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))
}

fn source_metadata_bytes(scene_id: &str, updated_at: &str) -> Result<usize> {
    SOURCE_KEY_PREFIX
        .len()
        .checked_add(scene_id.len())
        .and_then(|value| value.checked_add(1)) // `v` in the revision token
        .and_then(|value| value.checked_add(MAX_I64_DECIMAL_BYTES))
        .and_then(|value| value.checked_add(1)) // `@` in the revision token
        .and_then(|value| value.checked_add(updated_at.len()))
        .and_then(|value| value.checked_add(SHA256_DIGEST_BYTES * 3))
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))
}

/// Scratch held by [`read_scene_pin_page_with_admission`] while it
/// materializes one page: the scalar-length Vec and the locator Vec. The
/// returned strings are charged separately as input bytes.
pub(super) fn pin_page_scratch_bytes(limit: usize) -> Result<usize> {
    let limit = limit.min(PIN_PAGE_ROWS);
    let lengths = limit
        .checked_mul(std::mem::size_of::<PinLengths>())
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))?;
    let locators = limit
        .checked_mul(std::mem::size_of::<ScenePinLocator>())
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))?;
    std::mem::size_of::<Vec<PinLengths>>()
        .checked_add(lengths)
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<Vec<ScenePinLocator>>()))
        .and_then(|bytes| bytes.checked_add(locators))
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))
}

/// Read one indexed pin page.  The reverse index is constrained by the exact
/// Entity ID and both project owners; mentions/cache rows are never consulted.
#[cfg(test)]
pub(super) fn read_scene_pin_page(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    cursor: i64,
    requested_limit: usize,
    budget: &mut SceneJoinBudget,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Vec<ScenePinLocator>> {
    read_scene_pin_page_with_admission(
        conn,
        project_id,
        entry_id,
        cursor,
        requested_limit,
        budget,
        check,
        |_, _| Ok(()),
    )
}

/// Read one indexed pin page and invoke `admit` after the page's scalar
/// lengths were charged to `budget` but before any pin string is
/// materialized. The C-query charges its shared QueryUsage at that boundary.
#[allow(clippy::too_many_arguments)]
pub(super) fn read_scene_pin_page_with_admission(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    cursor: i64,
    requested_limit: usize,
    budget: &mut SceneJoinBudget,
    check: &mut dyn FnMut() -> Result<()>,
    admit: impl FnOnce(usize, usize) -> Result<()>,
) -> Result<Vec<ScenePinLocator>> {
    ensure!(
        !conn.is_autocommit(),
        "Scene pin page requires a read transaction"
    );
    require_identity(project_id, "project_id")?;
    require_identity(entry_id, "entry_id")?;
    ensure!(cursor >= 0, "NIR1_GRAPH_SCENE_INVALID_PIN_CURSOR");
    ensure!(
        requested_limit == 0 || budget.remaining_rows() > 0,
        "NIR1_GRAPH_SCENE_QUERY_RESOURCE_LIMIT"
    );
    check()?;
    let limit = requested_limit
        .min(PIN_PAGE_ROWS)
        .min(budget.remaining_rows());
    if limit == 0 {
        return Ok(Vec::new());
    }
    if cursor == 0 {
        ensure_positive_pin_rowids(conn, entry_id)?;
        check()?;
    }

    let mut statement = conn.prepare(PIN_LENGTHS_SQL)?;
    let mut rows = statement.query(params![project_id, entry_id, cursor, limit as i64])?;
    let mut lengths = Vec::with_capacity(limit);
    let mut page_bytes = 0usize;
    while let Some(row) = rows.next()? {
        check()?;
        let item = PinLengths {
            rowid: row.get(0)?,
            scene_bytes: checked_length(row.get(1)?)?,
            entry_bytes: checked_length(row.get(2)?)?,
            created_at_bytes: checked_length(row.get(3)?)?,
        };
        page_bytes = page_bytes
            .checked_add(pin_bytes(
                item.scene_bytes,
                item.entry_bytes,
                item.created_at_bytes,
            )?)
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))?;
        lengths.push(item);
    }
    drop(rows);
    budget.admit(lengths.len(), page_bytes)?;
    admit(lengths.len(), page_bytes)?;
    check()?;

    let mut point = conn.prepare(PIN_POINT_SQL)?;
    let mut result = Vec::with_capacity(lengths.len());
    for item in lengths {
        check()?;
        let pin = point.query_row(params![project_id, item.rowid, entry_id], |row| {
            Ok(ScenePinLocator {
                rowid: row.get(0)?,
                scene_id: row.get(1)?,
                entry_id: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        result.push(pin);
    }
    Ok(result)
}

/// Whether the Entity has another pin after `cursor` under the page filters.
/// It consumes no row admission; the caller probes before refusing a page.
pub(super) fn scene_pins_remain(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    cursor: i64,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<bool> {
    ensure!(
        !conn.is_autocommit(),
        "Scene pin probe requires a read transaction"
    );
    require_identity(project_id, "project_id")?;
    require_identity(entry_id, "entry_id")?;
    ensure!(cursor >= 0, "NIR1_GRAPH_SCENE_INVALID_PIN_CURSOR");
    check()?;
    if cursor == 0 {
        ensure_positive_pin_rowids(conn, entry_id)?;
        check()?;
    }
    Ok(conn.query_row(
        PIN_REMAIN_SQL,
        params![project_id, entry_id, cursor],
        |row| row.get(0),
    )?)
}

/// A keyset that starts after rowid 0 would silently skip other pins.
fn ensure_positive_pin_rowids(conn: &Connection, entry_id: &str) -> Result<()> {
    let nonpositive: bool =
        conn.query_row(PIN_NONPOSITIVE_ROWID_SQL, params![entry_id], |row| {
            row.get(0)
        })?;
    ensure!(!nonpositive, "NIR1_GRAPH_SCENE_INVALID_PIN_CURSOR");
    Ok(())
}

/// Scalar lengths of one Scene's frame tokens, admitted before the strings
/// are materialized.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct SceneFrameTokenLengths {
    /// The Scene row plus its A1 binding row when one exists.
    pub rows: usize,
    pub source_token: usize,
    pub incarnation_id: Option<usize>,
    pub scope_token: Option<usize>,
}

impl SceneFrameTokenLengths {
    pub(super) fn bytes(&self) -> Result<usize> {
        self.source_token
            .checked_add(self.incarnation_id.unwrap_or(0))
            .and_then(|bytes| bytes.checked_add(self.scope_token.unwrap_or(0)))
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))
    }
}

/// Exact tokens of a pinned Scene. None of them is the Scene body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SceneFrameTokens {
    /// `v{version}@{updated_at}`, the same form as the Scene source token.
    pub source_token: String,
    pub incarnation_id: Option<String>,
    pub scope_token: Option<String>,
}

fn decimal_bytes(value: i64) -> usize {
    let digits = value
        .unsigned_abs()
        .checked_ilog10()
        .map_or(1, |log| log as usize + 1);
    digits + usize::from(value < 0)
}

/// Read the source token and the A1 binding tokens of one live pinned
/// Scene. Lengths are charged to `budget` and passed to `admit` before any
/// string is selected; `content` is never selected.
pub(super) fn read_scene_frame_tokens(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    budget: &mut SceneJoinBudget,
    check: &mut dyn FnMut() -> Result<()>,
    admit: impl FnOnce(SceneFrameTokenLengths) -> Result<()>,
) -> Result<SceneFrameTokens> {
    ensure!(
        !conn.is_autocommit(),
        "Scene tokens require a read transaction"
    );
    require_identity(project_id, "project_id")?;
    require_identity(scene_id, "scene_id")?;
    check()?;
    let (version, updated_at_bytes): (i64, i64) = conn
        .query_row(
            SCENE_TOKEN_LENGTHS_SQL,
            params![scene_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_SOURCE_UNAVAILABLE"))?;
    let updated_at_bytes = checked_length(updated_at_bytes)?;
    check()?;
    let binding: Option<(i64, i64)> = conn
        .query_row(
            SCENE_BINDING_LENGTHS_SQL,
            params![project_id, scene_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let binding = binding
        .map(|(incarnation, scope)| {
            Ok::<_, anyhow::Error>((checked_length(incarnation)?, checked_length(scope)?))
        })
        .transpose()?;
    let lengths = SceneFrameTokenLengths {
        rows: 1 + usize::from(binding.is_some()),
        // `v`, the decimal version, `@` and updated_at.
        source_token: decimal_bytes(version)
            .checked_add(2)
            .and_then(|bytes| bytes.checked_add(updated_at_bytes))
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))?,
        incarnation_id: binding.map(|(incarnation, _)| incarnation),
        scope_token: binding.map(|(_, scope)| scope),
    };
    budget.admit(lengths.rows, lengths.bytes()?)?;
    admit(lengths)?;
    check()?;

    let updated_at: String =
        conn.query_row(SCENE_TOKEN_SQL, params![scene_id, project_id], |row| {
            row.get(0)
        })?;
    ensure!(
        updated_at.len() == updated_at_bytes,
        "NIR1_GRAPH_SCENE_SOURCE_UNAVAILABLE"
    );
    let (incarnation_id, scope_token) = match binding {
        Some((incarnation_bytes, scope_bytes)) => {
            check()?;
            let (incarnation, scope): (String, String) =
                conn.query_row(SCENE_BINDING_SQL, params![project_id, scene_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
            ensure!(
                incarnation.len() == incarnation_bytes && scope.len() == scope_bytes,
                "NIR1_GRAPH_SCENE_SCOPE_UNAVAILABLE"
            );
            (Some(incarnation), Some(scope))
        }
        None => (None, None),
    };
    Ok(SceneFrameTokens {
        source_token: format!("v{version}@{updated_at}"),
        incarnation_id,
        scope_token,
    })
}

/// Re-read the exact pin row after the query snapshot.  This is deliberately
/// separate from body-source reading: a changed body Source token alone does
/// not invalidate a pin.  The caller must also compare its full connection
/// read identity before accepting the result.
#[cfg_attr(
    not(any(test, feature = "native-current-human-capture")),
    expect(
        dead_code,
        reason = "parent-side CB-4 pin recheck (Native build); the worker reads pins only by page"
    )
)]
pub(super) fn recheck_scene_pin(
    conn: &Connection,
    project_id: &str,
    expected: &ScenePinLocator,
    budget: &mut SceneJoinBudget,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Option<ScenePinLocator>> {
    ensure!(
        !conn.is_autocommit(),
        "Scene pin recheck requires a read transaction"
    );
    require_identity(project_id, "project_id")?;
    require_identity(&expected.entry_id, "entry_id")?;
    ensure!(expected.rowid > 0, "NIR1_GRAPH_SCENE_INVALID_PIN_CURSOR");
    check()?;
    let lengths: Option<(i64, i64, i64)> = conn
        .query_row(
            PIN_POINT_LENGTHS_SQL,
            params![project_id, expected.rowid, expected.entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((scene_bytes, entry_bytes, created_at_bytes)) = lengths else {
        return Ok(None);
    };
    let scene_bytes = checked_length(scene_bytes)?;
    let entry_bytes = checked_length(entry_bytes)?;
    let created_at_bytes = checked_length(created_at_bytes)?;
    budget.admit(1, pin_bytes(scene_bytes, entry_bytes, created_at_bytes)?)?;
    check()?;
    let current = conn
        .query_row(
            PIN_POINT_SQL,
            params![project_id, expected.rowid, expected.entry_id],
            |row| {
                Ok(ScenePinLocator {
                    rowid: row.get(0)?,
                    scene_id: row.get(1)?,
                    entry_id: row.get(2)?,
                    created_at: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(current.filter(|current| current == expected))
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// Read the exact Scene body for an already located pin.  Scalar lengths are
/// admitted before materializing `content`; canonical JSON processing checks
/// the owner between bounded pieces and the first non-empty line is the only
/// anchor retained in the result.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "parent-side CB-4 reader; the worker never reads Scene bodies"
    )
)]
pub(super) fn read_scene_source_bounded(
    conn: &Connection,
    project_id: &str,
    pin: ScenePinLocator,
    budget: &mut SceneJoinBudget,
    max_storage_bytes: usize,
    max_canonical_bytes: usize,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<SceneSourceLocator> {
    ensure!(
        !conn.is_autocommit(),
        "Scene source requires a read transaction"
    );
    require_identity(project_id, "project_id")?;
    require_identity(&pin.scene_id, "scene_id")?;
    require_identity(&pin.entry_id, "entry_id")?;
    check()?;
    let lengths: Option<(i64, i64, i64, i64, i64)> = conn
        .query_row(
            "SELECT octet_length(t.content), octet_length(t.id),
                    octet_length(t.project_id), octet_length(t.updated_at),
                    t.version
               FROM tree_nodes t
              WHERE t.id = ?1 AND t.project_id = ?2 AND t.node_type = 'scene'
                AND t.archived_at IS NULL",
            params![pin.scene_id, project_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((content_bytes, scene_bytes, project_bytes, updated_at_bytes, _version)) = lengths
    else {
        anyhow::bail!("NIR1_GRAPH_SCENE_SOURCE_UNAVAILABLE");
    };
    let content_bytes = usize::try_from(content_bytes)
        .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_SCENE_INPUT_LIMIT"))?;
    ensure!(
        content_bytes <= max_storage_bytes && content_bytes <= budget.remaining_bytes(),
        "NIR1_GRAPH_SCENE_INPUT_LIMIT"
    );
    let scalar_bytes = pin_bytes(
        checked_length(scene_bytes)?,
        checked_length(project_bytes)?,
        checked_length(updated_at_bytes)?,
    )?;
    budget.admit(1, scalar_bytes)?;
    // The content length was admitted separately so a caller can distinguish
    // metadata from body storage in diagnostics while retaining one budget.
    budget.admit(0, content_bytes)?;
    check()?;

    let (version, updated_at, content): (i64, String, String) = conn.query_row(
        "SELECT version, updated_at, content
           FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'
            AND archived_at IS NULL",
        params![pin.scene_id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    ensure!(
        version >= 0 && !updated_at.trim().is_empty(),
        "NIR1_GRAPH_SCENE_SOURCE_UNAVAILABLE"
    );
    check()?;
    budget.admit(0, source_metadata_bytes(&pin.scene_id, &updated_at)?)?;
    let remaining_for_canonical = budget.remaining_bytes().min(max_canonical_bytes);
    // Both callbacks run at different points inside the canonical helper, but
    // the helper keeps them alive for the same call.  Interior mutability here
    // lets both stages charge the caller-owned cumulative budget without
    // manufacturing a second per-Scene budget or moving the admission after
    // serde_json/canonical allocations.
    let canonical = {
        let budget_cell = RefCell::new(&mut *budget);
        canonical_scene_storage_with_admission(
            &content,
            max_storage_bytes,
            remaining_for_canonical,
            check,
            &mut |bytes| budget_cell.borrow_mut().admit(0, bytes),
            &mut |bytes| budget_cell.borrow_mut().admit(0, bytes),
        )?
    };
    let source = SceneSourceBinding {
        source_kind: "scene-body",
        source_key: format!("{SOURCE_KEY_PREFIX}{}", pin.scene_id),
        revision_token: format!("v{version}@{updated_at}"),
        source_version: version,
        normalizer_version: CANONICAL_TEXT_NORMALIZER_VERSION,
        storage_digest: digest(content.as_bytes()),
        canonical_digest: digest(canonical.as_bytes()),
        canonical_utf16_length: canonical.encode_utf16().count(),
    };
    let anchor = first_non_empty_anchor(&canonical, check, &mut |bytes| budget.admit(0, bytes))?;
    Ok(SceneSourceLocator {
        pin,
        source,
        anchor,
    })
}

fn first_non_empty_anchor(
    canonical: &str,
    check: &mut dyn FnMut() -> Result<()>,
    admit_excerpt: &mut dyn FnMut(usize) -> Result<()>,
) -> Result<SceneBodyAnchor> {
    let mut line_start = 0usize;
    let mut utf16_start = 0usize;
    loop {
        check()?;
        let relative_end = canonical[line_start..]
            .find('\n')
            .unwrap_or(canonical.len().saturating_sub(line_start));
        let line_end = line_start + relative_end;
        let line = &canonical[line_start..line_end];
        let line_units = line.encode_utf16().count();
        if !line.trim().is_empty() {
            admit_excerpt(line.len())?;
            return Ok(SceneBodyAnchor {
                start_utf16: utf16_start,
                end_utf16: utf16_start + line_units,
                excerpt: line.to_owned(),
                digest: digest(line.as_bytes()),
            });
        }
        if line_end == canonical.len() {
            break;
        }
        utf16_start = utf16_start
            .checked_add(line_units)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_UTF16_LIMIT"))?;
        line_start = line_end + 1;
    }
    anyhow::bail!("NIR1_GRAPH_SCENE_EMPTY_BODY")
}

fn matches_axis(constraint: &NarrativeScopeConstraintV1, expected: &str) -> bool {
    match constraint {
        NarrativeScopeConstraintV1::Any => true,
        NarrativeScopeConstraintV1::Exact { reference } => reference == expected,
        NarrativeScopeConstraintV1::Unresolved { .. } => false,
    }
}

fn matches_query_axis(constraint: &NarrativeScopeConstraintV1, expected: &str) -> bool {
    matches!(constraint, NarrativeScopeConstraintV1::Exact { reference } if reference == expected)
}

/// Independently qualify a target Scene's own A1 scope binding.  This helper
/// intentionally does not inspect or accept Entity/Relation POV/phase fields,
/// project authority, reveal state, or lifecycle/read-identity proof; the
/// path's full A2/A3 proof remains a separate input owned by the C-query.
#[cfg_attr(
    not(any(test, feature = "native-current-human-capture")),
    expect(
        dead_code,
        reason = "parent-side CB-4 Scene scope qualification (Native build); the worker never qualifies Scenes"
    )
)]
pub(super) fn validate_scene_scope(
    binding: &NarrativeSceneScopeBindingV1,
    expected: &SceneScopeExpectation<'_>,
) -> Result<()> {
    ensure!(
        binding.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::Explicit,
        "NIR1_GRAPH_SCENE_SCOPE_UNAVAILABLE"
    );
    ensure!(
        binding.project_id == expected.project_id,
        "NIR1_GRAPH_SCENE_PROJECT_MISMATCH"
    );
    ensure!(
        binding.scene_id == expected.scene_id,
        "NIR1_GRAPH_SCENE_ID_MISMATCH"
    );
    ensure!(
        !expected.scene_incarnation_id.trim().is_empty()
            && binding.scene_incarnation_id == expected.scene_incarnation_id,
        "NIR1_GRAPH_SCENE_INCARNATION_UNAVAILABLE"
    );
    ensure!(
        !expected.scope_token.trim().is_empty(),
        "NIR1_GRAPH_SCENE_SCOPE_UNAVAILABLE"
    );
    ensure!(
        binding.source_token == expected.scope_token,
        "NIR1_GRAPH_SCENE_SCOPE_DRIFT"
    );
    ensure!(
        matches_query_axis(&binding.query_identity.timeline, expected.timeline)
            && matches_query_axis(&binding.query_identity.worldline, expected.worldline)
            && matches_query_axis(
                &binding.query_identity.narrative_layer,
                expected.narrative_layer,
            ),
        "NIR1_GRAPH_SCENE_QUERY_SCOPE_MISMATCH"
    );
    ensure!(
        matches_axis(&binding.material_constraint.timeline, expected.timeline)
            && matches_axis(&binding.material_constraint.worldline, expected.worldline)
            && matches_axis(
                &binding.material_constraint.narrative_layer,
                expected.narrative_layer,
            ),
        "NIR1_GRAPH_SCENE_MATERIAL_SCOPE_MISMATCH"
    );
    ensure!(
        &binding.knowledge_holder == expected.knowledge_holder,
        "NIR1_GRAPH_SCENE_HOLDER_MISMATCH"
    );
    ensure!(
        &binding.audience == expected.audience,
        "NIR1_GRAPH_SCENE_AUDIENCE_MISMATCH"
    );
    ensure!(
        expected.candidate_reading_rank < expected.query_reading_rank,
        "NIR1_GRAPH_SCENE_READING_AFTER_QUERY"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_core::narrative_scene_scope::{
        NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    };
    use serde_json::json;

    fn scene_content(text: &str) -> String {
        json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": text }]
            }]
        })
        .to_string()
    }

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().expect("connection");
        conn.execute_batch(
            "CREATE TABLE codex_entries (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL
             );
             CREATE TABLE tree_nodes (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_type TEXT NOT NULL,
                version INTEGER NOT NULL, updated_at TEXT NOT NULL, content TEXT NOT NULL,
                archived_at TEXT
             );
             CREATE TABLE scene_codex_pins (
                scene_id TEXT NOT NULL, entry_id TEXT NOT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY(scene_id, entry_id)
             );
             CREATE INDEX idx_scene_codex_pins_entry ON scene_codex_pins(entry_id);",
        )
        .expect("schema");
        conn.execute(
            "INSERT INTO codex_entries(id, project_id) VALUES ('entry-a', 'project-a')",
            [],
        )
        .expect("entry");
        conn.execute(
            "INSERT INTO tree_nodes(id, project_id, node_type, version, updated_at, content)
             VALUES ('scene-a', 'project-a', 'scene', 3, '2026-09-22T00:00:00Z', ?1)",
            [scene_content("first line 😊\nsecond")],
        )
        .expect("scene");
        conn.execute(
            "INSERT INTO scene_codex_pins(scene_id, entry_id, created_at)
             VALUES ('scene-a', 'entry-a', '2026-09-22T00:00:01Z')",
            [],
        )
        .expect("pin");
        conn
    }

    fn check() -> impl FnMut() -> Result<()> {
        || Ok(())
    }

    fn read_pin(conn: &Connection) -> ScenePinLocator {
        if conn.is_autocommit() {
            conn.execute_batch("BEGIN").expect("begin");
        }
        let mut budget = SceneJoinBudget::new(32, 2 * 1024 * 1024);
        let mut check = check();
        read_scene_pin_page(conn, "project-a", "entry-a", 0, 16, &mut budget, &mut check)
            .expect("pin page")
            .into_iter()
            .next()
            .expect("pin")
    }

    #[test]
    fn pin_is_an_exact_locator_and_body_source_has_a_utf16_anchor() {
        let conn = connection();
        let pin = read_pin(&conn);
        let mut budget = SceneJoinBudget::new(32, 2 * 1024 * 1024);
        let mut check = check();
        let source = read_scene_source_bounded(
            &conn,
            "project-a",
            pin.clone(),
            &mut budget,
            2 * 1024 * 1024,
            2 * 1024 * 1024,
            &mut check,
        )
        .expect("source");
        assert_eq!(source.pin, pin);
        assert_eq!(source.source.source_kind, "scene-body");
        assert_eq!(source.source.source_key, "project:scene:scene-a");
        assert_eq!(source.source.revision_token, "v3@2026-09-22T00:00:00Z");
        assert_eq!(source.source.source_version, 3);
        assert_eq!(
            source.source.normalizer_version,
            CANONICAL_TEXT_NORMALIZER_VERSION
        );
        assert_eq!(
            source.source.canonical_utf16_length,
            "first line 😊\nsecond".encode_utf16().count()
        );
        assert_eq!(source.anchor.start_utf16, 0);
        assert_eq!(source.anchor.excerpt, "first line 😊");
        assert_eq!(
            source.anchor.end_utf16,
            "first line 😊".encode_utf16().count()
        );
        conn.execute_batch("ROLLBACK").expect("rollback");
    }

    #[test]
    fn pin_recheck_rejects_cold_delete_and_same_rowid_replacement() {
        let conn = connection();
        let pin = read_pin(&conn);
        let mut budget = SceneJoinBudget::new(32, 2 * 1024 * 1024);
        let mut check = check();
        conn.execute("DELETE FROM scene_codex_pins", [])
            .expect("delete pin");
        assert!(
            recheck_scene_pin(&conn, "project-a", &pin, &mut budget, &mut check)
                .expect("recheck")
                .is_none()
        );
        conn.execute(
            "INSERT INTO scene_codex_pins(scene_id, entry_id, created_at)
             VALUES ('scene-a', 'entry-a', '2026-09-22T00:00:02Z')",
            [],
        )
        .expect("replacement pin");
        assert!(
            recheck_scene_pin(&conn, "project-a", &pin, &mut budget, &mut check)
                .expect("recheck replacement")
                .is_none(),
            "delete/reinsert must not rescue an old row fingerprint"
        );
    }

    #[test]
    fn body_change_does_not_substitute_for_live_pin_recheck() {
        let conn = connection();
        let pin = read_pin(&conn);
        conn.execute(
            "UPDATE tree_nodes SET content=?1, version=version+1 WHERE id='scene-a'",
            [scene_content("changed")],
        )
        .expect("body update");
        let mut budget = SceneJoinBudget::new(32, 2 * 1024 * 1024);
        let mut check = check();
        assert!(
            recheck_scene_pin(&conn, "project-a", &pin, &mut budget, &mut check)
                .expect("pin remains")
                .is_some()
        );
    }

    #[test]
    fn source_reader_rejects_empty_and_archived_scene_bodies() {
        let conn = connection();
        let pin = read_pin(&conn);
        conn.execute(
            "UPDATE tree_nodes SET content=?1 WHERE id='scene-a'",
            [scene_content("   ")],
        )
        .expect("empty body");
        let mut budget = SceneJoinBudget::new(32, 2 * 1024 * 1024);
        let mut source_check = check();
        let error = read_scene_source_bounded(
            &conn,
            "project-a",
            pin.clone(),
            &mut budget,
            2 * 1024 * 1024,
            2 * 1024 * 1024,
            &mut source_check,
        )
        .expect_err("whitespace-only body must be unavailable");
        assert!(error.to_string().contains("EMPTY_BODY"));

        conn.execute(
            "UPDATE tree_nodes SET archived_at='2026-09-22T00:00:03Z' WHERE id='scene-a'",
            [],
        )
        .expect("archive scene");
        let mut archived_budget = SceneJoinBudget::new(32, 2 * 1024 * 1024);
        let mut archived_check = check();
        let error = read_scene_source_bounded(
            &conn,
            "project-a",
            pin,
            &mut archived_budget,
            2 * 1024 * 1024,
            2 * 1024 * 1024,
            &mut archived_check,
        )
        .expect_err("archived body must be unavailable");
        assert!(error.to_string().contains("SOURCE_UNAVAILABLE"));
    }

    #[test]
    fn page_budget_is_cumulative_and_cancellation_is_observed() {
        let conn = connection();
        conn.execute_batch("BEGIN").expect("begin");
        let mut budget = SceneJoinBudget::new(1, 1024);
        let mut check = check();
        let page = read_scene_pin_page(
            &conn,
            "project-a",
            "entry-a",
            0,
            16,
            &mut budget,
            &mut check,
        )
        .expect("bounded page");
        assert_eq!(page.len(), 1);
        assert_eq!(budget.rows(), 1);
        assert!(budget.bytes() > 0);
        let error = read_scene_pin_page(
            &conn,
            "project-a",
            "entry-a",
            page[0].rowid,
            16,
            &mut budget,
            &mut check,
        )
        .expect_err("exhausted page must fail closed");
        assert!(error.to_string().contains("QUERY_RESOURCE_LIMIT"));

        let mut checks = 0;
        let mut cancelled = || {
            checks += 1;
            ensure!(checks < 2, "cancelled");
            Ok(())
        };
        let mut fresh_budget = SceneJoinBudget::new(16, 1024);
        let error = read_scene_pin_page(
            &conn,
            "project-a",
            "entry-a",
            0,
            16,
            &mut fresh_budget,
            &mut cancelled,
        )
        .expect_err("cancelled page");
        assert!(error.to_string().contains("cancelled"));
    }

    fn explicit_binding() -> NarrativeSceneScopeBindingV1 {
        NarrativeSceneScopeBindingV1 {
            schema_version: 1,
            project_id: "project-a".into(),
            scene_id: "scene-a".into(),
            scene_incarnation_id: "incarnation-a".into(),
            compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: NarrativeScopeConstraintV1::Exact {
                    reference: "timeline:main".into(),
                },
                worldline: NarrativeScopeConstraintV1::Exact {
                    reference: "worldline:prime".into(),
                },
                narrative_layer: NarrativeScopeConstraintV1::Exact {
                    reference: "layer:manuscript".into(),
                },
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: NarrativeScopeConstraintV1::Any,
                worldline: NarrativeScopeConstraintV1::Any,
                narrative_layer: NarrativeScopeConstraintV1::Any,
            },
            knowledge_holder: NarrativeScopePrincipalV1::Reader {},
            audience: NarrativeScopePrincipalV1::Reader {},
            version: 2,
            source_token: "scope-token".into(),
            updated_at: "2026-09-22T00:00:00Z".into(),
        }
    }

    #[test]
    fn scene_scope_is_independent_and_requires_strict_reading_before() {
        let binding = explicit_binding();
        let reader = NarrativeScopePrincipalV1::Reader {};
        let expected = SceneScopeExpectation {
            project_id: "project-a",
            scene_id: "scene-a",
            scene_incarnation_id: "incarnation-a",
            scope_token: "scope-token",
            timeline: "timeline:main",
            worldline: "worldline:prime",
            narrative_layer: "layer:manuscript",
            knowledge_holder: &reader,
            audience: &reader,
            candidate_reading_rank: 1,
            query_reading_rank: 2,
        };
        validate_scene_scope(&binding, &expected).expect("independent scope");

        let mut future = expected;
        future.candidate_reading_rank = future.query_reading_rank;
        let error = validate_scene_scope(&binding, &future).expect_err("same scene is not before");
        assert!(error.to_string().contains("READING_AFTER_QUERY"));

        let mut wrong_holder = explicit_binding();
        wrong_holder.knowledge_holder = NarrativeScopePrincipalV1::Character {
            reference: "character:other".into(),
        };
        let error = validate_scene_scope(&wrong_holder, &expected).expect_err("holder mismatch");
        assert!(error.to_string().contains("HOLDER_MISMATCH"));

        let mut wrong_incarnation = expected;
        wrong_incarnation.scene_incarnation_id = "incarnation-other";
        let error =
            validate_scene_scope(&binding, &wrong_incarnation).expect_err("incarnation mismatch");
        assert!(error.to_string().contains("INCARNATION_UNAVAILABLE"));

        let mut wrong_scope = expected;
        wrong_scope.scope_token = "scope-other";
        let error = validate_scene_scope(&binding, &wrong_scope).expect_err("scope mismatch");
        assert!(error.to_string().contains("SCOPE_DRIFT"));
    }

    // Same method as candidates.rs: inspect the current-schema plan rather
    // than trusting row counts from a small fixture.
    #[test]
    fn pin_sqls_use_entry_index_keyset_without_scan_or_temp_btree() {
        let db = crate::Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            let plan = |sql: &str| -> Vec<String> {
                let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
                let parameters = statement.parameter_count();
                statement
                    .query_map(
                        rusqlite::params_from_iter(std::iter::repeat_n("x", parameters)),
                        |row| row.get::<_, String>(3),
                    )
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
            };
            let keyset = "idx_scene_codex_pins_entry (entry_id=? AND rowid>?)";
            for (label, sql, seek) in [
                ("page", PIN_LENGTHS_SQL, Some(keyset)),
                ("probe", PIN_REMAIN_SQL, Some(keyset)),
                (
                    "nonpositive rowid",
                    PIN_NONPOSITIVE_ROWID_SQL,
                    Some("idx_scene_codex_pins_entry (entry_id=? AND rowid<"),
                ),
                ("point", PIN_POINT_SQL, None),
                ("token lengths", SCENE_TOKEN_LENGTHS_SQL, None),
                ("token", SCENE_TOKEN_SQL, None),
                ("binding lengths", SCENE_BINDING_LENGTHS_SQL, None),
                ("binding", SCENE_BINDING_SQL, None),
            ] {
                let plan = plan(sql);
                // `SELECT EXISTS(...)` scans only its one constant row.
                assert!(
                    plan.iter().all(|line| (!line.starts_with("SCAN")
                        || line == "SCAN CONSTANT ROW")
                        && !line.contains("TEMP B-TREE")
                        && !line.contains("AUTOMATIC")),
                    "{label}: {plan:?}"
                );
                assert!(
                    plan.iter().any(|line| line.starts_with("SEARCH")),
                    "{label}: {plan:?}"
                );
                if let Some(seek) = seek {
                    assert!(
                        plan.iter().any(|line| line.contains(seek)),
                        "{label}: {plan:?}"
                    );
                }
            }
            // Negative control: the pin table without its Entity key scans.
            let control = plan("SELECT rowid FROM scene_codex_pins WHERE created_at = ?1");
            assert!(
                control.iter().any(|line| line.starts_with("SCAN")),
                "{control:?}"
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn pin_page_admission_sees_octet_lengths_before_point_reads() {
        let conn = connection();
        for (scene, created_at) in [
            ("scene-bb", "t"),
            ("scene-ccc😊", "2026-09-22T00:00:02.000Z"),
        ] {
            conn.execute(
                "INSERT INTO tree_nodes(id, project_id, node_type, version, updated_at, content)
                 VALUES (?1, 'project-a', 'scene', 1, '2026-09-22T00:00:00Z', '{}')",
                [scene],
            )
            .expect("scene");
            conn.execute(
                "INSERT INTO scene_codex_pins(scene_id, entry_id, created_at)
                 VALUES (?1, 'entry-a', ?2)",
                [scene, created_at],
            )
            .expect("pin");
        }
        conn.execute_batch("BEGIN").expect("begin");
        let events = RefCell::new(Vec::new());
        let mut budget = SceneJoinBudget::new(32, 1024);
        let page = read_scene_pin_page_with_admission(
            &conn,
            "project-a",
            "entry-a",
            0,
            16,
            &mut budget,
            &mut || {
                events.borrow_mut().push("check");
                Ok(())
            },
            |rows, bytes| {
                events.borrow_mut().push("admit");
                assert_eq!(rows, 3);
                assert_eq!(bytes, budget_bytes_for_test());
                Ok(())
            },
        )
        .expect("page");
        let materialized = page
            .iter()
            .map(|pin| pin.scene_id.len() + pin.entry_id.len() + pin.created_at.len())
            .sum::<usize>();
        assert_eq!(materialized, budget_bytes_for_test());
        assert_eq!((budget.rows(), budget.bytes()), (3, materialized));
        // One check after admission and one per point read follow it.
        let events = events.into_inner();
        let admitted_at = events
            .iter()
            .position(|event| *event == "admit")
            .expect("admission");
        assert_eq!(events.len() - admitted_at - 1, 1 + page.len());

        // A refused admission returns before any pin string is selected.
        let events = RefCell::new(Vec::new());
        let mut budget = SceneJoinBudget::new(32, 1024);
        let error = read_scene_pin_page_with_admission(
            &conn,
            "project-a",
            "entry-a",
            0,
            16,
            &mut budget,
            &mut || {
                events.borrow_mut().push("check");
                Ok(())
            },
            |_, _| {
                events.borrow_mut().push("admit");
                anyhow::bail!("admission refused")
            },
        )
        .expect_err("refused admission");
        assert!(error.to_string().contains("admission refused"));
        assert_eq!(events.into_inner().last(), Some(&"admit"));
    }

    /// Bytes of the three pins in `pin_page_admission_sees_octet_lengths_before_point_reads`.
    fn budget_bytes_for_test() -> usize {
        ["scene-a", "scene-bb", "scene-ccc😊"]
            .iter()
            .map(|scene| scene.len() + "entry-a".len())
            .sum::<usize>()
            + "2026-09-22T00:00:01Z".len()
            + "t".len()
            + "2026-09-22T00:00:02.000Z".len()
    }

    #[test]
    fn frame_tokens_read_lengths_first_and_absent_binding_is_none() {
        let conn = connection();
        conn.execute_batch(
            "CREATE TABLE narrative_scene_scope_bindings (
                project_id TEXT NOT NULL, scene_id TEXT NOT NULL,
                scene_incarnation_id TEXT NOT NULL, source_token TEXT NOT NULL,
                PRIMARY KEY(project_id, scene_id)
             );",
        )
        .expect("binding table");
        conn.execute_batch("BEGIN").expect("begin");
        let mut budget = SceneJoinBudget::new(32, 1024);
        let mut admitted = None;
        let tokens = read_scene_frame_tokens(
            &conn,
            "project-a",
            "scene-a",
            &mut budget,
            &mut check(),
            |lengths| {
                admitted = Some(lengths);
                Ok(())
            },
        )
        .expect("unbound tokens");
        assert_eq!(
            tokens,
            SceneFrameTokens {
                source_token: "v3@2026-09-22T00:00:00Z".into(),
                incarnation_id: None,
                scope_token: None,
            }
        );
        assert_eq!(
            admitted,
            Some(SceneFrameTokenLengths {
                rows: 1,
                source_token: tokens.source_token.len(),
                incarnation_id: None,
                scope_token: None,
            })
        );
        assert_eq!(
            (budget.rows(), budget.bytes()),
            (1, tokens.source_token.len())
        );
        conn.execute_batch("ROLLBACK").expect("rollback");

        let scope = format!("sha256:{}", "a".repeat(64));
        conn.execute(
            "INSERT INTO narrative_scene_scope_bindings VALUES ('project-a', 'scene-a', 'incarnation-a', ?1)",
            [&scope],
        )
        .expect("binding");
        conn.execute_batch("BEGIN").expect("begin");
        let mut budget = SceneJoinBudget::new(32, 1024);
        let mut admitted = None;
        let tokens = read_scene_frame_tokens(
            &conn,
            "project-a",
            "scene-a",
            &mut budget,
            &mut check(),
            |lengths| {
                admitted = Some(lengths);
                Ok(())
            },
        )
        .expect("bound tokens");
        assert_eq!(tokens.incarnation_id.as_deref(), Some("incarnation-a"));
        assert_eq!(tokens.scope_token.as_deref(), Some(scope.as_str()));
        let lengths = admitted.expect("admitted lengths");
        assert_eq!(lengths.rows, 2);
        assert_eq!(lengths.incarnation_id, Some("incarnation-a".len()));
        assert_eq!(lengths.scope_token, Some(scope.len()));
        assert_eq!(budget.bytes(), lengths.bytes().expect("bytes"));

        // A refused admission returns the refusal and no token.
        let mut budget = SceneJoinBudget::new(32, 1024);
        let error = read_scene_frame_tokens(
            &conn,
            "project-a",
            "scene-a",
            &mut budget,
            &mut check(),
            |_| anyhow::bail!("admission refused"),
        )
        .expect_err("refused admission");
        assert!(error.to_string().contains("admission refused"));
        // So does the cumulative budget, before the caller's admission.
        let mut exhausted = SceneJoinBudget::new(1, 1024);
        let error = read_scene_frame_tokens(
            &conn,
            "project-a",
            "scene-a",
            &mut exhausted,
            &mut check(),
            |_| panic!("the budget refuses first"),
        )
        .expect_err("two rows over a one-row budget");
        assert!(error.to_string().contains("QUERY_RESOURCE_LIMIT"));
        conn.execute_batch("ROLLBACK").expect("rollback");

        conn.execute(
            "UPDATE tree_nodes SET archived_at='2026-09-22T00:00:03Z' WHERE id='scene-a'",
            [],
        )
        .expect("archive");
        conn.execute_batch("BEGIN").expect("begin");
        let mut budget = SceneJoinBudget::new(32, 1024);
        let error = read_scene_frame_tokens(
            &conn,
            "project-a",
            "scene-a",
            &mut budget,
            &mut check(),
            |_| Ok(()),
        )
        .expect_err("archived Scene");
        assert!(error.to_string().contains("SOURCE_UNAVAILABLE"));
        conn.execute_batch("ROLLBACK").expect("rollback");

        for value in [0, 9, 10, 99, 100, -1, -10, i64::MIN, i64::MAX] {
            assert_eq!(decimal_bytes(value), value.to_string().len(), "{value}");
        }
    }

    #[test]
    fn pins_remain_probe_matches_page_filters() {
        let conn = connection();
        conn.execute_batch(
            "INSERT INTO codex_entries(id, project_id) VALUES ('entry-foreign', 'project-b');
             INSERT INTO tree_nodes(id, project_id, node_type, version, updated_at, content, archived_at)
             VALUES ('scene-archived', 'project-a', 'scene', 1, 't', '{}', 't'),
                    ('scene-foreign', 'project-b', 'scene', 1, 't', '{}', NULL),
                    ('note-a', 'project-a', 'note', 1, 't', '{}', NULL);
             INSERT INTO scene_codex_pins(scene_id, entry_id, created_at)
             VALUES ('scene-archived', 'entry-a', 't'),
                    ('scene-foreign', 'entry-a', 't'),
                    ('note-a', 'entry-a', 't'),
                    ('scene-a', 'entry-foreign', 't');",
        )
        .expect("filtered pins");
        conn.execute_batch("BEGIN").expect("begin");
        let mut budget = SceneJoinBudget::new(32, 1024);
        let mut check = check();
        let page = read_scene_pin_page(
            &conn,
            "project-a",
            "entry-a",
            0,
            16,
            &mut budget,
            &mut check,
        )
        .expect("page");
        assert_eq!(
            page.iter()
                .map(|pin| pin.scene_id.as_str())
                .collect::<Vec<_>>(),
            vec!["scene-a"]
        );
        assert!(scene_pins_remain(&conn, "project-a", "entry-a", 0, &mut check).expect("probe"));
        // The archived, foreign and non-Scene rows after it are not "more".
        assert!(
            !scene_pins_remain(&conn, "project-a", "entry-a", page[0].rowid, &mut check)
                .expect("probe")
        );
        // A pin of another project's Entity is not this project's pin.
        assert!(
            !scene_pins_remain(&conn, "project-a", "entry-foreign", 0, &mut check).expect("probe")
        );
        assert_eq!(budget.rows(), 1);
    }

    #[test]
    fn nonpositive_pin_rowid_refuses_the_keyset() {
        let conn = connection();
        conn.execute_batch(
            "INSERT INTO tree_nodes(id, project_id, node_type, version, updated_at, content)
             VALUES ('scene-z', 'project-a', 'scene', 1, 't', '{}');
             INSERT INTO scene_codex_pins(rowid, scene_id, entry_id, created_at)
             VALUES (-1, 'scene-z', 'entry-a', 't');",
        )
        .expect("nonpositive pin");
        conn.execute_batch("BEGIN").expect("begin");
        let mut budget = SceneJoinBudget::new(32, 1024);
        let mut check = check();
        let error = read_scene_pin_page(
            &conn,
            "project-a",
            "entry-a",
            0,
            16,
            &mut budget,
            &mut check,
        )
        .expect_err("a keyset after rowid 0 would skip the pin");
        assert!(error
            .to_string()
            .contains("NIR1_GRAPH_SCENE_INVALID_PIN_CURSOR"));
        let error = scene_pins_remain(&conn, "project-a", "entry-a", 0, &mut check)
            .expect_err("the probe refuses the same pin");
        assert!(error
            .to_string()
            .contains("NIR1_GRAPH_SCENE_INVALID_PIN_CURSOR"));
        assert_eq!(budget.rows(), 0);
    }
}
