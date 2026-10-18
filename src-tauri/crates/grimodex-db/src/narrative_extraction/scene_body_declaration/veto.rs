//! The veto of a body declaration (draft "宣言の値"). Shared by the declaration
//! writer and preview (CB-2) and the reader (CB-4): both call
//! [`scene_body_declaration_veto`], so the two verdicts cannot drift.
//!
//! A veto is a record that already classifies the Scene's body as secret or as
//! seen from one viewpoint. The absence of such a record never proves that the
//! body is free of secrets; the author's declaration states that, and the veto
//! only refuses a declaration that contradicts a known record.

use std::fmt;

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use super::limits::{
    SCENE_BODY_READ_MAX_BYTES, SCENE_BODY_VETO_MAX_ROWS, VETO_CONTENT_LIMIT_MARKER,
    VETO_ROW_LIMIT_MARKER,
};

/// What contradicts a `non-secret`, `independent` declaration. A closed set.
/// The kind is told apart only in the writer's and preview's refusal code and
/// in diagnostics counters; the reader (CB-4) folds every kind into its single
/// aggregated code.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BodyDeclarationVeto {
    /// A secret foreshadow has a setup, a payoff or a legacy payoff in the
    /// Scene (abandoned or confirmed or not).
    SecretForeshadow,
    /// A secret Chronicle event names the Scene as its reveal Scene.
    SecretEventReveal,
    /// A secret Chronicle event is linked to the Scene by `scene_events`.
    SecretEventLink,
    /// The Scene has a POV: its own, a beat's `pov` attribute in the saved
    /// body, or a `scene_beat_pov_cache` row.
    Pov,
}

impl BodyDeclarationVeto {
    pub fn code(self) -> &'static str {
        match self {
            Self::SecretForeshadow => "veto-secret-foreshadow",
            Self::SecretEventReveal => "veto-secret-event-reveal",
            Self::SecretEventLink => "veto-secret-event-link",
            Self::Pov => "veto-pov",
        }
    }
}

impl fmt::Display for BodyDeclarationVeto {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

/// Bounds of one veto evaluation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VetoLimits {
    /// Most rows looked at, over all sources together.
    pub max_rows: usize,
    /// Most `octet_length` of the saved body that is read to find a beat POV.
    pub max_content_bytes: usize,
}

impl VetoLimits {
    pub const DEFAULT: Self = Self {
        max_rows: SCENE_BODY_VETO_MAX_ROWS,
        max_content_bytes: SCENE_BODY_READ_MAX_BYTES,
    };
}

impl Default for VetoLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Decides whether a Scene's body may be declared `non-secret` and
/// `independent`. Call it inside a read transaction.
///
/// `Ok(Some(_))` is a veto. `Ok(None)` means no known record contradicts the
/// declaration (not that the body is free of secrets). More rows than
/// `limits.max_rows`, or a saved body above `limits.max_content_bytes`, is an
/// `Err` carrying [`VETO_ROW_LIMIT_MARKER`] or [`VETO_CONTENT_LIMIT_MARKER`]
/// and never a verdict. A veto found before a limit is reached wins.
pub fn scene_body_declaration_veto(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    limits: VetoLimits,
) -> Result<Option<BodyDeclarationVeto>> {
    let records = scene_body_declaration_veto_records(conn, project_id, scene_id, limits.max_rows)?;
    if records.veto.is_some() {
        return Ok(records.veto);
    }

    // A beat's `pov` attribute in the saved body. The length is measured
    // before the text is read.
    let content_bytes: Option<i64> = conn
        .query_row(
            "SELECT octet_length(content) FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(content_bytes) = content_bytes else {
        return Ok(None);
    };
    if usize::try_from(content_bytes).map_or(true, |bytes| bytes > limits.max_content_bytes) {
        return Err(anyhow!(VETO_CONTENT_LIMIT_MARKER));
    }
    let content: String = conn.query_row(
        "SELECT content FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
        params![scene_id, project_id],
        |row| row.get(0),
    )?;
    if saved_body_has_beat_pov(&content)? {
        return Ok(Some(BodyDeclarationVeto::Pov));
    }
    Ok(None)
}

/// What the records of a Scene say, without the saved body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct VetoRecordsRead {
    pub veto: Option<BodyDeclarationVeto>,
    /// Rows of the secret queries that were looked at (the POV records are
    /// single-row lookups and are not counted, as in the full veto).
    pub rows_looked_at: usize,
}

/// The part of [`scene_body_declaration_veto`] that looks only at records: the
/// secret foreshadows and Chronicle events that name the Scene, the Scene's
/// own POV and the POV cache. It never reads the saved body (`content`), so
/// the reader can run it for every candidate without a body read. More than
/// `max_rows` rows is an `Err` carrying [`VETO_ROW_LIMIT_MARKER`].
pub(crate) fn scene_body_declaration_veto_records(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    max_rows: usize,
) -> Result<VetoRecordsRead> {
    let mut remaining = max_rows;
    let veto = veto_from_records(conn, project_id, scene_id, &mut remaining)?;
    Ok(VetoRecordsRead {
        veto,
        rows_looked_at: max_rows - remaining,
    })
}

