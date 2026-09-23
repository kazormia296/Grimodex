//! Native-owned Narrative Maintenance Change Feed (SCHEMA_VERSION 22).
//!
//! The canonical `change_events` hash chain remains the audit / Undo ledger.
//! This module stores only typed, project-scoped facts used by downstream
//! freshness and dependency invalidation. Appends require a caller-owned
//! transaction so domain mutation, Undo journal, canonical Change Event, and
//! the maintenance feed commit or roll back together.

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Deserializer, Value};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::fmt;
use uuid::Uuid;

/// The coordinate system used by the renderer's canonical text projection.
/// Keep this value on every text impact so a future normalizer can reject or
/// rebuild old ranges instead of silently interpreting them in a new space.
pub(crate) const CANONICAL_TEXT_NORMALIZER_VERSION: &str = "gdx-canonical-text/1";

use crate::change_events::{
    append_change_events_in_tx, AppendChangeEvent, AppendResult as AppendCanonicalChangeResult,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeChangeCauseKind {
    Forward,
    Undo,
    Redo,
}

impl NarrativeChangeCauseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Forward => "forward",
            Self::Undo => "undo",
            Self::Redo => "redo",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeChangeOrigin {
    Human,
    AiApply,
    Import,
    Undo,
    Redo,
    Restore,
    Migration,
}

/// Fail closed when a replay tries to name a journal or forward transaction
/// from another project (or an unrelated journal in the same project).
pub(crate) fn require_replay_lineage_in_project(
    conn: &Connection,
    project_id: &str,
    original_transaction_id: &str,
    undo_journal_id: &str,
) -> anyhow::Result<()> {
    let lineage_owned = conn
        .query_row(
            "SELECT 1
               FROM narrative_change_transactions transaction_row
               JOIN undo_journal journal
                 ON journal.id = transaction_row.undo_journal_id
                AND journal.project_id = transaction_row.project_id
              WHERE transaction_row.id = ?1
                AND transaction_row.project_id = ?2
                AND transaction_row.undo_journal_id = ?3
                AND transaction_row.cause_kind = 'forward'",
            params![original_transaction_id, project_id, undo_journal_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        lineage_owned,
        "Change Feed replay lineage is not in the active project"
    );
    Ok(())
}

/// Validate a typed inverse mutation that reuses a root forward transaction
/// without replaying that transaction's Undo Journal directly.
///
/// Plot/Foreshadow history closures call their normal typed writers in reverse
/// (for example create -> delete). They can legitimately create a fresh inverse
/// journal, but the named root must still be the same canonical domain entity
/// in the active project. A same-project transaction for another entity is not
/// interchangeable lineage.
pub(crate) fn require_typed_inverse_lineage_in_project(
    conn: &Connection,
    project_id: &str,
    original_transaction_id: &str,
    canonical_domain: &str,
    canonical_entity_id: &str,
) -> anyhow::Result<()> {
    let lineage_matches_entity = conn
        .query_row(
            "SELECT 1
               FROM narrative_change_transactions transaction_row
               JOIN change_events canonical
                 ON canonical.project_id = transaction_row.project_id
                AND canonical.event_uid = transaction_row.source_change_event_uid
              WHERE transaction_row.id = ?1
                AND transaction_row.project_id = ?2
                AND transaction_row.cause_kind = 'forward'
                AND canonical.domain = ?3
                AND canonical.entity_id = ?4",
            params![
                original_transaction_id,
                project_id,
                canonical_domain,
                canonical_entity_id
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        lineage_matches_entity,
        "typed inverse Change Feed lineage does not identify the same project entity"
    );
    Ok(())
}

impl NarrativeChangeOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::AiApply => "ai-apply",
            Self::Import => "import",
            Self::Undo => "undo",
            Self::Redo => "redo",
            Self::Restore => "restore",
            Self::Migration => "migration",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeChangeEventInput {
    pub object_key: Value,
    pub change_kind: String,
    pub mutation_kind: String,
    #[serde(default)]
    pub before_version: Option<i64>,
    #[serde(default)]
    pub before_digest: Option<String>,
    #[serde(default)]
    pub after_version: Option<i64>,
    #[serde(default)]
    pub after_digest: Option<String>,
    #[serde(default = "default_changed_paths")]
    pub changed_paths: Vec<String>,
    #[serde(default)]
    pub text_impact: Option<Value>,
    #[serde(default)]
    pub structural_impact: Option<Value>,
}

fn default_changed_paths() -> Vec<String> {
    vec!["/".to_string()]
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendNarrativeChangeTransactionInput {
    pub project_id: String,
    pub request_id: String,
    pub source_domain: String,
    pub source_change_event_uid: String,
    pub cause_kind: NarrativeChangeCauseKind,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub commit_id: Option<String>,
    #[serde(default)]
    pub journal_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    #[serde(default)]
    pub application_ids: Vec<String>,
    pub occurred_at: String,
    pub events: Vec<NarrativeChangeEventInput>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendNarrativeChangeTransactionResult {
    pub transaction_id: String,
    pub canonical_sequence: i64,
    pub event_ids: Vec<String>,
    pub replayed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppendCanonicalNarrativeChangeResult {
    pub canonical: AppendCanonicalChangeResult,
    pub narrative: AppendNarrativeChangeTransactionResult,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeChangeEventRecord {
    pub event_id: String,
    pub project_id: String,
    pub transaction_id: String,
    pub canonical_change_event_uid: String,
    pub canonical_sequence: i64,
    pub event_ordinal: i64,
    pub object_key: Value,
    pub change_kind: String,
    pub mutation_kind: String,
    pub before_version: Option<i64>,
    pub before_digest: Option<String>,
    pub after_version: Option<i64>,
    pub after_digest: Option<String>,
    pub changed_paths: Vec<String>,
    pub text_impact: Option<Value>,
    pub structural_impact: Option<Value>,
    pub cause_kind: NarrativeChangeCauseKind,
    pub origin: NarrativeChangeOrigin,
    pub original_transaction_id: Option<String>,
    pub commit_id: Option<String>,
    pub journal_id: Option<String>,
    pub undo_journal_id: Option<String>,
    pub application_ids: Vec<String>,
    pub occurred_at: String,
}

const CHANGE_KINDS: &[&str] = &[
    "content",
    "metadata",
    "order",
    "association",
    "catalog",
    "calendar",
    "policy",
    "schema",
    "unknown",
];
const MUTATION_KINDS: &[&str] = &["create", "update", "delete", "restore"];
const MAX_READ_LIMIT: i64 = 500;

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    Ok(())
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

/// Key-order-independent SHA-256 of a JSON value, `sha256:`-prefixed.
fn digest_value(value: &Value) -> anyhow::Result<String> {
    let mut canonical = value.clone();
    canonicalize_json(&mut canonical);
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&canonical)?))
    ))
}

pub(crate) fn payload_digest(
    input: &AppendNarrativeChangeTransactionInput,
) -> anyhow::Result<String> {
    let mut normalized = input.clone();
    normalized.application_ids.sort();
    digest_value(&serde_json::to_value(normalized)?)
}

pub(crate) fn previous_event_after_state(
    conn: &Connection,
    project_id: &str,
    identity: &str,
) -> anyhow::Result<Option<(Option<i64>, Option<String>)>> {
    conn.query_row(
        "SELECT after_version, after_digest
           FROM narrative_change_object_heads
          WHERE project_id = ?1 AND object_identity = ?2",
        params![project_id, identity],
        |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    )
    .optional()
    .map_err(Into::into)
}

struct NarrativeChangeObjectHead<'a> {
    project_id: &'a str,
    identity: &'a str,
    after_version: Option<i64>,
    after_digest: Option<&'a str>,
    event_id: &'a str,
    canonical_sequence: i64,
    event_ordinal: i64,
    occurred_at: &'a str,
}

fn upsert_object_head(
    conn: &Connection,
    head: NarrativeChangeObjectHead<'_>,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_change_object_heads (
            project_id, object_identity, after_version, after_digest, event_id,
            canonical_sequence, event_ordinal, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(project_id, object_identity) DO UPDATE SET
            after_version = excluded.after_version,
            after_digest = excluded.after_digest,
            event_id = excluded.event_id,
            canonical_sequence = excluded.canonical_sequence,
            event_ordinal = excluded.event_ordinal,
            updated_at = excluded.updated_at
          WHERE excluded.canonical_sequence > narrative_change_object_heads.canonical_sequence
             OR (excluded.canonical_sequence = narrative_change_object_heads.canonical_sequence
                 AND excluded.event_ordinal > narrative_change_object_heads.event_ordinal)",
        params![
            head.project_id,
            head.identity,
            head.after_version,
            head.after_digest,
            head.event_id,
            head.canonical_sequence,
            head.event_ordinal,
            head.occurred_at,
        ],
    )?;
    Ok(())
}

const CANONICAL_TEXT_CHECK_BYTES: usize = 1024;
// Graph source reads use a streaming visitor rather than constructing a
// serde_json::Value tree. This is a refusal boundary, not a supported Scene
// size promise: a bounded input is still rejected when the caller's live
// output/parse budget cannot admit its transient allocations.
const CANONICAL_PARSE_INPUT_LIMIT: usize = 32 * 1024;
const CANONICAL_STREAM_MAX_DEPTH: usize = 32;

fn normalize_canonical_fragment<E>(
    value: &str,
    emit: &mut dyn FnMut(&str) -> Result<(), E>,
    check: &mut dyn FnMut() -> Result<(), E>,
) -> Result<(), E> {
    let mut start = 0;
    while start < value.len() {
        check()?;
        let mut end = start
            .saturating_add(CANONICAL_TEXT_CHECK_BYTES)
            .min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        // Keep CRLF together even when it crosses a bounded piece boundary.
        if value.as_bytes().get(end.wrapping_sub(1)) == Some(&b'\r')
            && value.as_bytes().get(end) == Some(&b'\n')
        {
            end += 1;
        }
        let mut piece = &value[start..end];
        while let Some(cr) = piece.find('\r') {
            emit(&piece[..cr])?;
            emit("\n")?;
            piece = &piece[cr + 1..];
            if let Some(rest) = piece.strip_prefix('\n') {
                piece = rest;
            }
        }
        emit(piece)?;
        start = end;
    }
    Ok(())
}

fn append_canonical_inline_text<E>(
    node: &Value,
    emit: &mut dyn FnMut(&str) -> Result<(), E>,
    check: &mut dyn FnMut() -> Result<(), E>,
) -> Result<(), E> {
    check()?;
    match node.get("type").and_then(Value::as_str) {
        Some("text") => {
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                normalize_canonical_fragment(text, emit, check)?;
            }
        }
        Some("hardBreak") => emit("\n")?,
        Some("ruby") => {
            if let Some(base) = node
                .get("attrs")
                .and_then(|attrs| attrs.get("base"))
                .and_then(Value::as_str)
            {
                normalize_canonical_fragment(base, emit, check)?;
            }
        }
        Some("mention") => {
            let label = node
                .get("attrs")
                .and_then(|attrs| attrs.get("label"))
                .and_then(Value::as_str)
                .or_else(|| {
                    node.get("attrs")
                        .and_then(|attrs| attrs.get("id"))
                        .and_then(Value::as_str)
                })
                .unwrap_or_default();
            emit("@")?;
            normalize_canonical_fragment(label, emit, check)?;
        }
        Some("image") => emit("\u{fffc}")?,
        _ => {
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                for child in children {
                    append_canonical_inline_text(child, emit, check)?;
                }
            }
        }
    }
    Ok(())
}

fn begin_canonical_block<E>(
    blocks: &mut usize,
    emit: &mut dyn FnMut(&str) -> Result<(), E>,
) -> Result<(), E> {
    if *blocks > 0 {
        emit("\n")?;
    }
    *blocks += 1;
    Ok(())
}

fn collect_canonical_blocks<E>(
    node: &Value,
    blocks: &mut usize,
    emit: &mut dyn FnMut(&str) -> Result<(), E>,
    check: &mut dyn FnMut() -> Result<(), E>,
) -> Result<(), E> {
    check()?;
    let node_type = node.get("type").and_then(Value::as_str);
    match node_type {
        Some("doc") => {
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                for child in children {
                    collect_canonical_blocks(child, blocks, emit, check)?;
                }
            }
        }
        Some("paragraph") | Some("heading") | Some("codeBlock") | Some("sceneBeat") => {
            begin_canonical_block(blocks, emit)?;
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                for child in children {
                    append_canonical_inline_text(child, emit, check)?;
                }
            }
        }
        Some("horizontalRule") | Some("sceneBreak") => begin_canonical_block(blocks, emit)?,
        Some("image") => {
            begin_canonical_block(blocks, emit)?;
            emit("\u{fffc}")?;
        }
        _ => {
            let before = *blocks;
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                for child in children {
                    collect_canonical_blocks(child, blocks, emit, check)?;
                }
            }
            // This mirrors collectBlocks in the TypeScript serializer: a
            // valid empty block container is represented by an empty block so
            // synthetic boundaries remain deterministic.
            if *blocks == before {
                begin_canonical_block(blocks, emit)?;
            }
        }
    }
    Ok(())
}

/// A request-local projection produced while the JSON visitor walks one node.
/// The parser keeps only the two projections needed to resolve arbitrary
/// ProseMirror field order: a node's block form and its inline form. It never
/// retains unknown JSON fields or a serde_json::Value tree.
struct StreamingSceneNode {
    block: StreamingSceneBlocks,
    inline: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StreamingSceneNodeKind {
    Text,
    HardBreak,
    Ruby,
    Mention,
    Image,
    Doc,
    Paragraph,
    Heading,
    CodeBlock,
    SceneBeat,
    HorizontalRule,
    SceneBreak,
    Other,
}

impl StreamingSceneNodeKind {
    fn from_type(node_type: Option<&str>) -> Self {
        match node_type {
            Some("text") => Self::Text,
            Some("hardBreak") => Self::HardBreak,
            Some("ruby") => Self::Ruby,
            Some("mention") => Self::Mention,
            Some("image") => Self::Image,
            Some("doc") => Self::Doc,
            Some("paragraph") => Self::Paragraph,
            Some("heading") => Self::Heading,
            Some("codeBlock") => Self::CodeBlock,
            Some("sceneBeat") => Self::SceneBeat,
            Some("horizontalRule") => Self::HorizontalRule,
            Some("sceneBreak") => Self::SceneBreak,
            _ => Self::Other,
        }
    }
}

struct StreamingSceneBlocks {
    text: String,
    count: usize,
}

struct StreamingSceneState<'de> {
    node_type: Option<Cow<'de, str>>,
    text: Option<Cow<'de, str>>,
    attrs: StreamingSceneAttrs<'de>,
    block_children: String,
    block_count: usize,
    inline_children: String,
}

