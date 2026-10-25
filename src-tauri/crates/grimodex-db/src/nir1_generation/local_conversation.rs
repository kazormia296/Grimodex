//! The conversations of the NIR-1 local generation route (K5/3 "この route の
//! 会話の範囲", S20; DD-1a, DR-DD1A-3 and DR-DD1A-10).
//!
//! Two stages decide what belongs to the route:
//!
//! 1. the session: a `chat_sessions` row whose `id` carries the route's mark,
//!    which only [`create_local_conversation_bounded`] writes. The mark is a
//!    reserved prefix that also names the purpose
//!    (`nir1-local-writing-<uuid>` / `nir1-local-review-<uuid>`). It lives in
//!    the primary key, which no chat writer changes after the insert; it is
//!    never in `title`, `title_manual`, `updated_at` or another column the
//!    renderer may change. Capture or attempt rows, the bound Scene, the title
//!    and the model never decide the stage;
//! 2. the rows: (a) a Human message version that the #611 capture writer
//!    recorded in `nir1_chat_input_captures` for the session, in any state;
//!    (b) the generated message version that a successful attempt of this
//!    route (the binding's provider and api) wrote as its output. Each row is
//!    read through the existing version reader, so only a version that is not
//!    invalidated and whose role, body, thinking and creation time match the
//!    stored digest returns content.
//!
//! No schema is added: the mark and the purpose are values inside the
//! existing columns.

use super::{
    attempt_id_for_capture, bounded_sqlite_length, capture_owner_json, identity,
    read_capture_row_in_tx, read_current_chat_input_capture_in_tx,
    read_message_version_in_tx_with_body_and_reservation, read_stored_binding,
    AcceptedChatInputCapture, ChatInputCaptureOwner, GenerationPurpose, MessageOrigin,
    MAX_ID_BYTES, MAX_MESSAGE_METADATA_BYTES, MAX_SHORT_TEXT_BYTES,
};
use crate::narrative_maintenance_connection::ParticipantSqlOperationBudget;
use crate::state::ActiveWorkspaceSnapshot;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

/// The reserved prefix of a Writing conversation of this route.
pub const NIR1_LOCAL_WRITING_CONVERSATION_PREFIX: &str = "nir1-local-writing-";
/// The reserved prefix of a Review conversation of this route.
pub const NIR1_LOCAL_REVIEW_CONVERSATION_PREFIX: &str = "nir1-local-review-";
/// Where the hyphens of the lowercase 8-4-4-4-12 UUID after the prefix are.
const UUID_HYPHENS: [usize; 4] = [8, 13, 18, 23];
const UUID_LEN: usize = 36;

/// Upper bound of the conversations one list returns (DR-DD1A-11).
pub const NIR1_LOCAL_CONVERSATION_LIST_LIMIT: usize = 256;
/// Upper bound of the candidate rows (inputs plus outputs) of one
/// conversation. A conversation over it is refused, never truncated.
pub const NIR1_LOCAL_CONVERSATION_MAX_ROWS: usize = 4096;
/// Upper bound of the rows of one read range.
pub const NIR1_LOCAL_CONVERSATION_PAGE_ROWS: usize = 64;
/// Upper bound of the text and thinking bytes of one read range.
pub const NIR1_LOCAL_CONVERSATION_PAGE_BYTES: usize = 4 * 1024 * 1024;

const PAGE_FULL: &str = "NIR1_LOCAL_CONVERSATION_PAGE_FULL";

fn is_page_full(error: &anyhow::Error) -> bool {
    format!("{error:#}").contains(PAGE_FULL)
}