fn veto_from_records(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    remaining: &mut usize,
) -> Result<Option<BodyDeclarationVeto>> {
    // Foreshadows: the secret flag is the author's record. A legacy foreshadow
    // (the column was added with default 0) is not secret.
    for sql in [
        "SELECT f.secret FROM foreshadows f
          WHERE f.project_id = ?1 AND f.payoff_scene_id = ?2 LIMIT ?3",
        "SELECT f.secret FROM foreshadow_setups s
           JOIN foreshadows f ON f.id = s.foreshadow_id
          WHERE f.project_id = ?1 AND s.scene_id = ?2 LIMIT ?3",
        "SELECT f.secret FROM foreshadow_payoffs p
           JOIN foreshadows f ON f.id = p.foreshadow_id
          WHERE f.project_id = ?1 AND p.scene_id = ?2 LIMIT ?3",
    ] {
        if secret_row_found(conn, sql, project_id, scene_id, remaining)? {
            return Ok(Some(BodyDeclarationVeto::SecretForeshadow));
        }
    }

    if secret_row_found(
        conn,
        "SELECT e.secret FROM events e
          WHERE e.project_id = ?1 AND e.reveal_scene_id = ?2 LIMIT ?3",
        project_id,
        scene_id,
        remaining,
    )? {
        return Ok(Some(BodyDeclarationVeto::SecretEventReveal));
    }
    if secret_row_found(
        conn,
        "SELECT e.secret FROM scene_events se
           JOIN events e ON e.id = se.event_id
          WHERE se.scene_id = ?2 AND e.project_id = ?1 LIMIT ?3",
        project_id,
        scene_id,
        remaining,
    )? {
        return Ok(Some(BodyDeclarationVeto::SecretEventLink));
    }

    // POV records. A non-NULL value is a POV whatever it holds (fail closed).
    let scene_pov: Option<Option<String>> = conn
        .query_row(
            "SELECT pov_character_id FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    if matches!(scene_pov, Some(Some(_))) {
        return Ok(Some(BodyDeclarationVeto::Pov));
    }
    let cached: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM scene_beat_pov_cache WHERE scene_id = ?1)",
        params![scene_id],
        |row| row.get(0),
    )?;
    if cached {
        return Ok(Some(BodyDeclarationVeto::Pov));
    }
    Ok(None)
}

/// Looks at up to `remaining` rows of a `secret` query and reports whether one
/// of them is secret. One row more than `remaining` is the limit error.
fn secret_row_found(
    conn: &Connection,
    sql: &str,
    project_id: &str,
    scene_id: &str,
    remaining: &mut usize,
) -> Result<bool> {
    let fetch = i64::try_from(remaining.saturating_add(1))?;
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params![project_id, scene_id, fetch], |row| {
        row.get::<_, i64>(0)
    })?;
    for secret in rows {
        let secret = secret?;
        if *remaining == 0 {
            return Err(anyhow!(VETO_ROW_LIMIT_MARKER));
        }
        *remaining -= 1;
        if secret != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// True when a `sceneBeat` node anywhere in the saved ProseMirror JSON has a
/// non-empty `pov` attribute. The JSON is walked as a stream: the document is
/// never held as a tree, only each node's own `type` and `attrs`.
fn saved_body_has_beat_pov(content: &str) -> Result<bool> {
    let mut deserializer = serde_json::Deserializer::from_str(content);
    let found = NodeSeed.deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(found)
}

fn attrs_have_pov(attrs: &Value) -> bool {
    match attrs.get("pov") {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.trim().is_empty(),
        // Any other shape is not a recognized empty value: treat it as a POV.
        Some(_) => true,
    }
}

struct NodeSeed;

impl<'de> DeserializeSeed<'de> for NodeSeed {
    type Value = bool;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<bool, D::Error> {
        deserializer.deserialize_any(NodeVisitor)
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = bool;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a ProseMirror JSON node")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        let mut is_beat = false;
        let mut beat_pov = false;
        let mut child_found = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "type" => {
                    is_beat |= matches!(
                        map.next_value::<Value>()?,
                        Value::String(ref name) if name == "sceneBeat"
                    );
                }
                "attrs" => {
                    beat_pov |= attrs_have_pov(&map.next_value::<Value>()?);
                }
                "content" => {
                    child_found |= map.next_value_seed(NodeSeed)?;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok((is_beat && beat_pov) || child_found)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
        let mut found = false;
        while let Some(child) = seq.next_element_seed(NodeSeed)? {
            found |= child;
        }
        Ok(found)
    }

    fn visit_bool<E>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_i64<E>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_u64<E>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_f64<E>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_str<E>(self, _: &str) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E>(self) -> Result<bool, E> {
        Ok(false)
    }
}