impl<'de> StreamingSceneState<'de> {
    fn new() -> Self {
        Self {
            node_type: None,
            text: None,
            attrs: StreamingSceneAttrs::default(),
            block_children: String::new(),
            block_count: 0,
            inline_children: String::new(),
        }
    }
}

#[derive(Default)]
struct StreamingSceneAttrs<'de> {
    base: Option<Cow<'de, str>>,
    label: Option<Cow<'de, str>>,
    id: Option<Cow<'de, str>>,
}

struct StreamingSceneParser<'a> {
    max_output_bytes: usize,
    json_string_reservation: usize,
    check: &'a mut dyn FnMut() -> anyhow::Result<()>,
    admit_parse: &'a mut dyn FnMut(usize) -> anyhow::Result<()>,
    admit_output: &'a mut dyn FnMut(usize) -> anyhow::Result<()>,
}

impl StreamingSceneParser<'_> {
    fn check(&mut self) -> anyhow::Result<()> {
        (self.check)()
    }

    fn admit_parse(&mut self, bytes: usize) -> anyhow::Result<()> {
        (self.admit_parse)(bytes)
    }

    fn admit_output(&mut self, bytes: usize) -> anyhow::Result<()> {
        (self.admit_output)(bytes)
    }

    fn begin_node(&mut self, depth: usize) -> anyhow::Result<()> {
        anyhow::ensure!(
            depth <= CANONICAL_STREAM_MAX_DEPTH,
            "NEX_CANONICAL_TEXT_DEPTH_LIMIT"
        );
        self.check()?;
        // No JSON node is retained after its two projections are returned.
        // This accounts for the visitor's request-local node state and call
        // stack separately from any String capacity admitted below.
        self.admit_parse(128)?;
        Ok(())
    }

    fn begin_skipped_value(&mut self, depth: usize) -> anyhow::Result<()> {
        anyhow::ensure!(
            depth <= CANONICAL_STREAM_MAX_DEPTH,
            "NEX_CANONICAL_TEXT_DEPTH_LIMIT"
        );
        self.check()?;
        // serde_json may use its scratch buffer when an ignored string has
        // escapes. Reserve a bounded worst case before entering the value;
        // nested skipped values charge independently.
        self.admit_parse(self.json_string_reservation)?;
        Ok(())
    }

    fn reserve_json_string(&mut self) -> anyhow::Result<()> {
        self.check()?;
        // A borrowed string costs no heap, while an escaped string can occupy
        // both serde_json's scratch buffer and an owned Cow. The hard input
        // cap bounds this conservative pre-admission; it is deliberately
        // charged before deserialize_str can allocate either representation.
        self.admit_parse(self.json_string_reservation)
    }

    fn append_piece(&mut self, output: &mut String, piece: &str) -> anyhow::Result<()> {
        self.check()?;
        if piece.is_empty() {
            return Ok(());
        }
        let new_len = output
            .len()
            .checked_add(piece.len())
            .ok_or_else(|| anyhow::anyhow!("NEX_CANONICAL_TEXT_OUTPUT_LIMIT"))?;
        anyhow::ensure!(
            new_len <= self.max_output_bytes,
            "NEX_CANONICAL_TEXT_OUTPUT_LIMIT"
        );
        self.admit_output(piece.len())?;
        output.try_reserve_exact(piece.len())?;
        output.push_str(piece);
        Ok(())
    }

    fn append_normalized(&mut self, output: &mut String, value: &str) -> anyhow::Result<()> {
        let mut start = 0;
        while start < value.len() {
            self.check()?;
            let mut end = start
                .saturating_add(CANONICAL_TEXT_CHECK_BYTES)
                .min(value.len());
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            if value.as_bytes().get(end.wrapping_sub(1)) == Some(&b'\r')
                && value.as_bytes().get(end) == Some(&b'\n')
            {
                end += 1;
            }
            let mut piece = &value[start..end];
            while let Some(cr) = piece.find('\r') {
                self.append_piece(output, &piece[..cr])?;
                self.append_piece(output, "\n")?;
                piece = &piece[cr + 1..];
                if let Some(rest) = piece.strip_prefix('\n') {
                    piece = rest;
                }
            }
            self.append_piece(output, piece)?;
            start = end;
        }
        Ok(())
    }

    fn append_block_child(
        &mut self,
        target: &mut String,
        count: &mut usize,
        child: &StreamingSceneNode,
    ) -> anyhow::Result<()> {
        if child.block.count == 0 {
            return Ok(());
        }
        if *count > 0 {
            self.append_piece(target, "\n")?;
        }
        self.append_piece(target, &child.block.text)?;
        *count = (*count)
            .checked_add(child.block.count)
            .ok_or_else(|| anyhow::anyhow!("NEX_CANONICAL_TEXT_NODE_LIMIT"))?;
        Ok(())
    }

    fn finish_node<'de>(
        &mut self,
        state: StreamingSceneState<'de>,
    ) -> anyhow::Result<StreamingSceneNode> {
        self.check()?;
        let node_kind = StreamingSceneNodeKind::from_type(state.node_type.as_deref());
        let inline = match node_kind {
            StreamingSceneNodeKind::Text => {
                let mut output = String::new();
                if let Some(text) = state.text.as_deref() {
                    self.append_normalized(&mut output, text)?;
                }
                output
            }
            StreamingSceneNodeKind::HardBreak => {
                let mut output = String::new();
                self.append_piece(&mut output, "\n")?;
                output
            }
            StreamingSceneNodeKind::Ruby => {
                let mut output = String::new();
                if let Some(base) = state.attrs.base.as_deref() {
                    self.append_normalized(&mut output, base)?;
                }
                output
            }
            StreamingSceneNodeKind::Mention => {
                let mut output = String::new();
                self.append_piece(&mut output, "@")?;
                let label = state
                    .attrs
                    .label
                    .as_deref()
                    .or(state.attrs.id.as_deref())
                    .unwrap_or_default();
                self.append_normalized(&mut output, label)?;
                output
            }
            StreamingSceneNodeKind::Image => {
                let mut output = String::new();
                self.append_piece(&mut output, "\u{fffc}")?;
                output
            }
            _ => state.inline_children,
        };

        let block = match node_kind {
            StreamingSceneNodeKind::Doc => StreamingSceneBlocks {
                text: state.block_children,
                count: state.block_count,
            },
            StreamingSceneNodeKind::Paragraph
            | StreamingSceneNodeKind::Heading
            | StreamingSceneNodeKind::CodeBlock
            | StreamingSceneNodeKind::SceneBeat => {
                let mut text = String::new();
                self.append_piece(&mut text, &inline)?;
                StreamingSceneBlocks { text, count: 1 }
            }
            StreamingSceneNodeKind::HorizontalRule | StreamingSceneNodeKind::SceneBreak => {
                StreamingSceneBlocks {
                    text: String::new(),
                    count: 1,
                }
            }
            StreamingSceneNodeKind::Image => {
                let mut text = String::new();
                self.append_piece(&mut text, "\u{fffc}")?;
                StreamingSceneBlocks { text, count: 1 }
            }
            _ if state.block_count > 0 => StreamingSceneBlocks {
                text: state.block_children,
                count: state.block_count,
            },
            _ => StreamingSceneBlocks {
                text: String::new(),
                count: 1,
            },
        };
        self.check()?;
        Ok(StreamingSceneNode { block, inline })
    }
}

struct StreamingSceneStringVisitor;

impl<'de> Visitor<'de> for StreamingSceneStringVisitor {
    type Value = Cow<'de, str>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON string")
    }

    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Cow::Borrowed(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Cow::Owned(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Cow::Owned(value))
    }
}

struct StreamingSceneStringSeed<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
}

impl<'de, 'p, 'a> DeserializeSeed<'de> for StreamingSceneStringSeed<'p, 'a> {
    type Value = Cow<'de, str>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        self.parser
            .reserve_json_string()
            .map_err(de::Error::custom)?;
        deserializer.deserialize_str(StreamingSceneStringVisitor)
    }
}

struct StreamingSceneOptionalStringSeed<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
}

struct StreamingSceneOptionalStringVisitor<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
}

impl<'de, 'p, 'a> Visitor<'de> for StreamingSceneOptionalStringVisitor<'p, 'a> {
    type Value = Option<Cow<'de, str>>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an optional JSON string")
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(None)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(None)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        StreamingSceneStringSeed {
            parser: self.parser,
        }
        .deserialize(deserializer)
        .map(Some)
    }
}

impl<'de, 'p, 'a> DeserializeSeed<'de> for StreamingSceneOptionalStringSeed<'p, 'a> {
    type Value = Option<Cow<'de, str>>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_option(StreamingSceneOptionalStringVisitor {
            parser: self.parser,
        })
    }
}

struct StreamingSceneSkipSeed<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
}

struct StreamingSceneSkipVisitor<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
}

impl<'p, 'a> StreamingSceneSkipVisitor<'p, 'a> {
    fn check<E>(self) -> Result<Self, E>
    where
        E: de::Error,
    {
        self.parser.check().map_err(E::custom)?;
        Ok(self)
    }
}

impl<'de, 'p, 'a> Visitor<'de> for StreamingSceneSkipVisitor<'p, 'a> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_i128<E>(self, _value: i128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_u128<E>(self, _value: u128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_borrowed_str<E>(self, _value: &'de str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.check::<E>().map(|_| ())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        StreamingSceneSkipSeed {
            parser: self.parser,
            depth: self.depth + 1,
        }
        .deserialize(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let parser = self.parser;
        while let Some(()) = sequence.next_element_seed(StreamingSceneSkipSeed {
            parser: &mut *parser,
            depth: self.depth + 1,
        })? {}
        Ok(())
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let parser = self.parser;
        while let Some(_key) = map.next_key_seed(StreamingSceneStringSeed {
            parser: &mut *parser,
        })? {
            map.next_value_seed(StreamingSceneSkipSeed {
                parser: &mut *parser,
                depth: self.depth + 1,
            })?;
        }
        Ok(())
    }
}

impl<'de, 'p, 'a> DeserializeSeed<'de> for StreamingSceneSkipSeed<'p, 'a> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        self.parser
            .begin_skipped_value(self.depth)
            .map_err(de::Error::custom)?;
        deserializer.deserialize_any(StreamingSceneSkipVisitor {
            parser: self.parser,
            depth: self.depth,
        })
    }
}

struct StreamingSceneAttrsSeed<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
}

struct StreamingSceneAttrsVisitor<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
}

impl<'de, 'p, 'a> Visitor<'de> for StreamingSceneAttrsVisitor<'p, 'a> {
    type Value = StreamingSceneAttrs<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a Scene attrs object")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let parser = self.parser;
        let mut attrs = StreamingSceneAttrs::default();
        while let Some(key) = map.next_key_seed(StreamingSceneStringSeed {
            parser: &mut *parser,
        })? {
            parser.check().map_err(de::Error::custom)?;
            match key.as_ref() {
                "base" => {
                    attrs.base = map.next_value_seed(StreamingSceneOptionalStringSeed {
                        parser: &mut *parser,
                    })?;
                }
                "label" => {
                    attrs.label = map.next_value_seed(StreamingSceneOptionalStringSeed {
                        parser: &mut *parser,
                    })?;
                }
                "id" => {
                    attrs.id = map.next_value_seed(StreamingSceneOptionalStringSeed {
                        parser: &mut *parser,
                    })?;
                }
                _ => {
                    map.next_value_seed(StreamingSceneSkipSeed {
                        parser: &mut *parser,
                        depth: self.depth + 1,
                    })?;
                }
            }
        }
        Ok(attrs)
    }
}

impl<'de, 'p, 'a> DeserializeSeed<'de> for StreamingSceneAttrsSeed<'p, 'a> {
    type Value = StreamingSceneAttrs<'de>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_map(StreamingSceneAttrsVisitor {
            parser: self.parser,
            depth: self.depth,
        })
    }
}

struct StreamingSceneChildrenSeed<'p, 'a, 'out> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
    block_children: &'out mut String,
    block_count: &'out mut usize,
    inline_children: &'out mut String,
}

struct StreamingSceneChildrenVisitor<'p, 'a, 'out> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
    block_children: &'out mut String,
    block_count: &'out mut usize,
    inline_children: &'out mut String,
}

impl<'de, 'p, 'a, 'out> Visitor<'de> for StreamingSceneChildrenVisitor<'p, 'a, 'out> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a Scene content array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let parser = self.parser;
        while let Some(child) = sequence.next_element_seed(StreamingSceneNodeSeed {
            parser: &mut *parser,
            depth: self.depth,
        })? {
            parser
                .append_block_child(self.block_children, self.block_count, &child)
                .map_err(de::Error::custom)?;
            parser
                .append_piece(self.inline_children, &child.inline)
                .map_err(de::Error::custom)?;
        }
        Ok(())
    }
}

impl<'de, 'p, 'a, 'out> DeserializeSeed<'de> for StreamingSceneChildrenSeed<'p, 'a, 'out> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_seq(StreamingSceneChildrenVisitor {
            parser: self.parser,
            depth: self.depth,
            block_children: self.block_children,
            block_count: self.block_count,
            inline_children: self.inline_children,
        })
    }
}

struct StreamingSceneNodeSeed<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
}

struct StreamingSceneNodeVisitor<'p, 'a> {
    parser: &'p mut StreamingSceneParser<'a>,
    depth: usize,
}

