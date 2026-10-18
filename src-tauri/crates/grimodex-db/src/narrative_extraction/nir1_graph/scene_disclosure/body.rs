//! The body step (draft "利用時の判定", step 4) and the result (step 5).
//!
//! Only the one candidate the scan adopted has its body read here, within the
//! K1b limits: the storage and canonical sizes are checked before the body is
//! materialized, the peak before it is parsed. The digests, the normalizer
//! version and the UTF-16 length that were read are compared with the
//! declaration's binding; the veto is the writer's own function; the excerpt is
//! the first non-empty line of the canonical text.

use std::cell::Cell;
#[cfg(test)]
use std::cell::RefCell;

use anyhow::{ensure, Result};
use grimodex_core::narrative_scene_body_declaration::NarrativeSceneBodySourceV1;
use rusqlite::Connection;

use super::counters::{record, Count};
use super::eligible::{BodyFacts, EligibleGraphScene, GraphOnlySceneBinding};
use super::judge::{is_storage_failure, read_title};
use super::{
    evaluate_graph_only_append, GraphDisclosureQuery, GraphDisclosureWorkspace, GraphOnlyCandidate,
    GraphOnlyScan, GraphOnlyScanInput, GraphOnlySceneDisclosure, GraphPathRevalidator, NotAppended,
    QueryParts, WorkspaceParts,
};
use crate::narrative_extraction::nir1_graph::scenes::first_non_empty_anchor;
use crate::narrative_extraction::retrieval_admission::{
    read_retrieval_scene_source_bounded, RetrievalSceneSourceRead,
};
use crate::narrative_extraction::read_narrative_scene_scope;
use crate::narrative_extraction::scene_body_declaration::{
    read_scene_body_declaration, scene_body_declaration_binding_mismatches,
    SceneBodyDeclarationRead, scene_body_declaration_veto,
    scene_body_title_digest, SceneBodyDeclarationCurrentFacts, VetoLimits,
    SCENE_BODY_READ_MAX_BYTES, SCENE_BODY_READ_PEAK_MAX_BYTES, VETO_CONTENT_LIMIT_MARKER,
    VETO_ROW_LIMIT_MARKER,
};
use crate::nir1_generation::error_chain_contains;

