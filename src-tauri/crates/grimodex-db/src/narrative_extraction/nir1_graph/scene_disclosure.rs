//! The parent-side reader of a Graph-only Scene (CB-4, draft `nir1-c-body-
//! disclosure-proposal/4`, "利用時の判定", step 3).
//!
//! A Graph-only target is a Scene that a Graph path reached by an explicit
//! pin and that is not already in the R+IR result. It may fill the common
//! extra slot of Related Scenes only if its author declared its whole body
//! (`scope-storage-authority`) and every judgement below still holds *now*,
//! read afresh from the database in the caller's read transaction.
//!
//! This file is the S1 part: the candidate scan and the judgements that never
//! read the body. The reader
//!
//! - walks the frame's associations in tuple order and stops at the first one
//!   that passes everything (the body of that one is read later, by S2);
//! - reads the declaration from its row (never from the feed or a cache);
//! - writes nothing, keeps no cache, and returns a result that carries no
//!   reason: "no candidate", "an ineligible one" and "a limit was exceeded"
//!   are the same [`NotAppended`], so the answer can never change the Graph's
//!   own state or the R+IR path additions (Mandatory defense 9).
//!
//! Only the Electron Native build compiles it (`native-current-human-capture`);
//! grimodex-mcp never enables that feature, so no MCP tool reaches it.

use std::collections::BTreeSet;
use std::fmt;

use anyhow::{ensure, Result};
use grimodex_core::narrative_scene_scope::NarrativeScopePrincipalV1;
use rusqlite::Connection;

use super::Nir1GraphSceneAssociation;
use crate::narrative_extraction::scene_body_declaration::{
    is_scene_body_declaration_quarantined, StoredSceneBodyDeclaration,
};
use crate::narrative_extraction::{QueryIdentityState, RetrievalQueryContext};
use crate::nir1_generation::history_context::DurableWorkspaceIdentity;
use crate::state::ActiveWorkspaceSnapshot;
use grimodex_core::narrative_nir1::MAX_GRAPH_SCENES;

mod body;
#[cfg(test)]
mod body_tests;
#[cfg(test)]
mod exit_tests;
#[cfg(test)]
mod invalidation_tests;
mod click;
mod counters;
mod eligible;
mod judge;
#[cfg(test)]
mod tests;

/// Raw items of a result from which the common extra slot is taken (draft:
/// "Raw が 8 件未満"). With 8 or more there is no slot to fill.
pub const COMMON_SLOT_RAW_LIMIT: usize = 8;

/// Whether the Related Scenes result still has room for a Graph-only Scene.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppendSlot {
    /// Some R+IR row is of kind `ir`: the IR already uses the common slot.
    /// An empty IR whose result is only Raw does not use it.
    pub ir_uses_common_slot: bool,
    /// Raw items in the result.
    pub raw_count: usize,
}

impl AppendSlot {
    pub(crate) const fn is_open(self) -> bool {
        !self.ir_uses_common_slot && self.raw_count < COMMON_SLOT_RAW_LIMIT
    }
}

/// The plain workspace ID and the canonical locator digest that a declaration
/// is bound to, plus the means to ask whether the workspace is quarantined.
/// Made only from an [`ActiveWorkspaceSnapshot`]; it holds no path.
pub struct GraphDisclosureWorkspace {
    parts: Option<WorkspaceParts>,
}

pub(super) struct WorkspaceParts {
    pub(super) workspace_id: String,
    pub(super) canonical_locator_digest: String,
    identity: DurableWorkspaceIdentity,
}