impl<'de, 'p, 'a> Visitor<'de> for StreamingSceneNodeVisitor<'p, 'a> {
    type Value = StreamingSceneNode;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a ProseMirror Scene node object")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let parser = self.parser;
        let mut state = StreamingSceneState::new();
        while let Some(key) = map.next_key_seed(StreamingSceneStringSeed {
            parser: &mut *parser,
        })? {
            parser.check().map_err(de::Error::custom)?;
            match key.as_ref() {
                "type" => {
                    state.node_type = map.next_value_seed(StreamingSceneOptionalStringSeed {
                        parser: &mut *parser,
                    })?;
                }
                "text" => {
                    state.text = map.next_value_seed(StreamingSceneOptionalStringSeed {
                        parser: &mut *parser,
                    })?;
                }
                "attrs" => {
                    state.attrs = map.next_value_seed(StreamingSceneAttrsSeed {
                        parser: &mut *parser,
                        depth: self.depth + 1,
                    })?;
                }
                "content" => {
                    state.block_children.clear();
                    state.block_count = 0;
                    state.inline_children.clear();
                    map.next_value_seed(StreamingSceneChildrenSeed {
                        parser: &mut *parser,
                        depth: self.depth + 1,
                        block_children: &mut state.block_children,
                        block_count: &mut state.block_count,
                        inline_children: &mut state.inline_children,
                    })?;
                }
                _ => {
                    map.next_value_seed(StreamingSceneSkipSeed {
                        parser: &mut *parser,
                        depth: self.depth + 1,
                    })?;
                }
            }
        }
        parser.finish_node(state).map_err(de::Error::custom)
    }
}

impl<'de, 'p, 'a> DeserializeSeed<'de> for StreamingSceneNodeSeed<'p, 'a> {
    type Value = StreamingSceneNode;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        self.parser
            .begin_node(self.depth)
            .map_err(de::Error::custom)?;
        deserializer.deserialize_map(StreamingSceneNodeVisitor {
            parser: self.parser,
            depth: self.depth,
        })
    }
}

/// Parse and project one persisted Scene body under the same admission and
/// cancellation boundary used by the Graph reader.
///
/// The caller must perform the SQLite scalar byte-length check before loading
/// the stored value.  `max_input_bytes` is repeated here as a defence against
/// callers that already own a materialized string, while `max_output_bytes`
/// bounds the canonical projection before its result is allocated.  Invalid
/// JSON is unavailable to this path; the legacy unbounded helper below keeps
/// its existing storage fallback for change-feed digests.
#[cfg(test)]
pub(crate) fn canonical_scene_storage_with_check(
    storage: &str,
    max_input_bytes: usize,
    max_output_bytes: usize,
    check: &mut dyn FnMut() -> anyhow::Result<()>,
) -> anyhow::Result<String> {
    canonical_scene_storage_with_admission(
        storage,
        max_input_bytes,
        max_output_bytes,
        check,
        &mut |_| Ok(()),
        &mut |_| Ok(()),
    )
}

/// Parse/project a stored Scene with a bounded streaming visitor. The visitor
/// charges parser scratch and every projected String before allocation, checks
/// cancellation at each node/field/chunk, and never constructs a Value tree.
/// The callbacks are intentionally separate from check so cancellation and
/// resource accounting cannot be reset by a candidate.
pub(crate) fn canonical_scene_storage_with_admission(
    storage: &str,
    max_input_bytes: usize,
    max_output_bytes: usize,
    check: &mut dyn FnMut() -> anyhow::Result<()>,
    admit_parse: &mut dyn FnMut(usize) -> anyhow::Result<()>,
    admit_output: &mut dyn FnMut(usize) -> anyhow::Result<()>,
) -> anyhow::Result<String> {
    check()?;
    anyhow::ensure!(
        storage.len() <= max_input_bytes,
        "NEX_CANONICAL_TEXT_INPUT_LIMIT"
    );
    anyhow::ensure!(
        storage.len() <= CANONICAL_PARSE_INPUT_LIMIT,
        "NEX_CANONICAL_TEXT_PARSE_LIMIT"
    );
    let json_string_reservation = storage
        .len()
        .checked_mul(2)
        .ok_or_else(|| anyhow::anyhow!("NEX_CANONICAL_TEXT_PARSE_LIMIT"))?;
    let mut parser = StreamingSceneParser {
        max_output_bytes,
        json_string_reservation,
        check,
        admit_parse,
        admit_output,
    };
    let mut deserializer = Deserializer::from_str(storage);
    let root = StreamingSceneNodeSeed {
        parser: &mut parser,
        depth: 0,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| anyhow::anyhow!("NEX_CANONICAL_TEXT_INVALID_JSON: {error}"))?;
    deserializer
        .end()
        .map_err(|error| anyhow::anyhow!("NEX_CANONICAL_TEXT_INVALID_JSON: {error}"))?;
    parser.check()?;
    Ok(root.block.text)
}

/// Extracts the canonical plain-text projection of a Scene's ProseMirror
/// `content` storage (block text joined by `\n`, matching the shared
/// TypeScript serializer's golden fixtures). Shared with
/// `source_revision::load_canonical_text_for_revalidation` so Gate C2's
/// lazy-load re-anchoring path stays byte-for-byte consistent with the text
/// impact digests computed here.
pub(crate) fn scene_canonical_text(storage: &str) -> String {
    let Ok(document) = serde_json::from_str::<Value>(storage) else {
        return storage.to_string();
    };
    let mut output = String::new();
    let result: Result<(), std::convert::Infallible> = collect_canonical_blocks(
        &document,
        &mut 0,
        &mut |piece| {
            output.push_str(piece);
            Ok(())
        },
        &mut || Ok(()),
    );
    match result {
        Ok(()) => output,
        Err(never) => match never {},
    }
}

fn sha256_digest(value: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value)))
}

/// Build the complete text-impact contract for a Scene `/content` mutation.
///
/// Native writers currently do not receive ProseMirror step maps from every
/// caller (notably Undo/Redo and external writes). A whole-document mapping is
/// therefore the safe common denominator: it is explicit, versioned, and
/// guarantees C2 will re-evaluate the affected source instead of guessing at
/// stale coordinates.
pub(crate) fn scene_text_impact(
    before: Option<&Value>,
    after: Option<&Value>,
) -> anyhow::Result<Option<Value>> {
    let old_storage = before
        .and_then(|snapshot| snapshot.get("content"))
        .and_then(Value::as_str);
    let new_storage = after
        .and_then(|snapshot| snapshot.get("content"))
        .and_then(Value::as_str);
    let (Some(old_storage), Some(new_storage)) = (old_storage, new_storage) else {
        return Ok(None);
    };
    Ok(Some(json!({
        "unit": "utf16",
        "normalizerVersion": CANONICAL_TEXT_NORMALIZER_VERSION,
        "oldStorageDigest": sha256_digest(old_storage.as_bytes()),
        "newStorageDigest": sha256_digest(new_storage.as_bytes()),
        "oldCanonicalDigest": sha256_digest(scene_canonical_text(old_storage).as_bytes()),
        "newCanonicalDigest": sha256_digest(scene_canonical_text(new_storage).as_bytes()),
        "mapping": {
            "kind": "whole-document",
            "reason": "native-writer-fallback"
        }
    })))
}

fn ensure_event_history_continuity(
    conn: &Connection,
    project_id: &str,
    events: &[NarrativeChangeEventInput],
) -> anyhow::Result<()> {
    let mut heads =
        std::collections::HashMap::<String, Option<(Option<i64>, Option<String>)>>::new();
    let mut mutation_kinds = std::collections::HashMap::<String, String>::new();
    for event in events {
        let identity = crate::canonical_feed_snapshots::object_key_identity(&event.object_key)?;
        let prior_after = match heads.get(&identity) {
            Some(head) => head.clone(),
            None => {
                let head = previous_event_after_state(conn, project_id, &identity)?;
                heads.insert(identity.clone(), head.clone());
                head
            }
        };
        // A project restore starts a new semantic epoch. Its marker is the
        // explicit trigger for C2's full rebuild and intentionally does not
        // need to chain from the immediately preceding project marker: a
        // normal domain write may have occurred between two restores.
        let is_epoch_reset =
            is_epoch_reset_marker_event(&event.object_key, event.structural_impact.as_ref());
        if !is_epoch_reset {
            if let Some(prior_after) = prior_after {
                let current_before = (event.before_version, event.before_digest.clone());
                anyhow::ensure!(
                    prior_after == current_before,
                    "NARRATIVE_CHANGE_FEED_DISCONTINUITY: object {identity} previous after state {:?} does not match current before state {:?}",
                    prior_after,
                    current_before
                );
            }
        }
        // One transaction gets one `canonical_sequence`, and its events are
        // told apart only by `event_ordinal`. The Contribution projection
        // watermarks each row by sequence alone, so of two events at one
        // sequence bearing on the same field, the second is refused -- and
        // the cursor then acknowledges the sequence, making it unreplayable.
        //
        // Today that costs nothing: every writer that repeats an identity
        // inside a transaction emits `update` for all of them, and the
        // projection derives only `missing` (delete) or `modified`
        // (everything else) with a transaction-wide timestamp, so the refused
        // write would have been byte-identical. The one shape that would
        // genuinely lose information is a delete and a non-delete for the
        // same object in the same transaction, and nothing constructs it.
        //
        // That is an invariant the projection depends on, so it is checked
        // here rather than left as a property of the current writers, and the
        // projection keeps its one-dimensional watermark instead of growing a
        // second ordering key that neither the cursor nor `baseline_sequence`
        // would share.
        if let Some(previous_kind) =
            mutation_kinds.insert(identity.clone(), event.mutation_kind.clone())
        {
            anyhow::ensure!(
                (previous_kind == "delete") == (event.mutation_kind == "delete"),
                "NARRATIVE_CHANGE_FEED_MIXED_MUTATION: object {identity} has both '{}' and '{}' \
                 in one transaction; a delete and a non-delete for one object share a canonical \
                 sequence and the Contribution projection can only keep one of them",
                previous_kind,
                event.mutation_kind
            );
        }
        // An Epoch marker's `after` state is synthetic (a reset sentinel,
        // not the Project row), so it must not become the head the next real
        // Project mutation has to chain from: advancing the head here would
        // force that mutation to either report a discontinuity or borrow the
        // synthetic state as its before-evidence.
        if !is_epoch_reset {
            heads.insert(
                identity,
                Some((event.after_version, event.after_digest.clone())),
            );
        }
    }
    Ok(())
}

/// True for the synthetic Project-scoped Epoch markers
/// (`project-restored` / `semantic-epoch-reset`) that are exempt from head
/// continuity and must not advance the durable Project object head.
pub(crate) fn is_epoch_reset_marker_event(
    object_key: &Value,
    structural_impact: Option<&Value>,
) -> bool {
    object_key.get("kind").and_then(Value::as_str) == Some("project")
        && structural_impact
            .and_then(Value::as_object)
            .and_then(|impact| impact.get("event"))
            .and_then(Value::as_str)
            .is_some_and(|event| matches!(event, "project-restored" | "semantic-epoch-reset"))
}

fn validate_digest(value: Option<&str>, name: &str) -> anyhow::Result<()> {
    if let Some(value) = value {
        anyhow::ensure!(
            value.starts_with("sha256:") && value.len() > "sha256:".len(),
            "{name} must be a sha256-prefixed digest"
        );
    }
    Ok(())
}

fn validate_changed_path(path: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !path.is_empty() && path.trim() == path && path.starts_with('/'),
        "changedPaths must use canonical JSON Pointer paths"
    );
    if path == "/" {
        return Ok(());
    }
    let bytes = path.as_bytes();
    let mut index = 1;
    while index < bytes.len() {
        if bytes[index] == b'~' {
            anyhow::ensure!(
                index + 1 < bytes.len() && matches!(bytes[index + 1], b'0' | b'1'),
                "changedPaths contains an invalid JSON Pointer escape"
            );
            index += 1;
        }
        index += 1;
    }
    Ok(())
}

fn normalize_structural_impact(value: &mut Value) -> anyhow::Result<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("structuralImpact must be an object"))?;
    if let Some(event) = object.get("event") {
        anyhow::ensure!(
            matches!(
                event.as_str(),
                Some("semantic-epoch-reset")
                    | Some("project-restored")
                    | Some("schema-component-changed")
            ),
            "structuralImpact.event is unsupported"
        );
        anyhow::ensure!(
            object.get("requiresFullRebuild").and_then(Value::as_bool) == Some(true),
            "structuralImpact epoch markers require requiresFullRebuild=true"
        );
    }
    if let Some(requires_full_rebuild) = object.get("requiresFullRebuild") {
        anyhow::ensure!(
            requires_full_rebuild.is_boolean(),
            "structuralImpact.requiresFullRebuild must be boolean"
        );
    }
    let Some(paths) = object.get_mut("changedPaths") else {
        return Ok(());
    };
    let paths = paths
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("structuralImpact.changedPaths must be an array"))?;
    anyhow::ensure!(
        !paths.is_empty(),
        "structuralImpact.changedPaths must contain at least one path"
    );
    let mut normalized = Vec::with_capacity(paths.len());
    for path in paths.iter() {
        let path = path
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("structuralImpact.changedPaths must contain strings"))?;
        validate_changed_path(path)?;
        normalized.push(path.to_string());
    }
    normalized.sort();
    anyhow::ensure!(
        normalized.windows(2).all(|pair| pair[0] != pair[1]),
        "structuralImpact.changedPaths must not contain duplicates"
    );
    *paths = normalized.into_iter().map(Value::String).collect();
    Ok(())
}

fn validate_utf16_range(value: &Value, field: &str) -> anyhow::Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("{field} must be an object"))?;
    let from = object
        .get("from")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("{field}.from must be a non-negative integer"))?;
    let to = object
        .get("to")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("{field}.to must be a non-negative integer"))?;
    anyhow::ensure!(to >= from, "{field}.to must be >= {field}.from");
    Ok(())
}