// Test hook (like the declaration reader's `CONTENT_READS`): the Scenes whose
// saved body the reader read, in order, so a test can show that only the
// adopted candidate's body is read and that a rejected one stops the query.
#[cfg(test)]
thread_local! {
    static BODY_READS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
pub(super) fn body_reads() -> Vec<String> {
    BODY_READS.with(|reads| reads.borrow().clone())
}

#[cfg(test)]
pub(super) fn reset_body_reads() {
    BODY_READS.with(|reads| reads.borrow_mut().clear());
}

/// What the body step read from the adopted Scene.
pub(super) struct BodyRead {
    pub(super) facts: BodyFacts,
    pub(super) excerpt: String,
}

pub(super) enum BodyStep {
    Read(Box<BodyRead>),
    /// The body step rejected the candidate; only the diagnostic count says
    /// why.
    Rejected(Count),
}

/// A failure of a helper in the body step: a control or storage failure is
/// returned as it is; anything else is a problem of the Scene's data and the
/// candidate is rejected (the error, which may name the Scene, is dropped).
fn absorb(error: anyhow::Error, control_failed: &Cell<bool>) -> Result<BodyStep> {
    if control_failed.get() || is_storage_failure(&error) {
        return Err(error);
    }
    if error_chain_contains(&error, "LIMIT") {
        return Ok(BodyStep::Rejected(Count::ResourceLimit));
    }
    Ok(BodyStep::Rejected(Count::BodyUnreadable))
}

/// Reads and judges the body of the adopted candidate. The same function serves
/// the response and the click.
pub(super) fn read_body(
    conn: &Connection,
    workspace: &WorkspaceParts,
    query: &QueryParts,
    candidate: &GraphOnlyCandidate,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<BodyStep> {
    let project = query.project_id.as_str();
    let scene = candidate.association.scene_id.as_str();
    #[cfg(test)]
    BODY_READS.with(|reads| reads.borrow_mut().push(scene.to_owned()));

    let control_failed = Cell::new(false);
    let mut guarded = || -> Result<()> {
        let result = check();
        if result.is_err() {
            control_failed.set(true);
        }
        result
    };
    guarded()?;

    let source = match read_retrieval_scene_source_bounded(
        conn,
        project,
        scene,
        SCENE_BODY_READ_MAX_BYTES,
        SCENE_BODY_READ_MAX_BYTES,
        &mut guarded,
        &mut |peak| {
            ensure!(
                peak <= SCENE_BODY_READ_PEAK_MAX_BYTES,
                "NIR1_RETRIEVAL_SCENE_SOURCE_PEAK_LIMIT"
            );
            Ok(())
        },
    ) {
        Ok(RetrievalSceneSourceRead::Available(source)) => source,
        Ok(RetrievalSceneSourceRead::Unavailable { .. }) => {
            return Ok(BodyStep::Rejected(Count::BodyUnreadable));
        }
        Err(error) => return absorb(error, &control_failed),
    };
    if source.archived {
        return Ok(BodyStep::Rejected(Count::SceneNotLive));
    }
    if source.canonical_source_text.trim().is_empty() {
        return Ok(BodyStep::Rejected(Count::BodyUnreadable));
    }

    // The digests that were read now, against the declaration. Everything
    // else in the binding (incarnation, tokens, title, workspace) is compared
    // in full here too, so a value that changed since the scan cannot pass.
    let Ok(utf16_length) = u64::try_from(source.query_source.canonical_utf16_length) else {
        return Ok(BodyStep::Rejected(Count::BodyUnreadable));
    };
    let facts = SceneBodyDeclarationCurrentFacts {
        project_id: project.to_owned(),
        scene_id: scene.to_owned(),
        scene_incarnation_id: candidate.scene_incarnation_id.clone(),
        scope_source_token: candidate.scope_source_token.clone(),
        body_source: NarrativeSceneBodySourceV1 {
            source_identity: source.query_source.source_key.clone(),
            source_token: source.query_source.revision_token.clone(),
            storage_digest: source.query_source.storage_digest.clone(),
            canonical_digest: source.query_source.canonical_text_digest.clone(),
            normalizer_version: source.query_source.normalizer_version.to_owned(),
            utf16_length,
        },
        title_digest: scene_body_title_digest(&candidate.title)?,
        workspace_id: workspace.workspace_id.clone(),
        canonical_locator_digest: workspace.canonical_locator_digest.clone(),
    };
    if !scene_body_declaration_binding_mismatches(&candidate.declaration.declaration, &facts)
        .is_empty()
    {
        return Ok(BodyStep::Rejected(Count::BindingMismatch));
    }
    // The scan's token and the body read's token are two reads of the same
    // Scene row in one transaction.
    if source.query_source.revision_token != candidate.scene_source_token {
        return Ok(BodyStep::Rejected(Count::FrameMismatch));
    }
    guarded()?;

    // The writer's own veto, with the saved body's `sceneBeat` POV. The
    // records part ran for this Scene in the scan; the body part is run here,
    // for this one Scene only.
    match scene_body_declaration_veto(conn, project, scene, VetoLimits::DEFAULT) {
        Ok(None) => {}
        Ok(Some(_)) => return Ok(BodyStep::Rejected(Count::Veto)),
        Err(error)
            if error_chain_contains(&error, VETO_ROW_LIMIT_MARKER)
                || error_chain_contains(&error, VETO_CONTENT_LIMIT_MARKER) =>
        {
            return Ok(BodyStep::Rejected(Count::ResourceLimit));
        }
        Err(error) => return absorb(error, &control_failed),
    }
    guarded()?;

    let anchor =
        match first_non_empty_anchor(&source.canonical_source_text, &mut guarded, &mut |bytes| {
            ensure!(
                bytes <= SCENE_BODY_READ_MAX_BYTES,
                "NIR1_GRAPH_SCENE_INPUT_LIMIT"
            );
            Ok(())
        }) {
            Ok(anchor) => anchor,
            Err(error) => return absorb(error, &control_failed),
        };
    guarded()?;

    Ok(BodyStep::Read(Box::new(BodyRead {
        facts: BodyFacts {
            source_token: facts.body_source.source_token,
            storage_digest: facts.body_source.storage_digest,
            canonical_digest: facts.body_source.canonical_digest,
            normalizer_version: facts.body_source.normalizer_version,
            utf16_length,
            excerpt_digest: anchor.digest,
            start_utf16: anchor.start_utf16,
            end_utf16: anchor.end_utf16,
        },
        excerpt: anchor.excerpt,
    })))
}

fn not_appended(count: Count) -> GraphOnlySceneDisclosure {
    record(count);
    GraphOnlySceneDisclosure::NotAppended(NotAppended)
}

/// The whole reader for one Related Scenes response: the scan (step 3), then
/// the body step (step 4) for the one candidate it adopted, then the result
/// (step 5). `Eligible` carries the title, excerpt, range and the request-local
/// binding; everything else is the single [`NotAppended`]. An `Err` is a
/// control (cancel/deadline) or storage failure and carries no partial result.
///
/// Call it in the Related Scenes participant's read transaction, as
/// [`evaluate_graph_only_append`] (whose conditions apply unchanged). After the
/// transaction ended, check [`GraphDisclosureWorkspace::is_quarantined`] once
/// more and discard an `Eligible` when it is true.
pub fn evaluate_graph_only_scene(
    conn: &Connection,
    input: &GraphOnlyScanInput<'_>,
    path: &mut dyn GraphPathRevalidator,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphOnlySceneDisclosure> {
    match evaluate_graph_only_append(conn, input, path, check)? {
        GraphOnlyScan::NotAppended(NotAppended) => {
            Ok(GraphOnlySceneDisclosure::NotAppended(NotAppended))
        }
        GraphOnlyScan::Candidate(candidate) => {
            disclose_graph_only_candidate(conn, input.workspace, input.query, *candidate, check)
        }
    }
}

/// The scan's cached values, read again now. A candidate is only valid in the
/// read transaction that made it; this makes that a property of the code
/// instead of a rule for the caller: a candidate that is carried into another
/// transaction is compared with the declaration, the Scope token and the title
/// as they are at this moment, and any difference rejects it (a revoked or
/// replaced declaration, a changed A1, a changed title).
fn reverify_candidate(
    conn: &Connection,
    project: &str,
    candidate: &GraphOnlyCandidate,
    control_failed: &Cell<bool>,
) -> Result<Option<Count>> {
    let scene = candidate.association.scene_id.as_str();
    let declared = match read_scene_body_declaration(conn, project, scene) {
        Ok(SceneBodyDeclarationRead::Declared(declared)) => declared,
        Ok(_) => return Ok(Some(Count::DeclarationUnavailable)),
        Err(error) => return absorb_count(error, control_failed, Count::DeclarationUnavailable),
    };
    if declared.token != candidate.declaration.token
        || declared.declaration.declaration_id != candidate.declaration.declaration.declaration_id
    {
        return Ok(Some(Count::BindingMismatch));
    }
    let scope = match read_narrative_scene_scope(conn, project, scene) {
        Ok(read) => read.binding,
        Err(error) => return absorb_count(error, control_failed, Count::ScopeRejected),
    };
    if scope.source_token != candidate.scope_source_token
        || scope.scene_incarnation_id != candidate.scene_incarnation_id
    {
        return Ok(Some(Count::BindingMismatch));
    }
    match read_title(conn, project, scene) {
        Ok(Some(title)) if title == candidate.title => Ok(None),
        Ok(_) => Ok(Some(Count::BindingMismatch)),
        Err(error) => absorb_count(error, control_failed, Count::BindingMismatch),
    }
}

fn absorb_count(
    error: anyhow::Error,
    control_failed: &Cell<bool>,
    count: Count,
) -> Result<Option<Count>> {
    if control_failed.get() || is_storage_failure(&error) {
        return Err(error);
    }
    Ok(Some(count))
}

/// The body step for a candidate the scan adopted. Not part of the public
/// surface: the one public way to a body is [`evaluate_graph_only_scene`],
/// which scans and discloses in one read transaction.
pub(super) fn disclose_graph_only_candidate(
    conn: &Connection,
    workspace: &GraphDisclosureWorkspace,
    query: &GraphDisclosureQuery,
    candidate: GraphOnlyCandidate,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphOnlySceneDisclosure> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "NIR1_GRAPH_SCENE_DISCLOSURE_REQUIRES_READ_TRANSACTION"
    );
    let (Some(workspace_parts), Some(query_parts)) = (workspace.parts(), query.parts()) else {
        return Ok(not_appended(Count::WorkspaceUnavailable));
    };
    let control_failed = Cell::new(false);
    let mut guarded = || -> Result<()> {
        let result = check();
        if result.is_err() {
            control_failed.set(true);
        }
        result
    };
    guarded()?;
    if let Some(count) = reverify_candidate(
        conn,
        &query_parts.project_id,
        &candidate,
        &control_failed,
    )? {
        return Ok(not_appended(count));
    }
    let body = match read_body(conn, workspace_parts, query_parts, &candidate, &mut guarded)? {
        BodyStep::Read(body) => *body,
        BodyStep::Rejected(count) => return Ok(not_appended(count)),
    };
    // A COMMIT of unknown outcome that began while the body was read.
    if workspace.is_quarantined() {
        return Ok(not_appended(Count::Quarantined));
    }
    record(Count::Disclosed);
    let declaration = &candidate.declaration;
    Ok(GraphOnlySceneDisclosure::Eligible(Box::new(
        EligibleGraphScene {
            scene_id: candidate.association.scene_id.clone(),
            title: candidate.title.clone(),
            excerpt: body.excerpt,
            binding: GraphOnlySceneBinding {
                association: candidate.association.clone(),
                project_id: query_parts.project_id.clone(),
                query_scene_id: query_parts.scene_id.clone(),
                authority_revision_token: query_parts.authority_revision_token.clone(),
                workspace_id: workspace_parts.workspace_id.clone(),
                canonical_locator_digest: workspace_parts.canonical_locator_digest.clone(),
                scene_incarnation_id: candidate.scene_incarnation_id.clone(),
                scope_source_token: candidate.scope_source_token.clone(),
                declaration_id: declaration.declaration.declaration_id.clone(),
                declaration_token: declaration.token.clone(),
                title_digest: declaration.declaration.binding.title_digest.clone(),
                body: body.facts,
            },
        },
    )))
}
