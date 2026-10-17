//! Test-only entry to the production undo writer.
//!
//! The declaration invalidation tests (`narrative_extraction::
//! scene_body_declaration::invalidation_tests`) replay a Chronicle bulk
//! journal undo and redo to show that a declaration never matches again. The
//! narrative-extraction tree is a semantic-boundary scan root that must not
//! name the Agent Writer, so the call lives here, outside that root. It is
//! `#[cfg(test)]` and adds no product path.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crate::agent_writes::{agent_undo_journal_impl, AgentUndoJournalPayload};
use crate::Database;

/// Runs `direction` ("undo" or "redo") of `journal_id` through the production
/// history-replay writer.
pub(crate) fn replay_undo_journal(
    db: &Database,
    project_id: &str,
    request_id: &str,
    journal_id: &str,
    direction: &str,
) {
    agent_undo_journal_impl(
        db,
        AgentUndoJournalPayload {
            request_id: request_id.into(),
            project_id: project_id.into(),
            session_id: "session".into(),
            journal_id: journal_id.into(),
            direction: direction.into(),
            authority_route: "history-replay".into(),
            origin: direction.into(),
            caller: "undo-redo-command".into(),
            controls: [
                "original-transaction",
                "journal-lineage",
                "typed-writer",
                "occ",
                "change-event",
                "change-feed",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    )
    .expect("undo journal replay");
}