fn validate_text_impact(impact: &Value) -> anyhow::Result<()> {
    let object = impact
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("textImpact must be an object"))?;
    anyhow::ensure!(
        object.get("unit").and_then(Value::as_str) == Some("utf16"),
        "textImpact.unit must be 'utf16'"
    );
    require_non_empty(
        object
            .get("normalizerVersion")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("textImpact.normalizerVersion is required"))?,
        "textImpact.normalizerVersion",
    )?;
    for field in [
        "oldStorageDigest",
        "newStorageDigest",
        "oldCanonicalDigest",
        "newCanonicalDigest",
    ] {
        validate_digest(
            Some(
                object
                    .get(field)
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("textImpact.{field} is required"))?,
            ),
            &format!("textImpact.{field}"),
        )?;
    }
    let mapping = object
        .get("mapping")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("textImpact.mapping is required"))?;
    match mapping.get("kind").and_then(Value::as_str) {
        Some("position-map") => {
            let segments = mapping
                .get("segments")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("textImpact.mapping.segments is required"))?;
            for (index, segment) in segments.iter().enumerate() {
                let segment_object = segment.as_object().ok_or_else(|| {
                    anyhow::anyhow!("textImpact.mapping.segments[{index}] must be an object")
                })?;
                validate_utf16_range(
                    segment_object.get("oldRange").ok_or_else(|| {
                        anyhow::anyhow!("textImpact.mapping.segments[{index}].oldRange is required")
                    })?,
                    &format!("textImpact.mapping.segments[{index}].oldRange"),
                )?;
                validate_utf16_range(
                    segment_object.get("newRange").ok_or_else(|| {
                        anyhow::anyhow!("textImpact.mapping.segments[{index}].newRange is required")
                    })?,
                    &format!("textImpact.mapping.segments[{index}].newRange"),
                )?;
                anyhow::ensure!(
                    matches!(
                        segment_object.get("behavior").and_then(Value::as_str),
                        Some("unchanged") | Some("inserted") | Some("deleted") | Some("replaced")
                    ),
                    "textImpact.mapping segment behavior is unsupported"
                );
            }
        }
        Some("canonical-diff") => {
            for field in ["changedOldRanges", "changedNewRanges"] {
                let ranges = mapping
                    .get(field)
                    .and_then(Value::as_array)
                    .ok_or_else(|| anyhow::anyhow!("textImpact.mapping.{field} is required"))?;
                for (index, range) in ranges.iter().enumerate() {
                    validate_utf16_range(range, &format!("textImpact.mapping.{field}[{index}]"))?;
                }
            }
        }
        Some("whole-document") => require_non_empty(
            mapping
                .get("reason")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("textImpact.mapping.reason is required"))?,
            "textImpact.mapping.reason",
        )?,
        _ => anyhow::bail!("textImpact.mapping.kind is unsupported"),
    }
    Ok(())
}

pub(crate) fn validate_event(event: &NarrativeChangeEventInput) -> anyhow::Result<()> {
    let key = event
        .object_key
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("objectKey must be an object"))?;
    let kind = key
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("objectKey.kind is required"))?;
    let required_identity = object_key_identity_field(kind)?;
    require_non_empty(
        key.get(required_identity)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("objectKey.{required_identity} is required"))?,
        &format!("objectKey.{required_identity}"),
    )?;
    if let Some(import_object_key) = key.get("objectKey") {
        anyhow::ensure!(
            kind == "import-source",
            "objectKey.objectKey is only valid for import-source keys"
        );
        require_non_empty(
            import_object_key
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("objectKey.objectKey must be a string"))?,
            "objectKey.objectKey",
        )?;
    }
    anyhow::ensure!(
        CHANGE_KINDS.contains(&event.change_kind.as_str()),
        "unsupported changeKind '{}'",
        event.change_kind
    );
    anyhow::ensure!(
        MUTATION_KINDS.contains(&event.mutation_kind.as_str()),
        "unsupported mutationKind '{}'",
        event.mutation_kind
    );
    let mut changed_paths = std::collections::BTreeSet::new();
    anyhow::ensure!(
        !event.changed_paths.is_empty(),
        "changedPaths must contain at least one path"
    );
    for path in &event.changed_paths {
        validate_changed_path(path)?;
        anyhow::ensure!(
            changed_paths.insert(path),
            "changedPaths must not contain duplicates"
        );
    }
    if let Some(version) = event.before_version {
        anyhow::ensure!(version >= 0, "beforeVersion must not be negative");
    }
    if let Some(version) = event.after_version {
        anyhow::ensure!(version >= 0, "afterVersion must not be negative");
    }
    validate_digest(event.before_digest.as_deref(), "beforeDigest")?;
    validate_digest(event.after_digest.as_deref(), "afterDigest")?;
    if let Some(text_impact) = event.text_impact.as_ref() {
        validate_text_impact(text_impact)?;
    }
    let has_before = event.before_version.is_some() || event.before_digest.is_some();
    let has_after = event.after_version.is_some() || event.after_digest.is_some();
    match event.mutation_kind.as_str() {
        "create" => anyhow::ensure!(
            !has_before && has_after,
            "create events require only an after state"
        ),
        "update" => anyhow::ensure!(
            has_before && has_after,
            "update events require before and after states"
        ),
        "delete" => anyhow::ensure!(
            has_before && !has_after,
            "delete events require only a before state"
        ),
        "restore" => anyhow::ensure!(
            !has_before && has_after,
            "restore events require only an after state"
        ),
        _ => unreachable!("mutation kind was validated above"),
    }
    Ok(())
}

fn ensure_feed_object_project_scope(
    conn: &Connection,
    project_id: &str,
    event: &NarrativeChangeEventInput,
) -> anyhow::Result<()> {
    let project_exists = conn
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        project_exists,
        "Narrative Change Feed project '{project_id}' does not exist"
    );

    let key = event
        .object_key
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("objectKey must be an object"))?;
    let kind = key
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("objectKey.kind is required"))?;
    let identity = |name: &str| -> anyhow::Result<&str> {
        key.get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("objectKey.{name} is required"))
    };
    let lookup = match kind {
        "project" => {
            anyhow::ensure!(
                identity("projectId")? == project_id,
                "Narrative Change Feed project marker belongs to another project"
            );
            None
        }
        "scene" => Some((
            "SELECT project_id FROM tree_nodes WHERE id = ?1",
            identity("sceneId")?,
        )),
        "scene-scope" => Some((
            "SELECT project_id FROM tree_nodes
              WHERE id = ?1 AND node_type = 'scene'",
            identity("sceneId")?,
        )),
        "scope-registry" => {
            anyhow::ensure!(
                identity("projectId")? == project_id,
                "Narrative Change Feed scope registry belongs to another project"
            );
            None
        }
        "chronicle-event" => Some((
            "SELECT project_id FROM events WHERE id = ?1",
            identity("eventId")?,
        )),
        "codex-entry" => Some((
            "SELECT project_id FROM codex_entries WHERE id = ?1",
            identity("entryId")?,
        )),
        "codex-relation" => Some((
            "SELECT project_id FROM codex_relations WHERE id = ?1",
            identity("relationId")?,
        )),
        "codex-phase" => Some((
            "SELECT entry.project_id
               FROM codex_entry_phases phase
               JOIN codex_entries entry ON entry.id = phase.entry_id
              WHERE phase.id = ?1",
            identity("phaseId")?,
        )),
        "codex-detail-definition" => Some((
            "SELECT project_id FROM codex_detail_definitions WHERE id = ?1",
            identity("definitionId")?,
        )),
        "codex-detail-value" => Some((
            "SELECT entry.project_id
               FROM codex_detail_values value
               JOIN codex_entries entry ON entry.id = value.entry_id
              WHERE value.id = ?1",
            identity("valueId")?,
        )),
        "plot-thread" => Some((
            "SELECT project_id FROM plot_threads WHERE id = ?1",
            identity("threadId")?,
        )),
        "plot-marker" => Some((
            "SELECT thread.project_id
               FROM plot_thread_scene_links marker
               JOIN plot_threads thread ON thread.id = marker.thread_id
              WHERE marker.id = ?1",
            identity("markerId")?,
        )),
        "plot-branch" => Some((
            "SELECT project_id FROM plot_thread_branches WHERE id = ?1",
            identity("branchId")?,
        )),
        "foreshadow" => Some((
            "SELECT project_id FROM foreshadows WHERE id = ?1",
            identity("foreshadowId")?,
        )),
        "foreshadow-setup" => Some((
            "SELECT foreshadow.project_id
               FROM foreshadow_setups setup
               JOIN foreshadows foreshadow ON foreshadow.id = setup.foreshadow_id
              WHERE setup.id = ?1",
            identity("setupId")?,
        )),
        "foreshadow-payoff" => Some((
            "SELECT foreshadow.project_id
               FROM foreshadow_payoffs payoff
               JOIN foreshadows foreshadow ON foreshadow.id = payoff.foreshadow_id
              WHERE payoff.id = ?1",
            identity("payoffId")?,
        )),
        "temporal-node" => Some((
            "SELECT project_id FROM narrative_temporal_nodes WHERE id = ?1",
            identity("nodeId")?,
        )),
        "temporal-constraint" => Some((
            "SELECT project_id FROM narrative_temporal_constraints WHERE id = ?1",
            identity("constraintId")?,
        )),
        "temporal-projection" => Some((
            "SELECT project_id FROM narrative_temporal_projections WHERE id = ?1",
            identity("projectionId")?,
        )),
        "calendar" => {
            anyhow::ensure!(
                identity("calendarRef")? == project_id,
                "Narrative Change Feed calendar belongs to another project"
            );
            None
        }
        "import-source" => {
            let source_set_id = identity("sourceSetId")?;
            let object_project_id = identity("objectKey")?;
            anyhow::ensure!(
                object_project_id == project_id,
                "Narrative Change Feed import target belongs to another project"
            );
            let target_json = conn
                .query_row(
                    "SELECT target_json FROM import_sessions WHERE id = ?1",
                    [source_set_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Narrative Change Feed import source '{source_set_id}' does not exist"
                    )
                })?;
            let target: Value = serde_json::from_str(&target_json).map_err(|error| {
                anyhow::anyhow!("import session target_json is invalid: {error}")
            })?;
            anyhow::ensure!(
                target.get("projectId").and_then(Value::as_str) == Some(project_id),
                "Narrative Change Feed import source belongs to another project"
            );
            None
        }
        "component" => {
            ensure_component_project_scope(
                conn,
                project_id,
                identity("componentId")?,
                &event.mutation_kind,
            )?;
            None
        }
        other => anyhow::bail!("unsupported objectKey.kind '{other}'"),
    };
    if let Some((sql, object_id)) = lookup {
        let owner = conn
            .query_row(sql, [object_id], |row| row.get::<_, String>(0))
            .optional()?;
        if let Some(owner) = owner {
            anyhow::ensure!(
                owner == project_id,
                "Narrative Change Feed object belongs to another project"
            );
        } else {
            // Typed delete writers prove ownership before removing the row in
            // this same transaction. Every other mutation must leave a live
            // project-owned row for the common Feed layer to verify.
            anyhow::ensure!(
                event.mutation_kind == "delete",
                "Narrative Change Feed object {} is not in project '{project_id}'",
                event.object_key
            );
        }
    }
    Ok(())
}

fn component_owner(
    conn: &Connection,
    sql: &str,
    component_id: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(sql, [component_id], |row| row.get::<_, String>(0))
        .optional()
        .map_err(Into::into)
}