fn prefix_of(purpose: &GenerationPurpose) -> &'static str {
    match purpose {
        GenerationPurpose::Writing => NIR1_LOCAL_WRITING_CONVERSATION_PREFIX,
        GenerationPurpose::Review => NIR1_LOCAL_REVIEW_CONVERSATION_PREFIX,
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// The purpose a conversation ID marks, or `None` when the ID is not exactly a
/// reserved prefix followed by a lowercase 8-4-4-4-12 UUID. This is the only
/// test of the session stage; [`local_conversation_glob`] is derived from the
/// same layout, so a bounded SQL lookup selects exactly what this accepts.
pub fn local_conversation_purpose(id: &str) -> Option<GenerationPurpose> {
    let (purpose, rest) = match id.strip_prefix(NIR1_LOCAL_WRITING_CONVERSATION_PREFIX) {
        Some(rest) => (GenerationPurpose::Writing, rest),
        None => (
            GenerationPurpose::Review,
            id.strip_prefix(NIR1_LOCAL_REVIEW_CONVERSATION_PREFIX)?,
        ),
    };
    let bytes = rest.as_bytes();
    if bytes.len() != UUID_LEN {
        return None;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let valid = if UUID_HYPHENS.contains(&index) {
            *byte == b'-'
        } else {
            is_lower_hex(*byte)
        };
        if !valid {
            return None;
        }
    }
    Some(purpose)
}

/// A SQLite GLOB pattern that matches exactly the IDs
/// [`local_conversation_purpose`] accepts for `purpose` (GLOB is
/// case-sensitive and `[0-9a-f]` matches one byte).
pub fn local_conversation_glob(purpose: &GenerationPurpose) -> String {
    let mut pattern = prefix_of(purpose).to_owned();
    for index in 0..UUID_LEN {
        if UUID_HYPHENS.contains(&index) {
            pattern.push('-');
        } else {
            pattern.push_str("[0-9a-f]");
        }
    }
    pattern
}

/// A new conversation ID for `purpose`. Only the Native create calls it.
fn new_local_conversation_id(purpose: &GenerationPurpose) -> String {
    format!("{}{}", prefix_of(purpose), Uuid::new_v4().hyphenated())
}

/// What the create and the list return about one conversation: the ID, the
/// purpose read from the mark, and the creation time when it parses as an
/// RFC 3339 instant (normalized to UTC with milliseconds). No string column is
/// returned as is.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalConversationEntry {
    pub id: String,
    pub purpose: GenerationPurpose,
    pub created_at: Option<String>,
}

fn normalized_instant(raw: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|instant| {
            instant
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
}

/// Create one conversation of this route bound to a live Scene. The ID (mark
/// and purpose) is decided here and inserted strictly in one transaction; the
/// title and the model keep their column defaults, so no content or user input
/// is written to a display column.
pub fn create_local_conversation_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    purpose: &GenerationPurpose,
    scene_id: &str,
    budget: ParticipantSqlOperationBudget,
) -> Result<LocalConversationEntry> {
    identity(scene_id)?;
    let id = new_local_conversation_id(purpose);
    let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let inner_budget = budget.clone();
    workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded(
            workspace.participant(),
            budget,
            |conn| {
                inner_budget.check(workspace.participant())?;
                let project_id = live_scene_project_in_tx(conn, scene_id)?
                    .context("NIR1_LOCAL_CONVERSATION_SCENE_REQUIRED")?;
                conn.execute(
                    "INSERT INTO chat_sessions (id, project_id, node_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, project_id, scene_id, created_at],
                )?;
                inner_budget.check(workspace.participant())?;
                Ok(())
            },
        )?;
    Ok(LocalConversationEntry {
        id,
        purpose: purpose.clone(),
        created_at: Some(created_at),
    })
}

