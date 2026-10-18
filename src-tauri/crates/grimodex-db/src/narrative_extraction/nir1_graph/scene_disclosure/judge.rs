//! The scan and the per-candidate judgements that never read the body.
//!
//! Nothing here selects `tree_nodes.content`. Every cell whose size is not
//! fixed is measured with `octet_length` before it is read.

use std::cell::Cell;

use anyhow::Result;
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use grimodex_core::narrative_scene_body_declaration::NarrativeSceneBodySourceV1;
use rusqlite::{params, Connection, OptionalExtension};

use super::counters::{record, Count};
use super::{
    GraphOnlyCandidate, GraphOnlyScan, GraphOnlyScanInput, GraphPathRevalidator, NotAppended,
    QueryParts, WorkspaceParts,
};
use crate::narrative_extraction::nir1_graph::scenes::{
    read_scene_frame_tokens, recheck_scene_pin, validate_scene_scope, SceneJoinBudget,
    ScenePinLocator, SceneScopeExpectation,
};
use crate::narrative_extraction::nir1_graph::Nir1GraphSceneAssociation;
use crate::narrative_extraction::project_scope_authority::load_live_project_scope_authority;
use crate::narrative_extraction::read_narrative_scene_scope;
use crate::narrative_extraction::scene_body_declaration::{
    archived_in_chain, read_scene_body_declaration, scene_body_declaration_binding_mismatches,
    scene_body_declaration_veto_records, scene_body_title_digest, SceneBodyDeclarationCurrentFacts,
    SceneBodyDeclarationRead, SCENE_BODY_TITLE_MAX_BYTES, SCENE_BODY_VETO_MAX_ROWS,
    VETO_ROW_LIMIT_MARKER,
};
use crate::nir1_generation::{classify_store_error, error_chain_contains, Nir1StoreFailure};

/// Rows the scan may charge to one `SceneJoinBudget` (frame tokens and pin
/// rechecks of every candidate together). DR-CB4-9: at most 24 are used by 8
/// candidates.
const JOIN_MAX_ROWS: usize = 32;
/// Bytes the scan may charge to the same budget. DR-CB4-9: about 2.4 KiB are
/// used by 8 candidates; the rest only stops abnormally large cells before
/// they are read.
const JOIN_MAX_BYTES: usize = 64 * 1024;

/// Most veto rows over all candidates of one scan: each candidate may look at
/// the confirmed 512, so 8 candidates look at 4096 at most.
const VETO_QUERY_MAX_ROWS: usize =
    grimodex_core::narrative_nir1::MAX_GRAPH_SCENES * SCENE_BODY_VETO_MAX_ROWS;

enum Verdict {
    Adopt(Box<GraphOnlyCandidate>),
    /// The candidate is not adopted; the scan goes on.
    Skip(Count),
    /// A limit was exceeded: nothing is added and no later candidate is read.
    Stop(Count),
}

struct Judge<'a> {
    conn: &'a Connection,
    workspace: &'a WorkspaceParts,
    workspace_handle: &'a super::GraphDisclosureWorkspace,
    query: &'a QueryParts,
    path: &'a mut dyn GraphPathRevalidator,
    check: &'a mut dyn FnMut() -> Result<()>,
    /// Set when the caller's checkpoint returned an `Err`.
    control_failed: Cell<bool>,
    budget: SceneJoinBudget,
    veto_rows_left: usize,
    authority: Option<NarrativeProjectScopeAuthorityV1>,
}

fn not_appended(count: Count) -> Result<GraphOnlyScan> {
    record(count);
    Ok(GraphOnlyScan::NotAppended(NotAppended))
}