impl GraphDisclosureWorkspace {
    /// Takes the values from the exact Ready binding the snapshot was captured
    /// with. A snapshot without a Ready binding, or whose canonical locator
    /// could not be determined, gives a workspace without values: the reader
    /// then answers [`NotAppended`] without reading the database.
    pub fn from_snapshot(workspace: &ActiveWorkspaceSnapshot) -> Self {
        let parts = match (
            workspace.live_binding(),
            workspace.durable_workspace_identity(),
        ) {
            (Some(binding), Some(identity)) => Some(WorkspaceParts {
                workspace_id: binding.workspace_id.to_string(),
                canonical_locator_digest: identity.canonical_locator_digest.as_str().to_owned(),
                identity: identity.clone(),
            }),
            _ => None,
        };
        Self { parts }
    }

    /// True while a declaration COMMIT of this workspace had an unknown outcome
    /// in this process. The reader checks it before it reads the database and
    /// again before it adopts a candidate; a caller checks it once more after
    /// its read transaction ended and discards the result when it is true.
    /// A workspace without values is reported as quarantined (nothing may be
    /// disclosed from it).
    pub fn is_quarantined(&self) -> bool {
        self.parts
            .as_ref()
            .is_none_or(|parts| is_scene_body_declaration_quarantined(&parts.identity))
    }

    pub(super) fn parts(&self) -> Option<&WorkspaceParts> {
        self.parts.as_ref()
    }
}

impl fmt::Debug for GraphDisclosureWorkspace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphDisclosureWorkspace")
            .finish_non_exhaustive()
    }
}

/// The query Scene's context, taken from the Native-only
/// [`RetrievalQueryContext`]. It has no reading rank: the reader derives both
/// ranks from one read of the live Scope authority (the query's rank is never
/// the caller's claim).
pub struct GraphDisclosureQuery {
    parts: Option<QueryParts>,
}

pub(super) struct QueryParts {
    pub(super) project_id: String,
    pub(super) scene_id: String,
    pub(super) timeline: String,
    pub(super) worldline: String,
    pub(super) narrative_layer: String,
    pub(super) knowledge_holder: NarrativeScopePrincipalV1,
    pub(super) audience: NarrativeScopePrincipalV1,
    pub(super) authority_source_key: String,
    pub(super) authority_revision_token: String,
}

fn resolved(state: &QueryIdentityState) -> Option<&str> {
    match state {
        QueryIdentityState::Resolved(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

fn principal(state: &QueryIdentityState) -> Option<NarrativeScopePrincipalV1> {
    let value = resolved(state)?;
    if value == "reader" {
        return Some(NarrativeScopePrincipalV1::Reader {});
    }
    value
        .strip_prefix("character:")
        .filter(|reference| !reference.trim().is_empty())
        .map(|reference| NarrativeScopePrincipalV1::Character {
            reference: reference.to_owned(),
        })
}

impl GraphDisclosureQuery {
    /// A query that is not a resolved reading query (axis other than reading,
    /// `allow_secrets`, an axis or principal that is not resolved, a Scope
    /// authority of another key) gives a query without values: the reader
    /// then answers [`NotAppended`] without reading the database.
    pub fn from_retrieval_query_context(context: &RetrievalQueryContext) -> Self {
        let parts = (|| {
            if context.effective_axis != "reading" || context.allow_secrets {
                return None;
            }
            let authority_source_key = format!("project:scope-authority:{}", context.project_id);
            if context.scope_authority_source_key != authority_source_key
                || context.scope_authority_revision_token.trim().is_empty()
                || context.project_id.trim().is_empty()
                || context.query_scene_id.trim().is_empty()
            {
                return None;
            }
            Some(QueryParts {
                project_id: context.project_id.clone(),
                scene_id: context.query_scene_id.clone(),
                timeline: resolved(&context.timeline)?.to_owned(),
                worldline: resolved(&context.worldline)?.to_owned(),
                narrative_layer: resolved(&context.narrative_layer)?.to_owned(),
                knowledge_holder: principal(&context.knowledge_holder)?,
                audience: principal(&context.audience)?,
                authority_source_key,
                authority_revision_token: context.scope_authority_revision_token.clone(),
            })
        })();
        Self { parts }
    }

    pub(super) fn parts(&self) -> Option<&QueryParts> {
        self.parts.as_ref()
    }
}

impl fmt::Debug for GraphDisclosureQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphDisclosureQuery")
            .finish_non_exhaustive()
    }
}

/// The caller's revalidation of the representative path's material binding
/// (DSN §2.3 (b), the existing A2/A3 revalidate). It runs after every other
/// judgement that does not read the body, and before the body is read.
/// `Ok(false)` and `Err` mean the candidate is not adopted. Its answer is the
/// only thing the reader takes from it: the path's proof is a proof about the
/// query Scene and never becomes evidence for the target's body.
pub trait GraphPathRevalidator {
    fn revalidate(
        &mut self,
        conn: &Connection,
        association: &Nir1GraphSceneAssociation,
    ) -> Result<bool>;
}

/// Everything the reader is given about one Related Scenes response.
pub struct GraphOnlyScanInput<'a> {
    pub workspace: &'a GraphDisclosureWorkspace,
    pub query: &'a GraphDisclosureQuery,
    pub slot: AppendSlot,
    /// Scene IDs already in the R+IR result. They are not scanned.
    pub existing_scene_ids: &'a BTreeSet<String>,
    /// The frame's associations in tuple order.
    pub candidates: &'a [Nir1GraphSceneAssociation],
}