/// The project of a live Scene node (`node_type = 'scene'`, not archived).
fn live_scene_project_in_tx(conn: &Connection, scene_id: &str) -> Result<Option<String>> {
    let row: Option<(i64, String, String, Option<String>)> = conn
        .query_row(
            "SELECT octet_length(project_id), project_id, node_type, archived_at
               FROM tree_nodes WHERE id = ?1",
            [scene_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((project_len, project_id, node_type, archived_at)) = row else {
        return Ok(None);
    };
    bounded_sqlite_length(
        project_len,
        MAX_ID_BYTES,
        "NIR1_LOCAL_CONVERSATION_SCOPE_LIMIT",
    )?;
    if node_type != "scene" || archived_at.is_some() {
        return Ok(None);
    }
    identity(&project_id)?;
    Ok(Some(project_id))
}

/// The conversations of this route in the pinned workspace's DB, newest first,
/// at most [`NIR1_LOCAL_CONVERSATION_LIST_LIMIT`]. The second value is true
/// when more exist. The SQL selects exactly the marked IDs (the GLOB equals
/// the parser), so the limit never hides a conversation behind a row the
/// parser would drop.
pub fn list_local_conversations_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    budget: ParticipantSqlOperationBudget,
) -> Result<(Vec<LocalConversationEntry>, bool)> {
    let writing = local_conversation_glob(&GenerationPurpose::Writing);
    let review = local_conversation_glob(&GenerationPurpose::Review);
    let fetch = NIR1_LOCAL_CONVERSATION_LIST_LIMIT + 1;
    let rows: Vec<(String, i64, String)> = workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            let mut statement = conn.prepare(
                "SELECT id, octet_length(created_at), created_at FROM chat_sessions
                  WHERE id GLOB ?1 OR id GLOB ?2
                  ORDER BY created_at DESC, id
                  LIMIT ?3",
            )?;
            let rows = statement
                .query_map(params![writing, review, fetch as i64], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
    let more = rows.len() > NIR1_LOCAL_CONVERSATION_LIST_LIMIT;
    let mut entries = Vec::with_capacity(rows.len().min(NIR1_LOCAL_CONVERSATION_LIST_LIMIT));
    for (id, created_len, created_at) in rows.into_iter().take(NIR1_LOCAL_CONVERSATION_LIST_LIMIT) {
        let purpose =
            local_conversation_purpose(&id).context("NIR1_LOCAL_CONVERSATION_MARK_INVALID")?;
        let created_at = usize::try_from(created_len)
            .ok()
            .filter(|length| *length <= MAX_SHORT_TEXT_BYTES)
            .and_then(|_| normalized_instant(&created_at));
        entries.push(LocalConversationEntry {
            id,
            purpose,
            created_at,
        });
    }
    Ok((entries, more))
}

/// The session stage of one ID for the start: whether the row exists, and the
/// project and the live Scene it is bound to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalConversationScope {
    /// The ID carries no mark of this route (nothing was read).
    NotThisRoute,
    /// The marked row does not exist in this DB.
    Missing,
    /// The row exists but is not bound to a live Scene.
    NoScene,
    Scene {
        purpose: GenerationPurpose,
        project_id: String,
        scene_id: String,
    },
}

pub fn read_local_conversation_scope_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    conversation_id: &str,
    budget: ParticipantSqlOperationBudget,
) -> Result<LocalConversationScope> {
    let Some(purpose) = local_conversation_purpose(conversation_id) else {
        return Ok(LocalConversationScope::NotThisRoute);
    };
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            session_scope_in_tx(conn, conversation_id, purpose)
        })
}

