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

/// The most candidate Chronicle event IDs one request carries. It is the
/// year table's own over-fetch bound (`min(limit * 3, 30)`, S1-A2 DR-CHATIR-S1-41).
pub(crate) const CHRONICLE_EVENT_IDS_MAX: usize = 30;

/// The longest candidate event ID in UTF-16 code units, the unit of
/// `string.length` (the bound Related Scenes puts on its own IDs).
pub(crate) const CHRONICLE_EVENT_ID_MAX_UTF16: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub(crate) query: String,
    pub(crate) project_id: String,
    pub(crate) expected_workspace_path: String,
    pub(crate) current_scene_id: String,
    /// The Chronicle events the caller (the year table) already holds as
    /// candidates, for the IR admission rule to judge (S1-A2 A2). Required: an
    /// empty list means "no candidate", a missing key is a request error. The
    /// IDs are never logged, audited or kept in the ledger; the request is
    /// dropped when the call's task ends.
    pub(crate) chronicle_event_ids: Vec<String>,
}

/// Not empty, not only whitespace, at most [`QUERY_MAX_UTF16`] code units. A
/// longer query is refused, never cut: a cut query would differ from what the
/// model wrote, what is embedded and what the audit records.
pub(crate) fn query_is_valid(query: &str) -> bool {
    !query.trim().is_empty() && query.encode_utf16().count() <= QUERY_MAX_UTF16
}

/// At most [`CHRONICLE_EVENT_IDS_MAX`] IDs, each neither empty nor only white
/// space and at most [`CHRONICLE_EVENT_ID_MAX_UTF16`] code units, none twice.
/// An empty list is valid. Main checks the same; a violation is an
/// `INVALID_REQUEST` before the permit.
pub(crate) fn chronicle_event_ids_are_valid(ids: &[String]) -> bool {
    ids.len() <= CHRONICLE_EVENT_IDS_MAX
        && ids.iter().all(|id| {
            !id.trim().is_empty() && id.encode_utf16().count() <= CHRONICLE_EVENT_ID_MAX_UTF16
        })
        && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
}