impl fmt::Debug for GraphOnlyScanInput<'_> {
    // The Scene IDs of the candidates are not printed.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphOnlyScanInput")
            .finish_non_exhaustive()
    }
}

/// "No Graph-only Scene is added." One value for every reason: no candidate,
/// an ineligible one, a limit exceeded, no free slot, no workspace value, a
/// quarantined workspace. It changes nothing else about the response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NotAppended;

impl NotAppended {
    pub const fn code(self) -> &'static str {
        "graph-scene-not-appended"
    }
}

/// The result of the scan.
#[derive(Debug)]
pub enum GraphOnlyScan {
    /// The first candidate that passed every judgement that does not read the
    /// body. The next step reads its body and may still reject it.
    Candidate(Box<GraphOnlyCandidate>),
    NotAppended(NotAppended),
}

/// A Scene that passed the judgements that do not read the body. It holds the
/// values the body step compares with and is neither serializable nor
/// printable with its contents.
pub struct GraphOnlyCandidate {
    /// The frame's association, kept so a click can be revalidated with the
    /// very same pin and path (it is request-local and never persisted).
    association: Nir1GraphSceneAssociation,
    /// The Scene's current title; its digest equals the declaration's.
    title: String,
    scene_incarnation_id: String,
    scope_source_token: String,
    scene_source_token: String,
    declaration: StoredSceneBodyDeclaration,
}

impl fmt::Debug for GraphOnlyCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphOnlyCandidate")
            .finish_non_exhaustive()
    }
}

/// Scans the frame's associations for the Scene that may fill the common extra
/// slot, using only judgements that do not read the body.
///
/// Call it inside the Related Scenes participant's read transaction, after the
/// Graph's own steps 1 and 2. `conn` must be in a transaction (`Err`
/// otherwise). `check` is the caller's cancel/deadline checkpoint; an `Err`
/// from it, from SQLite or from the path revalidation's storage is returned
/// as is and no partial result is made.
pub fn evaluate_graph_only_append(
    conn: &Connection,
    input: &GraphOnlyScanInput<'_>,
    path: &mut dyn GraphPathRevalidator,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphOnlyScan> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_GRAPH_SCENE_DISCLOSURE_REQUIRES_READ_TRANSACTION"
    );
    judge::scan(conn, input, path, check, MAX_GRAPH_SCENES)
}

pub use self::body::evaluate_graph_only_scene;
pub use self::click::requalify_graph_only_scene_disclosure;
pub use self::eligible::{
    EligibleGraphScene, GraphOnlyClick, GraphOnlySceneBinding, GraphOnlySceneDisclosure,
    GraphSceneRange, GraphSceneRevalidationRefused,
};