fn ensure_component_project_scope(
    conn: &Connection,
    project_id: &str,
    component_id: &str,
    mutation_kind: &str,
) -> anyhow::Result<()> {
    let (component_kind, persisted_id) = component_id
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("componentId must contain a registered kind prefix"))?;
    require_non_empty(persisted_id, "componentId persisted identity")?;

    let owner = match component_kind {
        "tree-node" | "tree_node" | "note" | "map-note" => component_owner(
            conn,
            "SELECT project_id FROM tree_nodes WHERE id = ?1",
            persisted_id,
        )?,
        "snippet" | "map-snippet" => component_owner(
            conn,
            "SELECT project_id FROM snippets WHERE id = ?1",
            persisted_id,
        )?,
        "codex-detail-definition" => component_owner(
            conn,
            "SELECT project_id FROM codex_detail_definitions WHERE id = ?1",
            persisted_id,
        )?,
        "codex-tag" => component_owner(
            conn,
            "SELECT project_id FROM codex_tags WHERE id = ?1",
            persisted_id,
        )?,
        "codex-type" => component_owner(
            conn,
            "SELECT project_id FROM codex_types WHERE id = ?1",
            persisted_id,
        )?,
        "codex-detail-value" => {
            let (entry_id, definition_id) = persisted_id.split_once(':').ok_or_else(|| {
                anyhow::anyhow!(
                    "codex-detail-value componentId requires entry and definition identities"
                )
            })?;
            require_non_empty(entry_id, "codex-detail-value entry identity")?;
            require_non_empty(definition_id, "codex-detail-value definition identity")?;
            conn.query_row(
                "SELECT entry.project_id
                   FROM codex_detail_values value
                   JOIN codex_entries entry ON entry.id = value.entry_id
                   JOIN codex_detail_definitions definition
                     ON definition.id = value.definition_id
                  WHERE value.entry_id = ?1 AND value.definition_id = ?2
                    AND definition.project_id = entry.project_id",
                params![entry_id, definition_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        }
        "codex-entry-tag" => {
            let (entry_id, tag_id) = persisted_id.split_once(':').ok_or_else(|| {
                anyhow::anyhow!("codex-entry-tag componentId requires entry and tag identities")
            })?;
            require_non_empty(entry_id, "codex-entry-tag entry identity")?;
            require_non_empty(tag_id, "codex-entry-tag tag identity")?;
            conn.query_row(
                "SELECT entry.project_id
                   FROM codex_entry_tags association
                   JOIN codex_entries entry ON entry.id = association.entry_id
                   JOIN codex_tags tag ON tag.id = association.tag_id
                  WHERE association.entry_id = ?1
                    AND association.tag_id = ?2
                    AND tag.project_id = entry.project_id",
                params![entry_id, tag_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        }
        "codex_semantic_binding" => component_owner(
            conn,
            "SELECT project_id FROM codex_detail_semantic_bindings WHERE id = ?1",
            persisted_id,
        )?,
        "map-board" => component_owner(
            conn,
            "SELECT project_id FROM map_boards WHERE id = ?1",
            persisted_id,
        )?,
        "editor-sticky" => component_owner(
            conn,
            "SELECT project_id FROM editor_stickies WHERE id = ?1",
            persisted_id,
        )?,
        "map-ai-branch" => component_owner(
            conn,
            "SELECT board.project_id
               FROM map_ai_branches branch
               JOIN map_boards board ON board.id = branch.board_id
              WHERE branch.id = ?1",
            persisted_id,
        )?,
        "map-sticky" | "map_sticky" => component_owner(
            conn,
            "SELECT board.project_id
               FROM map_stickies sticky
               JOIN map_boards board ON board.id = sticky.board_id
              WHERE sticky.id = ?1",
            persisted_id,
        )?,
        "map-frame" => component_owner(
            conn,
            "SELECT board.project_id
               FROM map_frames frame
               JOIN map_boards board ON board.id = frame.board_id
              WHERE frame.id = ?1",
            persisted_id,
        )?,
        "map-position" => component_owner(
            conn,
            "SELECT board.project_id
               FROM map_node_positions position
               JOIN map_boards board ON board.id = position.board_id
              WHERE position.id = ?1",
            persisted_id,
        )?,
        "map-edge" => component_owner(
            conn,
            "SELECT board.project_id
               FROM map_edges edge
               JOIN map_boards board ON board.id = edge.board_id
              WHERE edge.id = ?1",
            persisted_id,
        )?,
        "temporal_node" => component_owner(
            conn,
            "SELECT project_id FROM narrative_temporal_nodes WHERE id = ?1",
            persisted_id,
        )?,
        "temporal_constraint" => component_owner(
            conn,
            "SELECT project_id FROM narrative_temporal_constraints WHERE id = ?1",
            persisted_id,
        )?,
        "temporal_projection" => component_owner(
            conn,
            "SELECT project_id FROM narrative_temporal_projections WHERE id = ?1",
            persisted_id,
        )?,
        "plot_thread_marker" => component_owner(
            conn,
            "SELECT thread.project_id
               FROM plot_thread_scene_links marker
               JOIN plot_threads thread ON thread.id = marker.thread_id
              WHERE marker.id = ?1",
            persisted_id,
        )?,
        "plot_thread_branch" => component_owner(
            conn,
            "SELECT project_id FROM plot_thread_branches WHERE id = ?1",
            persisted_id,
        )?,
        "label" => component_owner(
            conn,
            "SELECT project_id FROM labels WHERE id = ?1",
            persisted_id,
        )?,
        "lint-term" => component_owner(
            conn,
            "SELECT project_id FROM lint_term_dictionary WHERE id = ?1",
            persisted_id,
        )?,
        "generation-log" => component_owner(
            conn,
            "SELECT project_id FROM generation_logs WHERE id = ?1",
            persisted_id,
        )?,
        "post-effect-relation" => component_owner(
            conn,
            "SELECT project_id FROM post_effect_annotation_relations WHERE id = ?1",
            persisted_id,
        )?,
        "authorship-span" => component_owner(
            conn,
            "SELECT COALESCE(
                        tree.project_id,
                        entry.project_id,
                        snippet.project_id,
                        detail_entry.project_id,
                        board.project_id
                    )
               FROM authorship_spans span
               LEFT JOIN tree_nodes tree ON tree.id = span.node_id
               LEFT JOIN codex_entries entry ON entry.id = span.codex_entry_id
               LEFT JOIN snippets snippet ON snippet.id = span.snippet_id
               LEFT JOIN codex_detail_values detail ON detail.id = span.detail_value_id
               LEFT JOIN codex_entries detail_entry ON detail_entry.id = detail.entry_id
               LEFT JOIN map_stickies sticky ON sticky.id = span.sticky_id
               LEFT JOIN map_boards board ON board.id = sticky.board_id
              WHERE span.id = ?1",
            persisted_id,
        )?,
        "project-snapshot" => {
            let (snapshot_id, scope) = persisted_id.split_once(':').ok_or_else(|| {
                anyhow::anyhow!("project-snapshot componentId requires snapshot id and scope")
            })?;
            anyhow::ensure!(
                matches!(
                    scope,
                    "body" | "codex" | "foreshadow" | "snippet" | "map" | "labels" | "lint"
                ),
                "project-snapshot componentId has unsupported scope '{scope}'"
            );
            component_owner(
                conn,
                "SELECT project_id FROM project_snapshots WHERE id = ?1",
                snapshot_id,
            )?
        }
        other => anyhow::bail!(
            "componentId kind '{other}' is not registered for Native Change Feed authority"
        ),
    };

    if let Some(owner) = owner {
        anyhow::ensure!(
            owner == project_id,
            "Narrative Change Feed component belongs to another project"
        );
    } else {
        anyhow::ensure!(
            mutation_kind == "delete" && event_may_reference_deleted_component(component_kind),
            "Narrative Change Feed component '{component_id}' is not in project '{project_id}'"
        );
    }
    Ok(())
}

fn event_may_reference_deleted_component(component_kind: &str) -> bool {
    // Delete events are appended after the row mutation, so the common Feed
    // layer cannot re-read their owner. Each registered typed writer validates
    // ownership before deleting and shares this same SQLite transaction.
    matches!(
        component_kind,
        "tree-node"
            | "tree_node"
            | "snippet"
            | "codex-detail-definition"
            | "codex-tag"
            | "codex-type"
            | "codex-detail-value"
            | "codex-entry-tag"
            | "codex_semantic_binding"
            | "label"
            | "editor-sticky"
            | "lint-term"
            | "generation-log"
            | "post-effect-relation"
            | "authorship-span"
            | "map-board"
            | "map-ai-branch"
            | "map-sticky"
            | "map_sticky"
            | "map-frame"
            | "map-position"
            | "map-edge"
            | "temporal_node"
            | "temporal_constraint"
            | "temporal_projection"
            | "plot_thread_marker"
            | "plot_thread_branch"
    )
}

fn ensure_project_scoped_reference(
    conn: &Connection,
    table: &str,
    id_column: &str,
    id: &str,
    project_id: &str,
    label: &str,
) -> anyhow::Result<()> {
    // All identifiers are static literals owned by this module.
    let sql = format!("SELECT 1 FROM {table} WHERE {id_column} = ?1 AND project_id = ?2 LIMIT 1");
    let exists = conn
        .query_row(&sql, params![id, project_id], |row| row.get::<_, i64>(0))
        .optional()?
        .is_some();
    anyhow::ensure!(exists, "{label} is not in project '{project_id}'");
    Ok(())
}

fn existing_result(
    conn: &Connection,
    project_id: &str,
    source_domain: &str,
    request_id: &str,
    expected_digest: &str,
    expected_source_event_uid: &str,
) -> anyhow::Result<Option<AppendNarrativeChangeTransactionResult>> {
    let row: Option<(String, String, String, i64)> = conn
        .query_row(
            "SELECT id, payload_digest, source_change_event_uid,
                    source_change_event_sequence
               FROM narrative_change_transactions
              WHERE project_id = ?1
                AND source_domain = ?2
                AND request_id = ?3",
            params![project_id, source_domain, request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((transaction_id, digest, source_event_uid, sequence)) = row else {
        return Ok(None);
    };
    anyhow::ensure!(
        digest == expected_digest && source_event_uid == expected_source_event_uid,
        "NARRATIVE_CHANGE_FEED_IDEMPOTENCY_CONFLICT: request id reused with different payload"
    );
    let event_ids = {
        let mut statement = conn.prepare(
            "SELECT id
               FROM narrative_change_events
              WHERE project_id = ?1 AND transaction_id = ?2
              ORDER BY event_ordinal",
        )?;
        let event_ids = statement
            .query_map(params![project_id, transaction_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        event_ids
    };
    Ok(Some(AppendNarrativeChangeTransactionResult {
        transaction_id,
        canonical_sequence: sequence,
        event_ids,
        replayed: true,
    }))
}

fn validate_existing_canonical_event(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    event: &AppendChangeEvent,
) -> anyhow::Result<()> {
    let existing = conn
        .query_row(
            "SELECT scene_id, domain, op_type, entity_type, entity_id,
                    payload, session_id, timestamp
               FROM change_events
              WHERE project_id = ?1 AND event_uid = ?2",
            params![project_id, event.event_uid],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((
        stored_scene_id,
        stored_domain,
        stored_op_type,
        stored_entity_type,
        stored_entity_id,
        stored_payload,
        stored_session_id,
        stored_timestamp,
    )) = existing
    else {
        return Ok(());
    };

    let expected_scene_id = match event.scene_id.as_deref() {
        Some(scene_id) => conn
            .query_row(
                "SELECT id FROM tree_nodes WHERE id = ?1 LIMIT 1",
                [scene_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?,
        None => None,
    };
    anyhow::ensure!(
        stored_scene_id == expected_scene_id
            && stored_domain == event.domain
            && stored_op_type == event.op_type
            && stored_entity_type == event.entity_type
            && stored_entity_id == event.entity_id
            && stored_payload == event.payload
            && stored_session_id == session_id
            && stored_timestamp == event.timestamp,
        "NARRATIVE_CHANGE_FEED_CANONICAL_CONFLICT: event uid reused with different canonical payload"
    );
    Ok(())
}

/// Append the audit Change Event and its freshness Feed transaction as one
/// caller-owned SQLite transaction. This is the only bridge between the two
/// ledgers: `change_events` stays authoritative for audit/Undo, while the Feed
/// records typed invalidation facts.
pub fn append_canonical_and_narrative_change_in_tx(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    canonical_event: &AppendChangeEvent,
    narrative_input: &AppendNarrativeChangeTransactionInput,
) -> anyhow::Result<AppendCanonicalNarrativeChangeResult> {
    let canonical_event = crate::change_events::annotate_authority_event(canonical_event);
    anyhow::ensure!(
        !conn.is_autocommit(),
        "canonical Change Event + Narrative Change Feed append requires a caller-owned transaction"
    );
    require_non_empty(project_id, "projectId")?;
    require_non_empty(session_id, "sessionId")?;
    anyhow::ensure!(
        narrative_input.project_id == project_id,
        "Narrative Change Feed project does not match canonical Change Event project"
    );
    anyhow::ensure!(
        narrative_input.source_change_event_uid == canonical_event.event_uid,
        "Narrative Change Feed source event does not match canonical Change Event uid"
    );
    anyhow::ensure!(
        narrative_input.source_domain == canonical_event.op_type,
        "Narrative Change Feed sourceDomain does not match canonical Change Event operation"
    );
    if let Some(scene_id) = canonical_event.scene_id.as_deref() {
        let owner = conn
            .query_row(
                "SELECT project_id FROM tree_nodes WHERE id = ?1",
                [scene_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(owner) = owner {
            anyhow::ensure!(
                owner == project_id,
                "canonical Change Event scene belongs to another project"
            );
        }
    }

    validate_existing_canonical_event(conn, project_id, session_id, &canonical_event)?;
    let canonical = append_change_events_in_tx(
        conn,
        project_id,
        session_id,
        std::slice::from_ref(&canonical_event),
    )?;
    let narrative = append_narrative_change_transaction_in_tx(conn, narrative_input)?;
    Ok(AppendCanonicalNarrativeChangeResult {
        canonical,
        narrative,
    })
}

/// Append a project-scoped feed transaction inside the caller's existing
/// SQLite transaction. This function never opens or commits a transaction.
pub fn append_narrative_change_transaction_in_tx(
    conn: &Connection,
    input: &AppendNarrativeChangeTransactionInput,
) -> anyhow::Result<AppendNarrativeChangeTransactionResult> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed append requires a caller-owned transaction"
    );
    let mut normalized_input = input.clone();
    for event in &mut normalized_input.events {
        validate_event(event)?;
        event.changed_paths.sort();
        if let Some(structural_impact) = event.structural_impact.as_mut() {
            normalize_structural_impact(structural_impact)?;
        }
    }
    let input = normalized_input;

    require_non_empty(&input.project_id, "projectId")?;
    require_non_empty(&input.request_id, "requestId")?;
    require_non_empty(&input.source_domain, "sourceDomain")?;
    require_non_empty(&input.source_change_event_uid, "sourceChangeEventUid")?;
    require_non_empty(&input.occurred_at, "occurredAt")?;
    anyhow::ensure!(
        !input.events.is_empty(),
        "Narrative Change Feed transaction requires at least one event"
    );
    for event in &input.events {
        ensure_feed_object_project_scope(conn, &input.project_id, event)?;
    }

    let mut unique_application_ids = std::collections::BTreeSet::new();
    for application_id in &input.application_ids {
        require_non_empty(application_id, "applicationId")?;
        anyhow::ensure!(
            unique_application_ids.insert(application_id.as_str()),
            "applicationIds must be unique"
        );
    }

    let (canonical_sequence, canonical_operation): (i64, String) = conn
        .query_row(
            "SELECT sequence, op_type
               FROM change_events
              WHERE project_id = ?1 AND event_uid = ?2",
            params![input.project_id, input.source_change_event_uid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "canonical Change Event '{}' is not in project '{}'",
                input.source_change_event_uid,
                input.project_id
            )
        })?;
    anyhow::ensure!(
        canonical_operation == input.source_domain,
        "canonical Change Event operation '{}' does not match sourceDomain '{}'",
        canonical_operation,
        input.source_domain
    );

    match (input.cause_kind, input.origin) {
        (NarrativeChangeCauseKind::Forward, NarrativeChangeOrigin::Undo)
        | (NarrativeChangeCauseKind::Forward, NarrativeChangeOrigin::Redo) => {
            anyhow::bail!("forward Change Feed transaction cannot use undo/redo origin")
        }
        (NarrativeChangeCauseKind::Forward, _) => anyhow::ensure!(
            input.original_transaction_id.is_none(),
            "forward Change Feed transaction must not name an original transaction"
        ),
        (NarrativeChangeCauseKind::Undo, NarrativeChangeOrigin::Undo)
        | (NarrativeChangeCauseKind::Redo, NarrativeChangeOrigin::Redo) => anyhow::ensure!(
            input.original_transaction_id.is_some(),
            "undo/redo Change Feed transaction requires the original transaction"
        ),
        (NarrativeChangeCauseKind::Undo, _) => {
            anyhow::bail!("undo Change Feed transaction requires origin 'undo'")
        }
        (NarrativeChangeCauseKind::Redo, _) => {
            anyhow::bail!("redo Change Feed transaction requires origin 'redo'")
        }
    }

    if let Some(original_transaction_id) = input.original_transaction_id.as_deref() {
        ensure_project_scoped_reference(
            conn,
            "narrative_change_transactions",
            "id",
            original_transaction_id,
            &input.project_id,
            "original transaction",
        )?;
        let (original_cause, original_commit_id, original_journal_id, original_undo_journal_id): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn.query_row(
            "SELECT cause_kind, commit_id, journal_id, undo_journal_id
               FROM narrative_change_transactions
              WHERE project_id = ?1 AND id = ?2",
            params![input.project_id, original_transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let lineage_root_transaction_id = if original_cause == "forward" {
            original_transaction_id.to_string()
        } else {
            anyhow::ensure!(
                matches!(original_cause.as_str(), "undo" | "redo"),
                "original transaction must identify a forward or typed inverse mutation"
            );
            let root_id = conn
                .query_row(
                    "SELECT original_transaction_id
                       FROM narrative_change_transactions
                      WHERE project_id = ?1 AND id = ?2",
                    params![input.project_id, original_transaction_id],
                    |row| row.get::<_, Option<String>>(0),
                )?
                .ok_or_else(|| {
                    anyhow::anyhow!("typed inverse transaction has no root forward lineage")
                })?;
            let root_cause: String = conn.query_row(
                "SELECT cause_kind FROM narrative_change_transactions
                  WHERE project_id = ?1 AND id = ?2",
                params![input.project_id, root_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                root_cause == "forward",
                "typed inverse transaction does not identify a root forward mutation"
            );
            root_id
        };
        anyhow::ensure!(
            original_commit_id == input.commit_id,
            "original transaction does not belong to the named commit"
        );
        anyhow::ensure!(
            original_journal_id == input.journal_id,
            "original transaction does not belong to the named journal"
        );
        // A typed inverse mutation can own a new Undo Journal (create ->
        // delete is the common case). It is not a journal replay: prove that
        // both canonical events identify the same domain entity and that the
        // new journal was written by the current canonical event. Otherwise
        // journal replay retains strict journal equality.
        let current_inverse_journal = match (input.cause_kind, input.undo_journal_id.as_deref()) {
            (NarrativeChangeCauseKind::Undo | NarrativeChangeCauseKind::Redo, Some(journal_id))
                if original_undo_journal_id.as_deref() != Some(journal_id) =>
            {
                conn.query_row(
                    "SELECT 1
                       FROM undo_journal journal
                       JOIN change_events inverse_event
                         ON inverse_event.project_id = journal.project_id
                        AND inverse_event.event_uid = journal.change_event_uid
                       LEFT JOIN narrative_change_transactions inverse_transaction
                         ON inverse_transaction.project_id = journal.project_id
                        AND inverse_transaction.source_change_event_uid = journal.change_event_uid
                       JOIN narrative_change_transactions original
                         ON original.project_id = ?2 AND original.id = ?4
                       JOIN change_events original_event
                         ON original_event.project_id = original.project_id
                        AND original_event.event_uid = original.source_change_event_uid
                       JOIN change_events current_event
                         ON current_event.project_id = journal.project_id
                        AND current_event.event_uid = ?3
                      WHERE journal.id = ?1
                        AND journal.project_id = ?2
                        AND original.cause_kind = 'forward'
                        AND (
                            journal.change_event_uid = ?3
                            OR (
                                inverse_transaction.cause_kind IN ('undo','redo')
                                AND inverse_transaction.original_transaction_id = original.id
                            )
                        )
                        AND inverse_event.domain = original_event.domain
                        AND inverse_event.entity_type IS original_event.entity_type
                        AND inverse_event.entity_id IS original_event.entity_id
                        AND current_event.domain = original_event.domain
                        AND current_event.entity_type IS original_event.entity_type
                        AND current_event.entity_id IS original_event.entity_id",
                    params![
                        journal_id,
                        input.project_id,
                        input.source_change_event_uid,
                        lineage_root_transaction_id
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some()
            }
            _ => false,
        };
        anyhow::ensure!(
            original_undo_journal_id == input.undo_journal_id || current_inverse_journal,
            "original transaction does not belong to the named Undo journal"
        );
    }
    if let Some(commit_id) = input.commit_id.as_deref() {
        ensure_project_scoped_reference(
            conn,
            "narrative_apply_commits",
            "id",
            commit_id,
            &input.project_id,
            "commit",
        )?;
    }
    if let Some(journal_id) = input.journal_id.as_deref() {
        ensure_project_scoped_reference(
            conn,
            "narrative_commit_journals",
            "id",
            journal_id,
            &input.project_id,
            "journal",
        )?;
    }
    if let Some(undo_journal_id) = input.undo_journal_id.as_deref() {
        ensure_project_scoped_reference(
            conn,
            "undo_journal",
            "id",
            undo_journal_id,
            &input.project_id,
            "Undo journal",
        )?;
    }
    if let (Some(commit_id), Some(journal_id)) =
        (input.commit_id.as_deref(), input.journal_id.as_deref())
    {
        let matches_commit = conn
            .query_row(
                "SELECT 1
                   FROM narrative_commit_journals
                  WHERE id = ?1 AND commit_id = ?2 AND project_id = ?3",
                params![journal_id, commit_id, input.project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            matches_commit,
            "journal does not belong to the named commit"
        );
    }
    anyhow::ensure!(
        input.application_ids.is_empty() || input.commit_id.is_some(),
        "applicationIds require a commitId"
    );
    for application_id in &input.application_ids {
        let belongs_to_commit = conn
            .query_row(
                "SELECT 1
                   FROM narrative_proposal_applications a
                   INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
                  WHERE a.id = ?1
                    AND c.id = ?2
                    AND c.project_id = ?3",
                params![application_id, input.commit_id, input.project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            belongs_to_commit,
            "application '{application_id}' does not belong to the named project commit"
        );
    }

    let digest = payload_digest(&input)?;
    if let Some(existing) = existing_result(
        conn,
        &input.project_id,
        &input.source_domain,
        &input.request_id,
        &digest,
        &input.source_change_event_uid,
    )? {
        return Ok(existing);
    }

    ensure_event_history_continuity(conn, &input.project_id, &input.events)?;

    let transaction_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_change_transactions (
            id, project_id, request_id, source_domain,
            source_change_event_uid, source_change_event_sequence, cause_kind,
            origin, original_transaction_id, commit_id, journal_id,
            undo_journal_id, application_ids_json, payload_digest, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            transaction_id,
            input.project_id,
            input.request_id,
            input.source_domain,
            input.source_change_event_uid,
            canonical_sequence,
            input.cause_kind.as_str(),
            input.origin.as_str(),
            input.original_transaction_id,
            input.commit_id,
            input.journal_id,
            input.undo_journal_id,
            serde_json::to_string(
                &unique_application_ids
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
            )?,
            digest,
            input.occurred_at,
        ],
    )?;

    let mut event_ids = Vec::with_capacity(input.events.len());
    for (ordinal, event) in input.events.iter().enumerate() {
        let event_id = Uuid::new_v4().to_string();
        let identity = crate::canonical_feed_snapshots::object_key_identity(&event.object_key)?;
        conn.execute(
            "INSERT INTO narrative_change_events (
                id, project_id, transaction_id, canonical_change_event_uid,
                canonical_sequence, event_ordinal, object_key_json, change_kind,
                mutation_kind, before_version, before_digest, after_version,
                after_digest, changed_paths_json, text_impact_json,
                structural_impact_json, occurred_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17)",
            params![
                event_id,
                input.project_id,
                transaction_id,
                input.source_change_event_uid,
                canonical_sequence,
                i64::try_from(ordinal)?,
                serde_json::to_string(&event.object_key)?,
                event.change_kind,
                event.mutation_kind,
                event.before_version,
                event.before_digest,
                event.after_version,
                event.after_digest,
                serde_json::to_string(&event.changed_paths)?,
                event
                    .text_impact
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                event
                    .structural_impact
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                input.occurred_at,
            ],
        )?;
        // Epoch markers keep their own identity in the Feed but never
        // advance the durable Project object head: their after state is a
        // synthetic reset sentinel, not the canonical Project row.
        if !is_epoch_reset_marker_event(&event.object_key, event.structural_impact.as_ref()) {
            upsert_object_head(
                conn,
                NarrativeChangeObjectHead {
                    project_id: &input.project_id,
                    identity: &identity,
                    after_version: event.after_version,
                    after_digest: event.after_digest.as_deref(),
                    event_id: &event_id,
                    canonical_sequence,
                    event_ordinal: i64::try_from(ordinal)?,
                    occurred_at: &input.occurred_at,
                },
            )?;
        }
        event_ids.push(event_id);
    }

    super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, &input.project_id)?;
    Ok(AppendNarrativeChangeTransactionResult {
        transaction_id,
        canonical_sequence,
        event_ids,
        replayed: false,
    })
}

pub fn transaction_id_for_source_event(
    conn: &Connection,
    project_id: &str,
    change_event_uid: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "SELECT id
           FROM narrative_change_transactions
          WHERE project_id = ?1 AND source_change_event_uid = ?2",
        params![project_id, change_event_uid],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

pub fn application_ids_for_commit(
    conn: &Connection,
    project_id: &str,
    commit_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT a.id
           FROM narrative_proposal_applications a
           INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
          WHERE c.project_id = ?1 AND c.id = ?2
          ORDER BY a.id",
    )?;
    let application_ids = statement
        .query_map(params![project_id, commit_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(anyhow::Error::from)?;
    Ok(application_ids)
}

fn parse_json<T: serde::de::DeserializeOwned>(raw: String, field: &str) -> anyhow::Result<T> {
    serde_json::from_str(&raw).map_err(|error| anyhow::anyhow!("invalid {field}: {error}"))
}

fn cause_from_str(value: &str) -> anyhow::Result<NarrativeChangeCauseKind> {
    match value {
        "forward" => Ok(NarrativeChangeCauseKind::Forward),
        "undo" => Ok(NarrativeChangeCauseKind::Undo),
        "redo" => Ok(NarrativeChangeCauseKind::Redo),
        other => anyhow::bail!("invalid persisted cause_kind '{other}'"),
    }
}

fn origin_from_str(value: &str) -> anyhow::Result<NarrativeChangeOrigin> {
    match value {
        "human" => Ok(NarrativeChangeOrigin::Human),
        "ai-apply" => Ok(NarrativeChangeOrigin::AiApply),
        "import" => Ok(NarrativeChangeOrigin::Import),
        "undo" => Ok(NarrativeChangeOrigin::Undo),
        "redo" => Ok(NarrativeChangeOrigin::Redo),
        "restore" => Ok(NarrativeChangeOrigin::Restore),
        "migration" => Ok(NarrativeChangeOrigin::Migration),
        other => anyhow::bail!("invalid persisted origin '{other}'"),
    }
}

pub fn get_changes_since(
    conn: &Connection,
    project_id: &str,
    after_sequence: i64,
    limit: i64,
) -> anyhow::Result<Vec<NarrativeChangeEventRecord>> {
    require_non_empty(project_id, "projectId")?;
    anyhow::ensure!(after_sequence >= 0, "afterSequence must not be negative");
    anyhow::ensure!(
        (1..=MAX_READ_LIMIT).contains(&limit),
        "limit must be between 1 and {MAX_READ_LIMIT}"
    );
    let mut statement = conn.prepare(
        "SELECT e.id, e.project_id, e.transaction_id,
                e.canonical_change_event_uid, e.canonical_sequence,
                e.event_ordinal, e.object_key_json, e.change_kind,
                e.mutation_kind, e.before_version, e.before_digest,
                e.after_version, e.after_digest, e.changed_paths_json,
                e.text_impact_json, e.structural_impact_json,
                t.cause_kind, t.origin, t.original_transaction_id, t.commit_id,
                t.journal_id, t.undo_journal_id, t.application_ids_json,
                e.occurred_at
           FROM narrative_change_events e
           INNER JOIN narrative_change_transactions t
             ON t.project_id = e.project_id AND t.id = e.transaction_id
          WHERE e.project_id = ?1
            AND e.canonical_sequence IN (
              SELECT page.canonical_sequence
                FROM narrative_change_events page
               WHERE page.project_id = ?1
                 AND page.canonical_sequence > ?2
               GROUP BY page.canonical_sequence
               ORDER BY page.canonical_sequence
               LIMIT ?3
            )
          ORDER BY e.canonical_sequence, e.event_ordinal, e.id
        ",
    )?;
    let rows = statement
        .query_map(params![project_id, after_sequence, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, String>(16)?,
                row.get::<_, String>(17)?,
                row.get::<_, Option<String>>(18)?,
                row.get::<_, Option<String>>(19)?,
                row.get::<_, Option<String>>(20)?,
                row.get::<_, Option<String>>(21)?,
                row.get::<_, String>(22)?,
                row.get::<_, String>(23)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    rows.into_iter()
        .map(
            |(
                event_id,
                project_id,
                transaction_id,
                canonical_change_event_uid,
                canonical_sequence,
                event_ordinal,
                object_key_json,
                change_kind,
                mutation_kind,
                before_version,
                before_digest,
                after_version,
                after_digest,
                changed_paths_json,
                text_impact_json,
                structural_impact_json,
                cause_kind,
                origin,
                original_transaction_id,
                commit_id,
                journal_id,
                undo_journal_id,
                application_ids_json,
                occurred_at,
            )| {
                Ok(NarrativeChangeEventRecord {
                    event_id,
                    project_id,
                    transaction_id,
                    canonical_change_event_uid,
                    canonical_sequence,
                    event_ordinal,
                    object_key: parse_json(object_key_json, "object_key_json")?,
                    change_kind,
                    mutation_kind,
                    before_version,
                    before_digest,
                    after_version,
                    after_digest,
                    changed_paths: parse_json(changed_paths_json, "changed_paths_json")?,
                    text_impact: text_impact_json
                        .map(|raw| parse_json(raw, "text_impact_json"))
                        .transpose()?,
                    structural_impact: structural_impact_json
                        .map(|raw| parse_json(raw, "structural_impact_json"))
                        .transpose()?,
                    cause_kind: cause_from_str(&cause_kind)?,
                    origin: origin_from_str(&origin)?,
                    original_transaction_id,
                    commit_id,
                    journal_id,
                    undo_journal_id,
                    application_ids: parse_json(application_ids_json, "application_ids_json")?,
                    occurred_at,
                })
            },
        )
        .collect()
}

pub fn acknowledge_cursor_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
    through_sequence: i64,
    updated_at: &str,
) -> anyhow::Result<i64> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed cursor update requires a caller-owned transaction"
    );
    require_non_empty(project_id, "projectId")?;
    require_non_empty(consumer_id, "consumerId")?;
    require_non_empty(updated_at, "updatedAt")?;
    anyhow::ensure!(
        through_sequence >= 0,
        "throughSequence must not be negative"
    );
    let head: i64 = conn.query_row(
        "SELECT COALESCE(MAX(canonical_sequence), 0)
           FROM narrative_change_events
          WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        through_sequence <= head,
        "throughSequence {through_sequence} exceeds project feed head {head}"
    );
    conn.execute(
        "INSERT INTO narrative_change_cursors (
            project_id, consumer_id, acknowledged_through_sequence, updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_id, consumer_id) DO UPDATE SET
            acknowledged_through_sequence = MAX(
                narrative_change_cursors.acknowledged_through_sequence,
                excluded.acknowledged_through_sequence
            ),
            updated_at = excluded.updated_at",
        params![project_id, consumer_id, through_sequence, updated_at],
    )?;
    conn.query_row(
        "SELECT acknowledged_through_sequence
           FROM narrative_change_cursors
          WHERE project_id = ?1 AND consumer_id = ?2",
        params![project_id, consumer_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// Return the digest of the feed's canonical representation rather than of a
/// writer-specific Undo snapshot.  Undo journals intentionally carry a little
/// more information (for example authorship spans), and pre-C1 Chronicle rows
/// may retain minute values even when their granularity is only a day.  Those
/// values are useful to the replay writer but must not create a new Feed root
/// incarnation when the next canonical writer reads the same domain row.
pub fn narrative_snapshot_digest(value: &Value) -> anyhow::Result<String> {
    let mut canonical = value.clone();
    normalize_feed_snapshot(&mut canonical);
    digest_value(&canonical)
}

fn normalize_feed_snapshot(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };

    // Codex Undo snapshots include these spans so replay can restore text
    // attribution.  They are not part of the Codex root used by freshness.
    object.remove("authorshipSpans");

    // Legacy Chronicle rows could have minute columns populated while their
    // granularity was `day`/`none`.  The typed writer preserves that legacy
    // storage for compatibility; the Feed canonical root treats those
    // minutes as semantically absent.
    if let Some(event_data) = object.get_mut("eventData").and_then(Value::as_object_mut) {
        normalize_legacy_chronicle_minute(event_data, "startGranularity", "startMinute");
        normalize_legacy_chronicle_minute(event_data, "endGranularity", "endMinute");
        normalize_legacy_chronicle_minute(event_data, "start_granularity", "start_minute");
        normalize_legacy_chronicle_minute(event_data, "end_granularity", "end_minute");
    }
}

fn normalize_legacy_chronicle_minute(
    event_data: &mut serde_json::Map<String, Value>,
    granularity_key: &str,
    minute_key: &str,
) {
    let coarse = event_data
        .get(granularity_key)
        .and_then(Value::as_str)
        .is_some_and(|value| matches!(value, "day" | "none"));
    if coarse {
        event_data.insert(minute_key.to_string(), Value::Null);
    }
}

fn snapshot_digest(value: Option<&Value>) -> anyhow::Result<Option<String>> {
    value.map(narrative_snapshot_digest).transpose()
}

fn snapshot_version(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(|snapshot| snapshot.get("version"))
        .and_then(Value::as_i64)
}

pub fn narrative_object_key(entity_kind: &str, entity_id: &str) -> Value {
    match entity_kind {
        "scene" | "temporal_scene_chronicle" | "temporal_scene_story_order" => {
            json!({ "kind": "scene", "sceneId": entity_id })
        }
        "scene_scope" => json!({ "kind": "scene-scope", "sceneId": entity_id }),
        "scope_registry" => json!({ "kind": "scope-registry", "projectId": entity_id }),
        "event" | "temporal_event_chronicle" => {
            json!({ "kind": "chronicle-event", "eventId": entity_id })
        }
        "codex_entry" => json!({ "kind": "codex-entry", "entryId": entity_id }),
        "codex_relation" => json!({ "kind": "codex-relation", "relationId": entity_id }),
        "codex_phase" | "codex_entry_phase" => {
            json!({ "kind": "codex-phase", "phaseId": entity_id })
        }
        "codex_detail_definition" => {
            json!({ "kind": "codex-detail-definition", "definitionId": entity_id })
        }
        "codex_detail_value" => {
            json!({ "kind": "codex-detail-value", "valueId": entity_id })
        }
        "plot_thread" => json!({ "kind": "plot-thread", "threadId": entity_id }),
        "plot_thread_marker" => json!({ "kind": "plot-marker", "markerId": entity_id }),
        "plot_thread_branch" => json!({ "kind": "plot-branch", "branchId": entity_id }),
        "foreshadow" => json!({ "kind": "foreshadow", "foreshadowId": entity_id }),
        "foreshadow_setup" => json!({ "kind": "foreshadow-setup", "setupId": entity_id }),
        "foreshadow_payoff" => json!({ "kind": "foreshadow-payoff", "payoffId": entity_id }),
        "temporal_node" => json!({ "kind": "temporal-node", "nodeId": entity_id }),
        "temporal_constraint" => {
            json!({ "kind": "temporal-constraint", "constraintId": entity_id })
        }
        "temporal_projection" => {
            json!({ "kind": "temporal-projection", "projectionId": entity_id })
        }
        other => json!({
            "kind": "component",
            "componentId": format!("{other}:{entity_id}"),
        }),
    }
}

fn change_kind(entity_kind: &str) -> &'static str {
    match entity_kind {
        "scene" => "content",
        "temporal_scene_story_order" => "order",
        "plot_thread_marker" | "plot_thread_branch" | "codex_relation" => "association",
        "temporal_node"
        | "temporal_constraint"
        | "temporal_projection"
        | "temporal_scene_chronicle"
        | "temporal_event_chronicle" => "calendar",
        _ => "metadata",
    }
}

fn mutation_kind(op_kind: &str, direction: NarrativeChangeCauseKind) -> &'static str {
    match (direction, op_kind) {
        (NarrativeChangeCauseKind::Forward, "create") => "create",
        (NarrativeChangeCauseKind::Forward, "delete") => "delete",
        (NarrativeChangeCauseKind::Undo, "create") => "delete",
        (NarrativeChangeCauseKind::Undo, "delete") => "restore",
        (NarrativeChangeCauseKind::Redo, "create") => "restore",
        (NarrativeChangeCauseKind::Redo, "delete") => "delete",
        _ => "update",
    }
}

/// The field on an Object Addressing key that carries the object's id, for
/// each ratified `kind`.
///
/// One table, three readers. `validate_event` uses it to reject a key that
/// omits its own id, `object_key_identity` to normalize a key into the string
/// the Change Feed's object heads are keyed by, and
/// `contribution_target_identity_from_object_key` to turn a Feed event back
/// into the `kind:id` form the Contribution ledger stores. Written out once at
/// each of those sites, the three would disagree the first time a kind is
/// added -- and each would fail differently: a key accepted but unaddressable,
/// a head keyed under a shape nothing else produces, a Feed event that matches
/// no Contribution.
///
/// `import-source` needs a second field (`objectKey`) for its full normalized
/// form; that stays with `object_key_identity`, since the id is what every
/// caller here is asking for.
pub(crate) fn object_key_identity_field(kind: &str) -> anyhow::Result<&'static str> {
    Ok(match kind {
        "project" => "projectId",
        "scene" => "sceneId",
        "scene-scope" => "sceneId",
        "scope-registry" => "projectId",
        "chronicle-event" => "eventId",
        "codex-entry" => "entryId",
        "codex-relation" => "relationId",
        "codex-phase" => "phaseId",
        "codex-detail-definition" => "definitionId",
        "codex-detail-value" => "valueId",
        "plot-thread" => "threadId",
        "plot-marker" => "markerId",
        "plot-branch" => "branchId",
        "foreshadow" => "foreshadowId",
        "foreshadow-setup" => "setupId",
        "foreshadow-payoff" => "payoffId",
        "temporal-node" => "nodeId",
        "temporal-constraint" => "constraintId",
        "temporal-projection" => "projectionId",
        "calendar" => "calendarRef",
        "import-source" => "sourceSetId",
        "component" => "componentId",
        other => anyhow::bail!("unsupported objectKey.kind '{other}'"),
    })
}

/// The `kind:id` a Feed event's object key addresses, in the spelling the
/// Contribution ledger stores.
///
/// The two representations exist for different jobs -- the Feed carries a
/// structured key it validates field by field, the ledger a short string it
/// indexes and greps -- so the boundary between them gets one named function
/// rather than a join condition spelled out at each call site. This is the
/// direction Step 7 needs: a Feed event arrives and has to find the
/// Contributions it bears on.
///
/// `codex-detail-value` is projected onto its owning Codex Entry, which is
/// the one place the two sides do not simply translate a kind name. The
/// ledger stores a detail write as `codex-entry:<entryId>` with
/// `/details/<definitionId>` -- `contribution_target_identity_for_application`
/// makes that projection on the Apply side, because `affected_fields` reports
/// the write at entry grain. Without the same projection here, a hand edit of
/// a detail arrives as `codex-detail-value:<valueId>`, matches no
/// Contribution, and the field stays `unchanged` after a person overwrote it.
/// The field paths already agree; only the object identity did not.
pub(crate) fn contribution_target_identity_from_object_key(
    conn: &Connection,
    object_key: &Value,
) -> anyhow::Result<String> {
    let kind = object_key
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Narrative object key has no kind"))?;
    let field = object_key_identity_field(kind)?;
    let id = object_key
        .get(field)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Narrative object key has no {field}"))?;
    if kind == "codex-detail-value" {
        return super::application_contributions::contribution_target_identity_for_application(
            conn,
            "codex_detail_value",
            id,
        );
    }
    Ok(format!("{kind}:{id}"))
}

/// Whether a commit-journal `opKind` describes an operation that wrote
/// nothing.
///
/// `temporal.node.ensure` is a true no-op when the semantic node already
/// exists: `apply_node_ensure_in_tx` returns `created: false` and the row is
/// left byte-for-byte alone. The journal still records the entity, because
/// Undo/Redo needs it for OCC, but nothing downstream may treat it as a
/// mutation.
///
/// Shared rather than restated at each site: `events_from_journal_entities`
/// must not invent a freshness mutation for one, `undo.rs` must not try to
/// roll one back, and `commit.rs` must not record a Contribution claiming a
/// field currently holds what this Application wrote. Three independent
/// copies of one string literal is how those three quietly disagree.
pub(crate) fn journal_op_kind_wrote_nothing(op_kind: &str) -> bool {
    op_kind == "ensure-existing"
}

/// Convert the existing immutable commit-journal entity snapshots into typed
/// freshness events. This does not mutate persistence and never applies a fix.
pub fn events_from_journal_entities(
    entities: &[Value],
    direction: NarrativeChangeCauseKind,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let mut events = Vec::with_capacity(entities.len());
    for entity in entities {
        let entity_kind = entity
            .get("entityKind")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("journal entity missing entityKind"))?;
        let entity_id = entity
            .get("entityId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("journal entity missing entityId"))?;
        let op_kind = entity
            .get("opKind")
            .and_then(Value::as_str)
            .unwrap_or("create");
        if journal_op_kind_wrote_nothing(op_kind) {
            continue;
        }
        let before_snapshot = entity.get("beforeSnapshot");
        let after_snapshot = entity.get("snapshot");
        let mutation = mutation_kind(op_kind, direction);

        let (before, after) = match direction {
            NarrativeChangeCauseKind::Forward if mutation == "create" => (None, after_snapshot),
            NarrativeChangeCauseKind::Forward if mutation == "delete" => {
                (before_snapshot.or(after_snapshot), None)
            }
            NarrativeChangeCauseKind::Forward => (before_snapshot, after_snapshot),
            NarrativeChangeCauseKind::Undo if mutation == "delete" => (after_snapshot, None),
            NarrativeChangeCauseKind::Undo => (after_snapshot, before_snapshot),
            NarrativeChangeCauseKind::Redo if mutation == "restore" => (None, after_snapshot),
            NarrativeChangeCauseKind::Redo if mutation == "delete" => {
                (before_snapshot.or(after_snapshot), None)
            }
            NarrativeChangeCauseKind::Redo => (before_snapshot, after_snapshot),
        };

        let object_key = narrative_object_key(entity_kind, entity_id);
        events.push(NarrativeChangeEventInput {
            object_key,
            change_kind: change_kind(entity_kind).to_string(),
            mutation_kind: mutation.to_string(),
            before_version: before.and_then(|before| {
                snapshot_version(Some(before))
                    .or_else(|| entity.get("version").and_then(Value::as_i64))
            }),
            before_digest: snapshot_digest(before)?,
            after_version: after.and_then(|after| {
                snapshot_version(Some(after))
                    .or_else(|| entity.get("version").and_then(Value::as_i64))
            }),
            after_digest: snapshot_digest(after)?,
            changed_paths: vec!["/".to_string()],
            text_impact: None,
            structural_impact: Some(json!({ "changedPaths": ["/"] })),
        });
    }
    Ok(events)
}

pub fn transaction_id_for_undo_journal(
    conn: &Connection,
    project_id: &str,
    undo_journal_id: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "SELECT CASE
                    WHEN inverse.cause_kind = 'forward' THEN inverse.id
                    ELSE inverse.original_transaction_id
                END AS root_transaction_id
           FROM narrative_change_transactions inverse
           JOIN narrative_change_transactions root
             ON root.project_id = inverse.project_id
            AND root.id = CASE
                WHEN inverse.cause_kind = 'forward' THEN inverse.id
                ELSE inverse.original_transaction_id
            END
            AND root.cause_kind = 'forward'
          WHERE inverse.project_id = ?1
            AND inverse.undo_journal_id = ?2
            AND inverse.cause_kind IN ('forward','undo','redo')
          ORDER BY CASE WHEN inverse.cause_kind = 'forward' THEN 0 ELSE 1 END,
                   inverse.source_change_event_sequence
          LIMIT 1",
        params![project_id, undo_journal_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn optional_snapshot(raw: Option<&str>, field: &str) -> anyhow::Result<Option<Value>> {
    raw.map(|raw| parse_json(raw.to_string(), field))
        .transpose()
}

/// Convert one generic Gate B Undo Journal row into the corresponding typed
/// freshness fact. Chronicle bulk journals are aggregate snapshots and must be
/// expanded by their domain writer instead.
pub fn event_from_undo_journal_row(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: NarrativeChangeCauseKind,
) -> anyhow::Result<NarrativeChangeEventInput> {
    anyhow::ensure!(
        row.entity_kind != "chronicle_bulk",
        "Chronicle bulk Undo Journal requires domain-specific Feed expansion"
    );
    let before_snapshot = optional_snapshot(row.before_json.as_deref(), "undo before_json")?;
    let after_snapshot = optional_snapshot(row.after_json.as_deref(), "undo after_json")?;
    let mutation = mutation_kind(&row.op_kind, direction);
    let (before, after, before_version, after_version) = match (direction, row.op_kind.as_str()) {
        (NarrativeChangeCauseKind::Forward, "create") => (
            None,
            after_snapshot.as_ref(),
            None,
            Some(row.result_version),
        ),
        (NarrativeChangeCauseKind::Forward, "delete") => (
            before_snapshot.as_ref().or(after_snapshot.as_ref()),
            None,
            Some(row.base_version),
            None,
        ),
        (NarrativeChangeCauseKind::Forward, _) => (
            before_snapshot.as_ref(),
            after_snapshot.as_ref(),
            Some(row.base_version),
            Some(row.result_version),
        ),
        (NarrativeChangeCauseKind::Undo, "create") => (
            after_snapshot.as_ref(),
            None,
            Some(row.result_version),
            None,
        ),
        (NarrativeChangeCauseKind::Undo, "delete") => (
            None,
            before_snapshot.as_ref().or(after_snapshot.as_ref()),
            None,
            Some(row.result_version),
        ),
        (NarrativeChangeCauseKind::Undo, _) => (
            after_snapshot.as_ref(),
            before_snapshot.as_ref(),
            Some(row.result_version),
            Some(row.base_version),
        ),
        (NarrativeChangeCauseKind::Redo, "create") => (
            None,
            after_snapshot.as_ref(),
            None,
            Some(row.result_version),
        ),
        (NarrativeChangeCauseKind::Redo, "delete") => (
            before_snapshot.as_ref().or(after_snapshot.as_ref()),
            None,
            Some(row.result_version),
            None,
        ),
        (NarrativeChangeCauseKind::Redo, _) => (
            before_snapshot.as_ref(),
            after_snapshot.as_ref(),
            Some(row.base_version),
            Some(row.result_version),
        ),
    };

    Ok(NarrativeChangeEventInput {
        object_key: narrative_object_key(&row.entity_kind, &row.entity_id),
        change_kind: change_kind(&row.entity_kind).to_string(),
        mutation_kind: mutation.to_string(),
        before_version: before.and(before_version),
        before_digest: snapshot_digest(before)?,
        after_version: after.and(after_version),
        after_digest: snapshot_digest(after)?,
        changed_paths: vec!["/".to_string()],
        // A journal row only has storage snapshots, not the Canonical Text
        // projection and coordinate map. Do not persist a partial text impact;
        // producers may attach the full versioned contract when available.
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": ["/"] })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_direction_distinguishes_delete_and_restore() {
        let entities = vec![json!({
            "entityKind": "codex_entry",
            "entityId": "entry-1",
            "opKind": "create",
            "version": 1,
            "snapshot": { "id": "entry-1", "version": 1 }
        })];
        let undo = events_from_journal_entities(&entities, NarrativeChangeCauseKind::Undo).unwrap();
        let redo = events_from_journal_entities(&entities, NarrativeChangeCauseKind::Redo).unwrap();
        assert_eq!(undo[0].mutation_kind, "delete");
        assert_eq!(redo[0].mutation_kind, "restore");
    }

    #[test]
    fn invalid_object_key_is_rejected() {
        let event = NarrativeChangeEventInput {
            object_key: Value::Null,
            change_kind: "metadata".to_string(),
            mutation_kind: "update".to_string(),
            before_version: None,
            before_digest: None,
            after_version: None,
            after_digest: None,
            changed_paths: vec!["/".to_string()],
            text_impact: None,
            structural_impact: None,
        };
        assert!(validate_event(&event).is_err());
    }

    #[test]
    fn text_impact_requires_a_versioned_utf16_mapping() {
        let mut event = NarrativeChangeEventInput {
            object_key: json!({ "kind": "scene", "sceneId": "scene-1" }),
            change_kind: "content".to_string(),
            mutation_kind: "update".to_string(),
            before_version: Some(1),
            before_digest: Some("sha256:before".to_string()),
            after_version: Some(2),
            after_digest: Some("sha256:after".to_string()),
            changed_paths: vec!["/content".to_string()],
            text_impact: Some(json!({
                "unit": "utf16",
                "normalizerVersion": "gdx-canonical-text/1",
                "oldStorageDigest": "sha256:storage-a",
                "newStorageDigest": "sha256:storage-b",
                "oldCanonicalDigest": "sha256:canonical-a",
                "newCanonicalDigest": "sha256:canonical-b",
                "mapping": {
                    "kind": "canonical-diff",
                    "changedOldRanges": [{ "from": 2, "to": 4 }],
                    "changedNewRanges": [{ "from": 2, "to": 3 }]
                }
            })),
            structural_impact: None,
        };
        assert!(validate_event(&event).is_ok());
        event.text_impact = Some(json!({ "changedPaths": ["/content"] }));
        assert!(validate_event(&event).is_err());
    }

    #[test]
    fn changed_paths_use_json_pointer_escapes() {
        assert!(validate_changed_path("/sceneLinks/a~1b").is_ok());
        assert!(validate_changed_path("title").is_err());
        assert!(validate_changed_path("/title~2").is_err());
    }

    #[test]
    fn snapshot_digest_matches_browser_utf8_fixture() {
        let fixture = json!({
            "あ": "jp",
            "z": [3, { "b": true, "a": null }],
            "é": "accent",
            "a": "first",
        });
        assert_eq!(
            narrative_snapshot_digest(&fixture).unwrap(),
            "sha256:c1f56a548e2a3ab4573fc13ad51436765db5616ebb773409d9eed7194d270a11"
        );
    }

    #[test]
    fn scene_text_impact_is_versioned_and_reverses_for_undo() {
        let before = json!({
            "content": "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"before\"}]}]}"
        });
        let after = json!({
            "content": "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"after\"}]}]}"
        });
        let forward = scene_text_impact(Some(&before), Some(&after))
            .expect("build forward impact")
            .expect("content snapshots produce an impact");
        assert_eq!(
            forward["normalizerVersion"],
            CANONICAL_TEXT_NORMALIZER_VERSION
        );
        assert_eq!(forward["mapping"]["kind"], "whole-document");
        assert_ne!(forward["oldCanonicalDigest"], forward["newCanonicalDigest"]);

        let undo = scene_text_impact(Some(&after), Some(&before))
            .expect("build undo impact")
            .expect("content snapshots produce an undo impact");
        assert_eq!(undo["oldStorageDigest"], forward["newStorageDigest"]);
        assert_eq!(undo["newStorageDigest"], forward["oldStorageDigest"]);
        assert_eq!(undo["oldCanonicalDigest"], forward["newCanonicalDigest"]);
        assert_eq!(undo["newCanonicalDigest"], forward["oldCanonicalDigest"]);
    }

    #[test]
    fn scene_canonical_text_matches_the_shared_typescript_golden_fixtures() {
        #[derive(Debug, Deserialize)]
        struct GoldenFixture {
            id: String,
            document: Value,
            #[serde(rename = "canonicalText")]
            canonical_text: String,
            #[serde(rename = "canonicalDigest")]
            canonical_digest: String,
        }

        fn utf16_len(value: &str) -> usize {
            value.encode_utf16().count()
        }

        let fixtures: Vec<GoldenFixture> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../evals/fixtures/narrative/canonical-text-v1.json"
        )))
        .expect("parse canonical text golden fixtures");

        for fixture in fixtures {
            let storage =
                serde_json::to_string(&fixture.document).expect("serialize canonical text fixture");
            let actual = scene_canonical_text(&storage);
            assert_eq!(actual, fixture.canonical_text, "fixture {}", fixture.id);
            assert_eq!(
                utf16_len(&actual),
                utf16_len(&fixture.canonical_text),
                "UTF-16 length for fixture {}",
                fixture.id
            );
            assert_eq!(
                sha256_digest(actual.as_bytes()),
                fixture.canonical_digest,
                "digest for fixture {}",
                fixture.id
            );
        }
    }

    #[test]
    fn bounded_scene_storage_matches_the_shared_typescript_golden_fixtures() {
        #[derive(Debug, Deserialize)]
        struct GoldenFixture {
            id: String,
            document: Value,
            #[serde(rename = "canonicalText")]
            canonical_text: String,
        }

        let fixtures: Vec<GoldenFixture> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../evals/fixtures/narrative/canonical-text-v1.json"
        )))
        .expect("parse canonical text golden fixtures");

        for fixture in fixtures {
            let storage =
                serde_json::to_string(&fixture.document).expect("serialize canonical text fixture");
            let actual = canonical_scene_storage_with_check(
                &storage,
                storage.len(),
                fixture.canonical_text.len(),
                &mut || Ok(()),
            )
            .unwrap_or_else(|error| panic!("fixture {}: {error}", fixture.id));
            assert_eq!(actual, fixture.canonical_text, "fixture {}", fixture.id);
        }
    }

    #[test]
    fn bounded_scene_storage_rejects_oversized_input_before_json_parse() {
        let mut checks = 0;
        let error = canonical_scene_storage_with_check(&"[".repeat(32), 8, 128, &mut || {
            checks += 1;
            Ok(())
        })
        .expect_err("oversized storage must be unavailable");
        assert!(error.to_string().contains("NEX_CANONICAL_TEXT_INPUT_LIMIT"));
        assert_eq!(checks, 1, "admission must happen before parsing");
    }

    #[test]
    fn bounded_scene_storage_rejects_oversized_canonical_output_before_allocation() {
        let storage = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": "abcdef" }]
            }]
        })
        .to_string();
        let error = canonical_scene_storage_with_check(&storage, storage.len(), 5, &mut || Ok(()))
            .expect_err("canonical output must consume the caller's byte budget");
        assert!(error
            .to_string()
            .contains("NEX_CANONICAL_TEXT_OUTPUT_LIMIT"));
    }

    #[test]
    fn bounded_scene_storage_admits_canonical_output_before_second_pass() {
        let storage = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": "abcdef" }]
            }]
        })
        .to_string();
        let mut parse_admitted = Vec::new();
        let mut output_admitted = Vec::new();
        let actual = canonical_scene_storage_with_admission(
            &storage,
            storage.len(),
            6,
            &mut || Ok(()),
            &mut |bytes| {
                parse_admitted.push(bytes);
                Ok(())
            },
            &mut |bytes| {
                output_admitted.push(bytes);
                Ok(())
            },
        )
        .expect("bounded projection");
        assert_eq!(actual, "abcdef");
        assert!(!parse_admitted.is_empty());
        assert!(parse_admitted.iter().all(|bytes| *bytes > 0));
        assert!(output_admitted.contains(&6));
    }

    #[test]
    fn bounded_scene_storage_rejects_large_json_parse_before_deserialize() {
        let storage = "[".repeat(CANONICAL_PARSE_INPUT_LIMIT + 1);
        let mut checks = 0;
        let mut parse_admissions = 0;
        let error = canonical_scene_storage_with_admission(
            &storage,
            storage.len(),
            4096,
            &mut || {
                checks += 1;
                Ok(())
            },
            &mut |_| {
                parse_admissions += 1;
                Ok(())
            },
            &mut |_| Ok(()),
        )
        .expect_err("large JSON must be conservatively unavailable");
        assert!(error.to_string().contains("NEX_CANONICAL_TEXT_PARSE_LIMIT"));
        assert_eq!(checks, 1, "parse cap must run before deserialization");
        assert_eq!(
            parse_admissions, 0,
            "rejected input must not enter the streaming parser"
        );
    }

    #[test]
    fn bounded_scene_storage_rejects_a_huge_text_token_before_deserialize() {
        let storage = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "text",
                    "text": "x".repeat(CANONICAL_PARSE_INPUT_LIMIT)
                }]
            }]
        })
        .to_string();
        assert!(storage.len() > CANONICAL_PARSE_INPUT_LIMIT);
        let mut parse_admissions = 0;
        let error = canonical_scene_storage_with_admission(
            &storage,
            storage.len(),
            4096,
            &mut || Ok(()),
            &mut |_| {
                parse_admissions += 1;
                Ok(())
            },
            &mut |_| Ok(()),
        )
        .expect_err("huge text token must be unavailable");
        assert!(error.to_string().contains("NEX_CANONICAL_TEXT_PARSE_LIMIT"));
        assert_eq!(parse_admissions, 0);
    }

    #[test]
    fn bounded_scene_storage_rejects_deep_nested_content_before_stack_growth() {
        let mut document = json!({ "type": "text", "text": "leaf" });
        for _ in 0..40 {
            document = json!({
                "type": "wrapper",
                "content": [document]
            });
        }
        let storage = document.to_string();
        let error =
            canonical_scene_storage_with_check(&storage, storage.len(), 4096, &mut || Ok(()))
                .expect_err("deep content must be unavailable");
        assert!(error.to_string().contains("NEX_CANONICAL_TEXT_DEPTH_LIMIT"));
    }

    #[test]
    fn bounded_scene_storage_observes_cancellation_during_json_projection() {
        let storage = json!({
            "type": "doc",
            "content": (0..64)
                .map(|index| json!({
                    "type": "paragraph",
                    "content": [{
                        "type": "text",
                        "text": format!("line-{index}")
                    }]
                }))
                .collect::<Vec<_>>()
        })
        .to_string();
        let mut checks = 0;
        let error = canonical_scene_storage_with_check(&storage, storage.len(), 4096, &mut || {
            checks += 1;
            anyhow::ensure!(checks < 8, "test cancellation");
            Ok(())
        })
        .expect_err("projection must stop when the owner is cancelled");
        assert!(error.to_string().contains("test cancellation"));
        assert!(
            checks >= 2,
            "the parser and visitor need cancellation checks"
        );
    }

    #[test]
    fn bounded_scene_storage_keeps_crlf_together_at_a_piece_boundary() {
        let text = format!("{}\r\nnext", "x".repeat(CANONICAL_TEXT_CHECK_BYTES - 1));
        let storage = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": text }]
            }]
        })
        .to_string();
        let actual = canonical_scene_storage_with_check(
            &storage,
            storage.len(),
            CANONICAL_TEXT_CHECK_BYTES + 16,
            &mut || Ok(()),
        )
        .expect("bounded projection");
        assert_eq!(
            actual,
            format!("{}\nnext", "x".repeat(CANONICAL_TEXT_CHECK_BYTES - 1))
        );
    }
}
