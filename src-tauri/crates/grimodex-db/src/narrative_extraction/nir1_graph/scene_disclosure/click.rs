//! The click revalidation (draft "利用時の判定", "click 時").
//!
//! A click does not trust anything the response made. In a new read
//! transaction the same judgements run again for the one Scene, against the
//! values the response bound (instead of the frame's), and the excerpt and its
//! range must equal the ones that were shown. It does not depend on how a
//! revocation or a clear is told to the shown row (CP-3); it stands alone.

use std::collections::BTreeSet;

use anyhow::Result;
use rusqlite::Connection;

use super::body::{read_body, BodyStep};
use super::counters::{record, Count};
use super::eligible::{GraphOnlyClick, GraphOnlySceneBinding, GraphSceneRange};
use super::{
    AppendSlot, GraphDisclosureQuery, GraphDisclosureWorkspace, GraphOnlyScan, GraphOnlyScanInput,
    GraphPathRevalidator, GraphSceneRevalidationRefused,
};
use crate::narrative_extraction::scene_body_declaration::scene_body_title_digest;

fn refused(count: Count) -> GraphOnlyClick {
    record(count);
    record(Count::ClickRefused);
    GraphOnlyClick::Refused(GraphSceneRevalidationRefused)
}

/// Revalidates a shown Graph-only Scene for a click.
///
/// `conn` must be in a new read transaction (`Err` otherwise). The scan's
/// judgements (live, A1, reading order, declaration, binding, veto,
/// quarantine, frame values, pin, path) run for the one association the
/// response used; the common slot's condition and the tuple-order scan are not
/// part of it. Then the body step runs and its result must equal the binding.
/// Anything that does not hold is the one closed [`GraphSceneRevalidationRefused`];
/// an `Err` is a control (cancel/deadline) or storage failure.
pub fn requalify_graph_only_scene_disclosure(
    conn: &Connection,
    workspace: &GraphDisclosureWorkspace,
    query: &GraphDisclosureQuery,
    binding: &GraphOnlySceneBinding,
    path: &mut dyn GraphPathRevalidator,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphOnlyClick> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "NIR1_GRAPH_SCENE_DISCLOSURE_REQUIRES_READ_TRANSACTION"
    );
    let (Some(workspace_parts), Some(query_parts)) = (workspace.parts(), query.parts()) else {
        return Ok(refused(Count::WorkspaceUnavailable));
    };
    // The response was made for this workspace and this query.
    if workspace_parts.workspace_id != binding.workspace_id
        || workspace_parts.canonical_locator_digest != binding.canonical_locator_digest
        || query_parts.project_id != binding.project_id
        || query_parts.scene_id != binding.query_scene_id
        || query_parts.authority_revision_token != binding.authority_revision_token
    {
        return Ok(refused(Count::BindingMismatch));
    }

    // Steps 3, for this one Scene. The slot is not asked again.
    let candidates = [binding.association.clone()];
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace,
        query,
        slot: AppendSlot {
            ir_uses_common_slot: false,
            raw_count: 0,
        },
        existing_scene_ids: &existing,
        candidates: &candidates,
    };
    let candidate = match super::judge::scan(conn, &input, path, check, 1)? {
        GraphOnlyScan::Candidate(candidate) => *candidate,
        GraphOnlyScan::NotAppended(_) => return Ok(refused(Count::NoCandidate)),
    };

    // What the declaration and the Scene were when the response was made.
    let title_digest = scene_body_title_digest(&candidate.title)?;
    if candidate.association.scene_id != binding.association.scene_id
        || candidate.scene_incarnation_id != binding.scene_incarnation_id
        || candidate.scope_source_token != binding.scope_source_token
        || candidate.declaration.declaration.declaration_id != binding.declaration_id
        || candidate.declaration.token != binding.declaration_token
        || title_digest != binding.title_digest
    {
        return Ok(refused(Count::BindingMismatch));
    }

    // Step 4, and the result must be the one that was shown.
    let body = match read_body(conn, workspace_parts, query_parts, &candidate, check)? {
        BodyStep::Read(body) => *body,
        BodyStep::Rejected(count) => return Ok(refused(count)),
    };
    if body.facts != binding.body {
        return Ok(refused(Count::BindingMismatch));
    }
    if workspace.is_quarantined() {
        return Ok(refused(Count::Quarantined));
    }
    record(Count::ClickAllowed);
    Ok(GraphOnlyClick::Allowed(GraphSceneRange {
        start_utf16: body.facts.start_utf16,
        end_utf16: body.facts.end_utf16,
    }))
}
