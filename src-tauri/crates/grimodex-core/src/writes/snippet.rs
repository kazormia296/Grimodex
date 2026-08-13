//! Legacy Snippet create contract.
//!
//! Gate C1 moved executable Snippet writes to `grimodex-db::agent_writes`
//! and `grimodex-db::snippet_writes`, where the domain row, Undo Journal,
//! canonical Change Event, Narrative Change Feed, and request receipt can be
//! committed together. This core-only entrypoint remains as a fail-closed API
//! shim so no caller can accidentally bypass the Feed.

use rusqlite::Connection;

use crate::writes::codex::AuthorshipSpanInput;
use crate::writes::codex::WriteResult;

pub struct TrackedSnippetCreateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    pub snippet_id: &'a str,
    pub title: &'a str,
    pub content: &'a str,
    pub scene_id: Option<&'a str>,
    pub source_chat_message_id: Option<&'a str>,
    pub authorship_spans: &'a [AuthorshipSpanInput],
}

pub fn tracked_snippet_create(
    _conn: &Connection,
    _input: TrackedSnippetCreateInput<'_>,
) -> anyhow::Result<WriteResult> {
    anyhow::bail!("tracked_snippet_create is retired; use a grimodex-db canonical Snippet writer")
}