pub(super) fn scan(
    conn: &Connection,
    input: &GraphOnlyScanInput<'_>,
    path: &mut dyn GraphPathRevalidator,
    check: &mut dyn FnMut() -> Result<()>,
    max_candidates: usize,
) -> Result<GraphOnlyScan> {
    // Judgements that need no database read come first.
    if !input.slot.is_open() {
        return not_appended(Count::SlotUnavailable);
    }
    let Some(workspace) = input.workspace.parts() else {
        return not_appended(Count::WorkspaceUnavailable);
    };
    if input.workspace.is_quarantined() {
        return not_appended(Count::Quarantined);
    }
    let Some(query) = input.query.parts() else {
        return not_appended(Count::QueryUnavailable);
    };

    let mut judge = Judge {
        conn,
        workspace,
        workspace_handle: input.workspace,
        query,
        path,
        check,
        control_failed: Cell::new(false),
        budget: SceneJoinBudget::new(JOIN_MAX_ROWS, JOIN_MAX_BYTES),
        veto_rows_left: VETO_QUERY_MAX_ROWS,
        authority: None,
    };
    for association in input.candidates.iter().take(max_candidates) {
        judge.checkpoint()?;
        // A Scene the R+IR result already has keeps its own excerpt; this
        // judgement is not made for it.
        if input.existing_scene_ids.contains(&association.scene_id) {
            continue;
        }
        match judge.judge(association)? {
            Verdict::Adopt(candidate) => {
                record(Count::Adopted);
                return Ok(GraphOnlyScan::Candidate(candidate));
            }
            Verdict::Skip(count) => record(count),
            Verdict::Stop(count) => return not_appended(count),
        }
    }
    not_appended(Count::NoCandidate)
}

fn is_storage_failure(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<rusqlite::Error>() || cause.is::<std::io::Error>())
        || classify_store_error(error, false) != Nir1StoreFailure::Invalid
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.trim() == value
}