fn session_scope_in_tx(
    conn: &Connection,
    conversation_id: &str,
    purpose: GenerationPurpose,
) -> Result<LocalConversationScope> {
    let row: Option<(i64, Option<i64>, String, Option<String>)> = conn
        .query_row(
            "SELECT octet_length(project_id), octet_length(node_id), project_id, node_id
               FROM chat_sessions WHERE id = ?1",
            [conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((project_len, node_len, project_id, node_id)) = row else {
        return Ok(LocalConversationScope::Missing);
    };
    bounded_sqlite_length(
        project_len,
        MAX_ID_BYTES,
        "NIR1_LOCAL_CONVERSATION_SCOPE_LIMIT",
    )?;
    if let Some(length) = node_len {
        bounded_sqlite_length(length, MAX_ID_BYTES, "NIR1_LOCAL_CONVERSATION_SCOPE_LIMIT")?;
    }
    let Some(scene_id) = node_id else {
        return Ok(LocalConversationScope::NoScene);
    };
    match live_scene_project_in_tx(conn, &scene_id)? {
        Some(scene_project) if scene_project == project_id => Ok(LocalConversationScope::Scene {
            purpose,
            project_id,
            scene_id,
        }),
        _ => Ok(LocalConversationScope::NoScene),
    }
}

/// The current capture of one conversation, when its owner is exactly
/// `owner` (the caller's owner, built by the D-final rule) and its Scene is
/// `scene_id`. The capture is re-validated by the existing current-capture
/// reader (state, owner, Scene binding, the Human version and its digest). Any
/// other case, including a capture of another caller or epoch, is `None`.
pub fn read_current_capture_for_session_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    owner: &ChatInputCaptureOwner,
    chat_session_id: &str,
    scene_id: &str,
    budget: ParticipantSqlOperationBudget,
) -> Result<Option<AcceptedChatInputCapture>> {
    identity(chat_session_id)?;
    identity(scene_id)?;
    let owner_json = capture_owner_json(owner)?;
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            let mut statement = conn.prepare(
                "SELECT capture_id FROM nir1_chat_input_captures
                  WHERE chat_session_id = ?1 AND state = 'current' LIMIT 2",
            )?;
            let ids = statement
                .query_map([chat_session_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ensure!(ids.len() <= 1, "NIR1_CHAT_CAPTURE_CURRENT_INVARIANT_BROKEN");
            let Some(capture_id) = ids.into_iter().next() else {
                return Ok(None);
            };
            let row = read_capture_row_in_tx(conn, &capture_id)?;
            if row.1 != chat_session_id || row.2 != scene_id || row.7 != owner_json {
                return Ok(None);
            }
            let capture = AcceptedChatInputCapture {
                capture_id,
                project_id: row.0,
                chat_session_id: row.1,
                scene_id: row.2,
                submission_id: row.3,
                submission_digest: row.4,
                message_id: row.5,
                message_version_id: row.6,
                owner: owner.clone(),
            };
            read_current_chat_input_capture_in_tx(conn, &capture, owner, |_, _| Ok(()))?;
            Ok(Some(capture))
        })
}

/// Input (a) or output (b).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalConversationRowKind {
    Input,
    Output,
}

/// The content of a verified row. `attempt_status` is the terminal status of
/// an input's attempt (`pending` while it has none, absent when there is no
/// attempt); it carries no text.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalConversationRowContent {
    pub text: String,
    /// The verified row's `thinking_blocks` (JSON), for an output only.
    pub thinking: Option<Value>,
    pub attempt_status: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalConversationRow {
    pub message_id: String,
    pub kind: LocalConversationRowKind,
    pub created_at_ms: i64,
    /// The content, or the closed reason a row of stage (a) or (b) failed its
    /// verification (no content then).
    pub content: Result<LocalConversationRowContent, &'static str>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LocalConversationRead {
    NotThisRoute,
    Missing,
    Page {
        purpose: GenerationPurpose,
        rows: Vec<LocalConversationRow>,
        /// Candidate rows of stages (a) and (b) in the conversation.
        total: usize,
        /// The byte bound stopped the range before `limit` rows.
        truncated: bool,
    },
}

struct Candidate {
    /// The version row's rowid: the order the rows were written in. The
    /// creation times are not used to order (a Human row's time is the
    /// renderer's value).
    order: i64,
    version_id: String,
    message_id: String,
    created_at_ms: i64,
    kind: LocalConversationRowKind,
    /// The capture (input) or the attempt (output) the row comes from.
    source_id: String,
}

