//! The wire request of `chat_agent_ir_select` and its validation.
//!
//! Main validates the same bounds before Native is reached; Native is the
//! authority (DR-CHATIR-S1-14). A refused query writes no audit row and runs no
//! inference: the check comes before the permit.

use serde::Deserialize;

/// The upper bound of the query, counted in UTF-16 code units like the
/// contract (§3.2), Related Scenes and the renderer's `string.length`.
/// UTF-8 bytes are bounded by it too (at most 3 per unit, so 1,500): that
/// derived bound can never be reached and is not checked.
pub(crate) const QUERY_MAX_UTF16: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub(crate) query: String,
    pub(crate) project_id: String,
    pub(crate) expected_workspace_path: String,
    pub(crate) current_scene_id: String,
}

/// Not empty, not only whitespace, at most [`QUERY_MAX_UTF16`] code units. A
/// longer query is refused, never cut: a cut query would differ from what the
/// model wrote, what is embedded and what the audit records.
pub(crate) fn query_is_valid(query: &str) -> bool {
    !query.trim().is_empty() && query.encode_utf16().count() <= QUERY_MAX_UTF16
}