impl Judge<'_> {
    fn checkpoint(&mut self) -> Result<()> {
        let result = (self.check)();
        if result.is_err() {
            self.control_failed.set(true);
        }
        result
    }

    /// A failure of a helper: a control or storage failure is returned as it
    /// is, an exceeded limit stops the scan, anything else is a problem of the
    /// candidate's data and the candidate is skipped. The error is dropped in
    /// that case, so what it said about the Scene goes nowhere.
    fn absorb(&self, error: anyhow::Error, count: Count) -> Result<Verdict> {
        if self.control_failed.get() || is_storage_failure(&error) {
            return Err(error);
        }
        if error_chain_contains(&error, "_LIMIT") {
            return Ok(Verdict::Stop(Count::ResourceLimit));
        }
        Ok(Verdict::Skip(count))
    }

    fn authority(&mut self) -> Result<Option<&NarrativeProjectScopeAuthorityV1>> {
        if self.authority.is_none() {
            match load_live_project_scope_authority(
                self.conn,
                &self.query.project_id,
                &self.query.authority_source_key,
            ) {
                Ok(authority) => self.authority = Some(authority),
                Err(error) if is_storage_failure(&error) => return Err(error),
                Err(_) => return Ok(None),
            }
        }
        Ok(self.authority.as_ref())
    }

    fn judge(&mut self, association: &Nir1GraphSceneAssociation) -> Result<Verdict> {
        let conn = self.conn;
        let project = self.query.project_id.as_str();
        let scene = association.scene_id.as_str();
        if !valid_identity(scene) {
            return Ok(Verdict::Skip(Count::FrameMismatch));
        }

        // The Scene is a live, non-archived Scene of the project.
        let title_octets: Option<i64> = conn
            .query_row(
                "SELECT octet_length(title) FROM tree_nodes
                  WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
                params![scene, project],
                |row| row.get(0),
            )
            .optional()?;
        let Some(title_octets) = title_octets else {
            return Ok(Verdict::Skip(Count::SceneNotLive));
        };
        if archived_in_chain(conn, project, scene)? {
            return Ok(Verdict::Skip(Count::SceneNotLive));
        }
        self.checkpoint()?;

        // A1: explicit and resolved, matching the query on the three axes,
        // the holder and the audience, and strictly before the query in the
        // reading order. The declaration relaxes none of it.
        let scope = match read_narrative_scene_scope(conn, project, scene) {
            Ok(read) => read.binding,
            Err(error) => return self.absorb(error, Count::ScopeRejected),
        };
        let (Some(incarnation_id), Some(scope_token)) = (
            association.scene_incarnation_id.as_deref(),
            association.scene_scope_token.as_deref(),
        ) else {
            return Ok(Verdict::Skip(Count::FrameMismatch));
        };
        let query = self.query;
        let (query_rank, candidate_rank) = {
            let Some(authority) = self.authority()? else {
                return Ok(Verdict::Skip(Count::ScopeRejected));
            };
            if authority.source.revision_token != query.authority_revision_token {
                return Ok(Verdict::Stop(Count::AuthorityChanged));
            }
            (
                reading_rank(authority, &query.scene_id),
                reading_rank(authority, scene),
            )
        };
        let (Some(query_rank), Some(candidate_rank)) = (query_rank, candidate_rank) else {
            return Ok(Verdict::Skip(Count::ReadingNotBefore));
        };
        if candidate_rank >= query_rank {
            return Ok(Verdict::Skip(Count::ReadingNotBefore));
        }
        let expectation = SceneScopeExpectation {
            project_id: project,
            scene_id: scene,
            scene_incarnation_id: incarnation_id,
            scope_token,
            timeline: &query.timeline,
            worldline: &query.worldline,
            narrative_layer: &query.narrative_layer,
            knowledge_holder: &query.knowledge_holder,
            audience: &query.audience,
            candidate_reading_rank: candidate_rank,
            query_reading_rank: query_rank,
        };
        if validate_scene_scope(&scope, &expectation).is_err() {
            return Ok(Verdict::Skip(Count::ScopeRejected));
        }

        // The declaration, read from its row.
        let declared = match read_scene_body_declaration(conn, project, scene) {
            Ok(SceneBodyDeclarationRead::Declared(declared)) => declared,
            Ok(_) => return Ok(Verdict::Skip(Count::DeclarationUnavailable)),
            Err(error) => return Err(error),
        };
        self.checkpoint()?;

        // The Scene row's current tokens (no body) and title.
        let frame = {
            let Self {
                check,
                control_failed,
                budget,
                ..
            } = self;
            let mut guarded = || {
                let result = check();
                if result.is_err() {
                    control_failed.set(true);
                }
                result
            };
            match read_scene_frame_tokens(conn, project, scene, budget, &mut guarded, |_| Ok(())) {
                Ok(frame) => frame,
                Err(error) => return self.absorb(error, Count::FrameMismatch),
            }
        };
        let title_fits =
            usize::try_from(title_octets).is_ok_and(|octets| octets <= SCENE_BODY_TITLE_MAX_BYTES);
        if !title_fits {
            return Ok(Verdict::Skip(Count::BindingMismatch));
        }
        let title: String = conn.query_row(
            "SELECT title FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene, project],
            |row| row.get(0),
        )?;
        let title_digest = scene_body_title_digest(&title)?;

        // The binding, against the current values. The body's digests are not
        // known without reading the body, so the declaration's own are put in
        // their place here; the body step compares the digests it reads.
        let bound = &declared.declaration.binding.body_source;
        let facts = SceneBodyDeclarationCurrentFacts {
            project_id: project.to_owned(),
            scene_id: scene.to_owned(),
            scene_incarnation_id: scope.scene_incarnation_id.clone(),
            scope_source_token: scope.source_token.clone(),
            body_source: NarrativeSceneBodySourceV1 {
                source_identity: format!("project:scene:{scene}"),
                source_token: frame.source_token.clone(),
                storage_digest: bound.storage_digest.clone(),
                canonical_digest: bound.canonical_digest.clone(),
                normalizer_version: bound.normalizer_version.clone(),
                utf16_length: bound.utf16_length,
            },
            title_digest,
            workspace_id: self.workspace.workspace_id.clone(),
            canonical_locator_digest: self.workspace.canonical_locator_digest.clone(),
        };
        if !scene_body_declaration_binding_mismatches(&declared.declaration, &facts).is_empty() {
            return Ok(Verdict::Skip(Count::BindingMismatch));
        }
        self.checkpoint()?;

        // Records that already classify the body as secret or as seen from
        // one viewpoint. Looking at the saved body is the body step's.
        let max_rows = self.veto_rows_left.min(SCENE_BODY_VETO_MAX_ROWS);
        match scene_body_declaration_veto_records(conn, project, scene, max_rows) {
            Ok(records) => {
                self.veto_rows_left = self.veto_rows_left.saturating_sub(records.rows_looked_at);
                if records.veto.is_some() {
                    return Ok(Verdict::Skip(Count::Veto));
                }
            }
            Err(error) if error_chain_contains(&error, VETO_ROW_LIMIT_MARKER) => {
                return Ok(Verdict::Stop(Count::ResourceLimit));
            }
            Err(error) => return Err(error),
        }
        self.checkpoint()?;

        // A COMMIT of unknown outcome blocks every disclosure of this
        // workspace until the process restarts.
        if self.workspace_handle.is_quarantined() {
            return Ok(Verdict::Stop(Count::Quarantined));
        }

        // The frame's values are the parent's read.
        let frame_holds = frame.incarnation_id.as_deref() == Some(incarnation_id)
            && frame.incarnation_id.as_deref() == Some(scope.scene_incarnation_id.as_str())
            && frame.scope_token.as_deref() == Some(scope_token)
            && frame.scope_token.as_deref() == Some(scope.source_token.as_str())
            && frame.source_token == association.scene_source_token;
        if !frame_holds {
            return Ok(Verdict::Skip(Count::FrameMismatch));
        }

        // The pin is a locator and must be the exact row the frame saw.
        let pin = ScenePinLocator {
            rowid: association.pin_rowid,
            scene_id: association.scene_id.clone(),
            entry_id: association.pin_entry_id.clone(),
            created_at: association.pin_created_at.clone(),
        };
        let rechecked = {
            let Self {
                check,
                control_failed,
                budget,
                ..
            } = self;
            let mut guarded = || {
                let result = check();
                if result.is_err() {
                    control_failed.set(true);
                }
                result
            };
            match recheck_scene_pin(conn, project, &pin, budget, &mut guarded) {
                Ok(rechecked) => rechecked,
                Err(error) => return self.absorb(error, Count::PinChanged),
            }
        };
        if rechecked.is_none() {
            return Ok(Verdict::Skip(Count::PinChanged));
        }

        // The caller's path revalidation is the last judgement before the
        // body. Only its yes or no is used.
        match self.path.revalidate(conn, association) {
            Ok(true) => {}
            Ok(false) => return Ok(Verdict::Skip(Count::PathRejected)),
            Err(error) => return self.absorb(error, Count::PathRejected),
        }
        self.checkpoint()?;

        Ok(Verdict::Adopt(Box::new(GraphOnlyCandidate {
            scene_id: association.scene_id.clone(),
            title,
            pin,
            scene_incarnation_id: scope.scene_incarnation_id,
            scope_source_token: scope.source_token,
            scene_source_token: frame.source_token,
            declaration: declared,
        })))
    }
}

/// The Scene's reading rank in the authority. None when the authority has no
/// mapping for it, or more than one (ambiguous).
pub(super) fn reading_rank(
    authority: &NarrativeProjectScopeAuthorityV1,
    scene: &str,
) -> Option<u64> {
    let scene_ref = format!("scene:{scene}");
    let mut found = authority
        .mappings
        .iter()
        .filter(|mapping| mapping.scene_ref == scene_ref);
    let first = found.next()?;
    found.next().is_none().then_some(first.reading_rank)
}