/// Read one range of a conversation of this route (stage 2), in the order the
/// rows were written. `provider` and `api` are the values the route's D-final
/// writes into an attempt binding.
#[allow(clippy::too_many_arguments)]
pub fn read_local_conversation_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    conversation_id: &str,
    provider: &str,
    api: &str,
    offset: usize,
    limit: usize,
    max_bytes: usize,
    budget: ParticipantSqlOperationBudget,
) -> Result<LocalConversationRead> {
    let Some(purpose) = local_conversation_purpose(conversation_id) else {
        return Ok(LocalConversationRead::NotThisRoute);
    };
    let limit = limit.min(NIR1_LOCAL_CONVERSATION_PAGE_ROWS);
    let max_bytes = max_bytes.min(NIR1_LOCAL_CONVERSATION_PAGE_BYTES);
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            let project: Option<(i64, String)> = conn
                .query_row(
                    "SELECT octet_length(project_id), project_id FROM chat_sessions WHERE id = ?1",
                    [conversation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((project_len, project_id)) = project else {
                return Ok(LocalConversationRead::Missing);
            };
            bounded_sqlite_length(
                project_len,
                MAX_ID_BYTES,
                "NIR1_LOCAL_CONVERSATION_SCOPE_LIMIT",
            )?;
            let mut candidates =
                candidates_in_tx(conn, &project_id, conversation_id, provider, api)?;
            candidates.sort_by_key(|candidate| candidate.order);
            let total = candidates.len();
            let mut rows = Vec::new();
            let mut used = 0usize;
            let mut truncated = false;
            for candidate in candidates.iter().skip(offset).take(limit) {
                match read_row_in_tx(
                    conn,
                    &project_id,
                    conversation_id,
                    provider,
                    api,
                    candidate,
                    &mut used,
                    max_bytes,
                ) {
                    Ok(row) => rows.push(row),
                    Err(error) if is_page_full(&error) => {
                        truncated = true;
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(LocalConversationRead::Page {
                purpose,
                rows,
                total,
                truncated,
            })
        })
}

fn candidates_in_tx(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    provider: &str,
    api: &str,
) -> Result<Vec<Candidate>> {
    let fetch = (NIR1_LOCAL_CONVERSATION_MAX_ROWS + 1) as i64;
    let mut inputs = conn.prepare(
        "SELECT v.rowid, c.message_version_id, c.message_id, v.created_at_ms, c.capture_id
           FROM nir1_chat_input_captures AS c
           JOIN nir1_generation_message_versions AS v ON v.id = c.message_version_id
          WHERE c.project_id = ?1 AND c.chat_session_id = ?2
          LIMIT ?3",
    )?;
    let mut candidates = inputs
        .query_map(params![project_id, session_id, fetch], |row| {
            Ok(Candidate {
                order: row.get(0)?,
                version_id: row.get(1)?,
                message_id: row.get(2)?,
                created_at_ms: row.get(3)?,
                kind: LocalConversationRowKind::Input,
                source_id: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        candidates.len() <= NIR1_LOCAL_CONVERSATION_MAX_ROWS,
        "NIR1_LOCAL_CONVERSATION_ROW_LIMIT"
    );
    let remaining = fetch - candidates.len() as i64;
    let mut outputs = conn.prepare(
        "SELECT v.rowid, a.output_version_id, v.message_id, v.created_at_ms, a.id
           FROM nir1_generation_attempts AS a
           JOIN nir1_generation_message_versions AS v ON v.id = a.output_version_id
          WHERE a.project_id = ?1 AND a.session_id = ?2
            AND a.terminal_json IS NOT NULL
            AND json_extract(a.terminal_json, '$.observation.terminalStatus') = 'succeeded'
            AND json_extract(a.binding_json, '$.provider') = ?3
            AND json_extract(a.binding_json, '$.api') = ?4
          LIMIT ?5",
    )?;
    let generated = outputs
        .query_map(
            params![project_id, session_id, provider, api, remaining],
            |row| {
                Ok(Candidate {
                    order: row.get(0)?,
                    version_id: row.get(1)?,
                    message_id: row.get(2)?,
                    created_at_ms: row.get(3)?,
                    kind: LocalConversationRowKind::Output,
                    source_id: row.get(4)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    candidates.extend(generated);
    ensure!(
        candidates.len() <= NIR1_LOCAL_CONVERSATION_MAX_ROWS,
        "NIR1_LOCAL_CONVERSATION_ROW_LIMIT"
    );
    for candidate in &candidates {
        identity(&candidate.version_id)?;
        identity(&candidate.message_id)?;
        identity(&candidate.source_id)?;
    }
    Ok(candidates)
}

#[allow(clippy::too_many_arguments)]
fn read_row_in_tx(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    provider: &str,
    api: &str,
    candidate: &Candidate,
    used: &mut usize,
    max_bytes: usize,
) -> Result<LocalConversationRow> {
    let content = match verified_content_in_tx(
        conn, project_id, session_id, provider, api, candidate, used, max_bytes,
    ) {
        Ok(content) => Ok(content),
        Err(error) if is_page_full(&error) => return Err(error),
        Err(error) => Err(closed_reason(&error)),
    };
    Ok(LocalConversationRow {
        message_id: candidate.message_id.clone(),
        kind: candidate.kind,
        created_at_ms: candidate.created_at_ms,
        content,
    })
}

/// A verification failure as a closed word: the stable `NIR1_*` codes the
/// version reader raises, everything else one generic word.
fn closed_reason(error: &anyhow::Error) -> &'static str {
    const KNOWN: [&str; 7] = [
        "NIR1_GENERATION_MESSAGE_VERSION_MISSING",
        "NIR1_GENERATION_MESSAGE_BODY_MISMATCH",
        "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH",
        "NIR1_GENERATION_MESSAGE_MISSING",
        "NIR1_GENERATION_MESSAGE_BODY_LIMIT",
        "NIR1_LOCAL_CONVERSATION_ROW_MISMATCH",
        "NIR1_GENERATION_BINDING_INVALID",
    ];
    let message = format!("{error:#}");
    KNOWN
        .iter()
        .find(|code| message.contains(**code))
        .copied()
        .unwrap_or("NIR1_LOCAL_CONVERSATION_ROW_UNVERIFIED")
}

#[allow(clippy::too_many_arguments)]
fn verified_content_in_tx(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    provider: &str,
    api: &str,
    candidate: &Candidate,
    used: &mut usize,
    max_bytes: usize,
) -> Result<LocalConversationRowContent> {
    let metadata_bytes = match candidate.kind {
        LocalConversationRowKind::Input => 0,
        LocalConversationRowKind::Output => {
            let length: Option<i64> = conn
                .query_row(
                    "SELECT octet_length(metadata) FROM chat_messages WHERE id = ?1",
                    [&candidate.message_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            let length = length.unwrap_or(0);
            bounded_sqlite_length(
                length,
                MAX_MESSAGE_METADATA_BYTES,
                "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
            )?;
            usize::try_from(length).unwrap_or(usize::MAX)
        }
    };
    let (version, text) = read_message_version_in_tx_with_body_and_reservation(
        conn,
        &candidate.version_id,
        None,
        |_, _, _, body_bytes| {
            let next = used
                .saturating_add(body_bytes)
                .saturating_add(metadata_bytes);
            if next > max_bytes {
                anyhow::bail!(PAGE_FULL);
            }
            *used = next;
            Ok(())
        },
    )?;
    ensure!(
        version.project_id == project_id
            && version.session_id == session_id
            && version.message_id == candidate.message_id,
        "NIR1_LOCAL_CONVERSATION_ROW_MISMATCH"
    );
    match candidate.kind {
        LocalConversationRowKind::Input => {
            ensure!(
                version.origin == MessageOrigin::Human && version.parent_attempt_id.is_none(),
                "NIR1_LOCAL_CONVERSATION_ROW_MISMATCH"
            );
            let attempt_status = input_attempt_status_in_tx(conn, &candidate.source_id)?;
            Ok(LocalConversationRowContent {
                text,
                thinking: None,
                attempt_status,
            })
        }
        LocalConversationRowKind::Output => {
            ensure!(
                version.origin == MessageOrigin::Generated
                    && version.parent_attempt_id.as_deref() == Some(candidate.source_id.as_str()),
                "NIR1_LOCAL_CONVERSATION_ROW_MISMATCH"
            );
            let binding_json: String = conn.query_row(
                "SELECT binding_json FROM nir1_generation_attempts WHERE id = ?1",
                [&candidate.source_id],
                |row| row.get(0),
            )?;
            let binding =
                read_stored_binding(&binding_json, project_id, session_id)?.into_current()?;
            ensure!(
                binding.provider == provider && binding.api == api,
                "NIR1_LOCAL_CONVERSATION_ROW_MISMATCH"
            );
            // The digest the version reader just matched covers the metadata's
            // `thinking_blocks`; this read is inside the same transaction.
            let metadata: Option<String> = conn.query_row(
                "SELECT metadata FROM chat_messages WHERE id = ?1",
                [&candidate.message_id],
                |row| row.get(0),
            )?;
            let thinking = metadata
                .map(|raw| serde_json::from_str::<Value>(&raw))
                .transpose()?
                .and_then(|value| value.get("thinking_blocks").cloned())
                .filter(|value| !value.is_null());
            Ok(LocalConversationRowContent {
                text,
                thinking,
                attempt_status: None,
            })
        }
    }
}

/// The terminal status of the attempt of one capture, without text.
fn input_attempt_status_in_tx(conn: &Connection, capture_id: &str) -> Result<Option<String>> {
    let row = read_capture_row_in_tx(conn, capture_id)?;
    let attempt_id = attempt_id_for_capture(&AcceptedChatInputCapture {
        capture_id: capture_id.to_owned(),
        project_id: row.0,
        chat_session_id: row.1,
        scene_id: row.2,
        submission_id: row.3,
        submission_digest: row.4,
        message_id: row.5,
        message_version_id: row.6,
        owner: serde_json::from_str(&row.7).context("NIR1_CHAT_CAPTURE_OWNER_INVALID")?,
    })?;
    let status: Option<(Option<i64>, Option<String>)> = conn
        .query_row(
            "SELECT octet_length(json_extract(terminal_json, '$.observation.terminalStatus')),
                    json_extract(terminal_json, '$.observation.terminalStatus')
               FROM nir1_generation_attempts WHERE id = ?1",
            [&attempt_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match status {
        None => None,
        Some((_, None)) => Some("pending".to_owned()),
        Some((length, Some(status))) => {
            bounded_sqlite_length(
                length.unwrap_or(0),
                MAX_SHORT_TEXT_BYTES,
                "NIR1_GENERATION_TERMINAL_LIMIT",
            )?;
            Some(match status.as_str() {
                "succeeded" | "failed" | "cancelled" => status,
                _ => "unknown".to_owned(),
            })
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mark_parser_and_the_glob_agree() {
        let writing = new_local_conversation_id(&GenerationPurpose::Writing);
        let review = new_local_conversation_id(&GenerationPurpose::Review);
        assert_eq!(
            local_conversation_purpose(&writing),
            Some(GenerationPurpose::Writing)
        );
        assert_eq!(
            local_conversation_purpose(&review),
            Some(GenerationPurpose::Review)
        );
        let base = "0123abcd-4567-89ab-cdef-0123456789ab";
        for rejected in [
            String::new(),
            base.to_owned(),
            format!("nir1-local-writing-{}", base.to_uppercase()),
            format!("nir1-local-writing-{base}x"),
            format!("nir1-local-writing-{}", &base[1..]),
            format!("nir1-local-writing-{}", base.replace('-', "_")),
            format!(" nir1-local-writing-{base}"),
            format!("nir1-local-Writing-{base}"),
            format!("nir1-local-other-{base}"),
            format!("{}-{base}", "New session"),
        ] {
            assert_eq!(local_conversation_purpose(&rejected), None, "{rejected:?}");
        }
        let conn = Connection::open_in_memory().expect("sqlite");
        let glob_matches = |id: &str, purpose: &GenerationPurpose| -> bool {
            conn.query_row(
                "SELECT ?1 GLOB ?2",
                params![id, local_conversation_glob(purpose)],
                |row| row.get::<_, bool>(0),
            )
            .expect("glob")
        };
        for (id, purpose) in [
            (writing.clone(), GenerationPurpose::Writing),
            (review.clone(), GenerationPurpose::Review),
        ] {
            assert!(glob_matches(&id, &purpose));
        }
        assert!(!glob_matches(&writing, &GenerationPurpose::Review));
        for rejected in [
            format!("nir1-local-writing-{}", base.to_uppercase()),
            format!("nir1-local-writing-{base}x"),
            format!("nir1-local-writing-{}", base.replace('-', "_")),
        ] {
            assert!(!glob_matches(&rejected, &GenerationPurpose::Writing));
        }
    }
}
