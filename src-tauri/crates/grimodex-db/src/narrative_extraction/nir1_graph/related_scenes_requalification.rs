//! The parent-side requalification of a worker's Graph for one Related Scenes
//! response (CP-3a S1; draft `nir1-c-body-disclosure-proposal/4`, "利用時の判定"
//! steps 1 to 4, and DSN section 2.3).
//!
//! A worker answers a seed-local Graph: Entities, Relations, the tokens it
//! qualified them under, and up to eight Scenes pinned to the reached
//! Entities. None of that is trusted here. In the caller's participant read
//! transaction this module, in order,
//!
//! 1. reads the seed again with D-final's rule and B's seal, and refuses the
//!    whole Graph if either differs from what the worker answered under;
//! 2. requalifies the representative path of every Scene the response
//!    *displays* (R, plus the one IR Scene the fusion shows) against the A3
//!    result of this snapshot, and the pin that located the Scene. Any
//!    difference refuses the whole Graph: the path additions are
//!    all-or-nothing. The text of an attached path comes from the Revision this
//!    snapshot read, never from the worker;
//! 3. hands the common extra slot to CB-4's reader (`evaluate_graph_only_scene`)
//!    once, with a [`GraphPathRevalidator`] that compares the candidate's path
//!    with the same A3 results (each Revision is evaluated once per call).
//!
//! The Graph-only judgement (3) is the only part with a resource budget of its
//! own ([`GraphOnlyBudget`]: SQLite VM steps and a deadline). Exceeding it adds
//! no Graph-only Scene and changes nothing else: it is a [`NotAppended`], never
//! a failure of the Graph, so a response can not tell a candidate that does not
//! exist from one that was too costly to judge (Mandatory defense 8, 9; DR-CB4-23).
//! Only a real cancellation (the caller's checkpoint failing) is an `Err`.
//!
//! The module writes nothing, keeps nothing after it returns, and its output
//! types can be neither serialized nor printed with their contents.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Result};
use grimodex_core::narrative_nir1::MAX_GRAPH_SCENES;
use rusqlite::Connection;

use super::scenes::{recheck_scene_pin, SceneJoinBudget, ScenePinLocator};
use super::worker_projection::Nir1GraphProjection;
use super::{
    evaluate_graph_only_scene, read_nir1_graph_seal, AppendSlot, GraphDisclosureQuery,
    GraphDisclosureWorkspace, GraphOnlyScanInput, GraphOnlySceneDisclosure, GraphPathRevalidator,
    Nir1GraphEdge, Nir1GraphSceneAssociation, NotAppended,
};
use crate::narrative_extraction::nir1_capacity;
use crate::narrative_extraction::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure_for_graph, Nir1EntityRelationDisclosure,
    Nir1EntityRelationDisclosureRead, Nir1ProjectReads,
};
use crate::narrative_extraction::nir1_packing::graph_candidates::{
    read_nir1_graph_seed_in_tx, tokens_match_current, CurrentGraphTokens,
    Nir1GraphCandidateBinding, Nir1GraphSeedRead,
};
use crate::narrative_extraction::source_revision::{
    ValidationTerminated, ValidationTerminationReason,
};
use crate::narrative_maintenance_connection::ParticipantSqlOperationBudget;
use crate::nir1_generation::{classify_store_error, error_chain_contains, Nir1StoreFailure};
use crate::state::ActiveWorkspaceSnapshot;

#[cfg(test)]
mod tests;

/// Edges on the representative path of one Scene (K1: two hops).
const MAX_PATH_EDGES: usize = 2;

/// The most text (IDs, relation types, labels and quotes, in bytes) that the
/// path additions of one response may carry. A typed Revision is bounded only
/// as a whole (its A2 payload), so the sum over up to 8 Scenes and 16 edges
/// needs a bound of its own; exceeding it refuses the whole Graph (the path
/// additions are all-or-nothing), never one Scene's path. DR-CP3A-5.
pub const ATTACHMENT_TEXT_MAX_BYTES: usize = 256 * 1024;

/// Rows and bytes the pin rechecks of the displayed Scenes may charge to one
/// join budget (8 Scenes, one pin row each; the byte bound only stops an
/// abnormally large cell before it is read).
const PIN_RECHECK_MAX_ROWS: usize = 2 * MAX_GRAPH_SCENES;
const PIN_RECHECK_MAX_BYTES: usize = 64 * 1024;

/// The default VM-step budget of the Graph-only judgement: the same count the
/// Graph query itself is held to (`QUERY_SQL_STEPS`, for the whole A2/A3 of up
/// to 512 edges), so the judgement of one candidate, which evaluates at most
/// the two Revisions of its path, is never allowed more than the query that
/// built the Graph. DR-CP3A-4 records the measurements.
pub const GRAPH_ONLY_VM_STEPS: u64 = super::QUERY_SQL_STEPS;

/// The budget of the Graph-only judgement of one response (step 3 and the
/// body step): SQLite VM steps counted exactly (the progress handler runs at
/// every VM instruction, as the Graph query's own budget does), and a
/// deadline. Exceeding either adds no Graph-only Scene; it does not fail the
/// Graph (DR-CP3A-4, DR-CP3A-5).
///
/// It is shared by `Clone`: the count is read from any copy.
#[derive(Clone)]
pub struct GraphOnlyBudget {
    max_vm_steps: u64,
    deadline: Option<Instant>,
    used: Arc<AtomicU64>,
}

impl GraphOnlyBudget {
    /// A budget of `max_vm_steps` SQLite VM instructions and an optional
    /// deadline. The deadline is the caller's: it is *not* the transaction's
    /// (a transaction deadline is a real timeout of the Graph).
    pub fn new(max_vm_steps: u64, deadline: Option<Instant>) -> Self {
        Self {
            max_vm_steps,
            deadline,
            used: Arc::new(AtomicU64::new(0)),
        }
    }

    /// The default step budget ([`GRAPH_ONLY_VM_STEPS`]) with the caller's
    /// deadline.
    pub fn standard(deadline: Option<Instant>) -> Self {
        Self::new(GRAPH_ONLY_VM_STEPS, deadline)
    }

    /// VM steps the Graph-only judgement has used so far.
    pub fn vm_steps_used(&self) -> u64 {
        self.used.load(Ordering::Relaxed)
    }

    fn expired(&self) -> bool {
        self.used.load(Ordering::Relaxed) > self.max_vm_steps
            || self.deadline.is_some_and(|deadline| now() >= deadline)
    }
}

impl fmt::Debug for GraphOnlyBudget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphOnlyBudget")
            .field("max_vm_steps", &self.max_vm_steps)
            .field("vm_steps_used", &self.vm_steps_used())
            .finish_non_exhaustive()
    }
}

#[cfg(not(test))]
fn now() -> Instant {
    Instant::now()
}

#[cfg(test)]
thread_local! {
    /// The clock of this module's deadline checks, settable by a test so a
    /// deadline boundary is exact.
    pub(super) static TEST_NOW: Cell<Option<Instant>> = const { Cell::new(None) };
}

#[cfg(not(test))]
const fn text_limit() -> usize {
    ATTACHMENT_TEXT_MAX_BYTES
}

#[cfg(test)]
thread_local! {
    /// A smaller text limit, settable by a test so the limit's boundary is
    /// exact without a Revision of 256 KiB.
    pub(super) static TEST_TEXT_LIMIT: Cell<Option<usize>> = const { Cell::new(None) };
}

#[cfg(test)]
fn text_limit() -> usize {
    TEST_TEXT_LIMIT
        .with(Cell::get)
        .unwrap_or(ATTACHMENT_TEXT_MAX_BYTES)
}

#[cfg(test)]
thread_local! {
    /// The Revisions evaluated by A3 in this thread, in order (a Revision is
    /// evaluated once per requalification).
    pub(super) static EVALUATED: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn now() -> Instant {
    TEST_NOW.with(Cell::get).unwrap_or_else(Instant::now)
}

/// Why the whole Graph contributes nothing to this response. The set is closed
/// and none of them is about a Graph-only candidate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphRequalificationDrop {
    /// The Graph was made for another project or another query Scene.
    ProjectOrSceneMismatch,
    /// The seed rule, read again in this snapshot, names another Entity (or
    /// none, or one too large) than the one the Graph was asked for.
    SeedChanged,
    /// B has no current seal in this snapshot.
    SealUnavailable,
    /// B is sealed at another generation than the one the worker answered
    /// under.
    SealMismatch,
    /// A displayed Scene's path no longer holds: a token, the Revision, the
    /// edge or the pin differs from this snapshot's, or the frame's
    /// association is malformed.
    PathNotCurrent,
    /// The path additions exceed [`ATTACHMENT_TEXT_MAX_BYTES`] or the pin
    /// recheck's join budget.
    AttachmentLimit,
}

impl GraphRequalificationDrop {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProjectOrSceneMismatch => "project-or-scene-mismatch",
            Self::SeedChanged => "seed-changed",
            Self::SealUnavailable => "seal-unavailable",
            Self::SealMismatch => "seal-mismatch",
            Self::PathNotCurrent => "path-not-current",
            Self::AttachmentLimit => "attachment-limit",
        }
    }
}

/// An Entity on a path: its ID and label, from the Revision this snapshot read.
#[derive(Clone, Eq, PartialEq)]
pub struct GraphPathEntity {
    pub entity_id: String,
    pub label: String,
}

/// One quoted Evidence of a Relation, from the Revision this snapshot read.
#[derive(Clone, Eq, PartialEq)]
pub struct GraphPathEvidence {
    pub evidence_id: String,
    pub quote: String,
}

/// One Relation of a path with its endpoints and Evidence.
#[derive(Clone, Eq, PartialEq)]
pub struct GraphPathEdge {
    pub edge_id: String,
    pub relation_type: String,
    pub directionality: String,
    pub from: GraphPathEntity,
    pub to: GraphPathEntity,
    pub evidence: Vec<GraphPathEvidence>,
}

/// The path that connects the seed to a displayed Scene: one or two edges.
#[derive(Clone, Eq, PartialEq)]
pub struct GraphPathAttachment {
    pub scene_id: String,
    pub hop: u8,
    pub edges: Vec<GraphPathEdge>,
}

macro_rules! hide_contents {
    ($($type:ident),+) => {$(
        impl fmt::Debug for $type {
            // Labels, quotes and IDs of the author's material are not printed.
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.debug_struct(stringify!($type)).finish_non_exhaustive()
            }
        }
    )+};
}
hide_contents!(
    GraphPathEntity,
    GraphPathEvidence,
    GraphPathEdge,
    GraphPathAttachment
);

/// What survived: the path additions of the displayed Scenes (tuple order),
/// and the Graph-only answer.
#[derive(Debug)]
pub struct QualifiedGraphForRelatedScenes {
    pub attachments: Vec<GraphPathAttachment>,
    pub graph_only: GraphOnlySceneDisclosure,
}

#[derive(Debug)]
pub enum GraphRequalification {
    /// The whole Graph contributes nothing.
    Dropped(GraphRequalificationDrop),
    Qualified(Box<QualifiedGraphForRelatedScenes>),
}

/// Everything the requalification needs. The projection lends its identity,
/// tokens and associations; its text is never read.
pub struct GraphRequalificationInput<'a> {
    pub project_id: &'a str,
    pub query_scene_id: &'a str,
    pub projection: &'a Nir1GraphProjection,
    /// The Scenes the response displays: R, plus the one IR Scene the fusion
    /// shows when Raw has fewer than eight (DSN 2.3: an association that is
    /// not adopted is not read again). They are the targets of the path
    /// additions and are not Graph-only candidates.
    pub displayed_scene_ids: &'a BTreeSet<String>,
    pub slot: AppendSlot,
    pub workspace: &'a GraphDisclosureWorkspace,
    pub query: &'a GraphDisclosureQuery,
    pub graph_only_budget: &'a GraphOnlyBudget,
}

impl fmt::Debug for GraphRequalificationInput<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphRequalificationInput")
            .finish_non_exhaustive()
    }
}

/// Opens the participant's read transaction for a requalification with the
/// caller's SQL budget: its stop flag, deadline and busy-wait allowance. This
/// is the transaction-level budget (a real cancel or timeout of the whole
/// read); the Graph-only judgement's own budget is [`GraphOnlyBudget`].
///
/// A thin public wrapper over the crate's bounded participant read, in the
/// style of `read_nir1_graph_seed`, so the Native caller can not open a
/// requalification without a budget.
pub fn with_graph_requalification_read<T>(
    workspace: &ActiveWorkspaceSnapshot,
    budget: ParticipantSqlOperationBudget,
    operation: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    workspace.db().with_participant_read_transaction_bounded(
        workspace.participant(),
        budget,
        operation,
    )
}

/// The signal the Graph-only judgement's checkpoint raises when its own budget
/// is exceeded. It never leaves this module.
#[derive(Debug)]
struct GraphOnlyBudgetExceeded;

impl fmt::Display for GraphOnlyBudgetExceeded {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NIR1_GRAPH_ONLY_BUDGET_EXCEEDED")
    }
}

impl std::error::Error for GraphOnlyBudgetExceeded {}

fn is_sqlite_interrupt(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(failure, _))
                if failure.code == rusqlite::ErrorCode::OperationInterrupted
        )
    })
}

/// The owner's own stop, polled from Rust work (`check_active_work`), reads as
/// a typed `Cancelled` whichever callback of the composed progress owner
/// raised it.
fn is_polled_stop(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ValidationTerminated>()
        .is_some_and(|terminated| terminated.reason == ValidationTerminationReason::Cancelled)
}

/// A failure of storage or control that is not a problem of one Revision's
/// data: it is returned as an `Err`, never absorbed.
fn is_hard_failure(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.is::<ValidationTerminated>()
            || cause.is::<std::io::Error>()
            || cause
                .downcast_ref::<rusqlite::Error>()
                .is_some_and(|sqlite| {
                    !matches!(
                        sqlite,
                        rusqlite::Error::FromSqlConversionFailure(..)
                            | rusqlite::Error::InvalidColumnType(..)
                            | rusqlite::Error::IntegralValueOutOfRange(..)
                            | rusqlite::Error::Utf8Error(..)
                    )
                })
    }) || classify_store_error(error, false) != Nir1StoreFailure::Invalid
}

/// What this snapshot derived for a Revision: the tokens the worker's frame is
/// compared with, the Relations it has, and the text of the Relations a
/// displayed Scene's path uses.
struct RevisionCurrent {
    revision_id: String,
    decision_id: String,
    decision_token: String,
    freshness_token: String,
    scope_authority_revision: String,
    query_scene_id: String,
    query_scene_source_token: String,
    query_scene_scope_token: String,
    query_scene_incarnation_id: String,
    reveal_state_token: String,
    relation_ids: HashSet<String>,
    edges: HashMap<String, GraphPathEdge>,
}

impl RevisionCurrent {
    fn tokens(&self) -> CurrentGraphTokens<'_> {
        CurrentGraphTokens {
            revision_id: &self.revision_id,
            decision_id: &self.decision_id,
            decision_token: &self.decision_token,
            freshness_token: &self.freshness_token,
            scope_authority_revision: &self.scope_authority_revision,
            query_scene_id: &self.query_scene_id,
            query_scene_source_token: &self.query_scene_source_token,
            query_scene_scope_token: &self.query_scene_scope_token,
            query_scene_incarnation_id: &self.query_scene_incarnation_id,
            reveal_state_token: &self.reveal_state_token,
        }
    }
}

/// The text of the path additions is charged as it is read; the sum is bounded
/// before any of it is copied.
struct TextBudget {
    used: Cell<usize>,
}

impl TextBudget {
    fn admit(&self, bytes: usize) -> bool {
        let total = self.used.get().saturating_add(bytes);
        self.used.set(total);
        total <= text_limit()
    }
}

enum EdgeText {
    Edge(Box<GraphPathEdge>),
    /// The Revision this snapshot read does not hold the Relation's text
    /// together (an Entity or Evidence is missing).
    Inconsistent,
    OverLimit,
}

fn edge_text(
    revision: &Nir1EntityRelationDisclosure,
    edge_id: &str,
    text: &TextBudget,
) -> EdgeText {
    let bundle = &revision.revision.bundle;
    let Some(relation) = bundle
        .relations
        .iter()
        .find(|relation| relation.edge_id == edge_id)
    else {
        return EdgeText::Inconsistent;
    };
    let entity = |entity_id: &str| {
        bundle
            .entities
            .iter()
            .find(|entity| entity.entity_id == entity_id)
    };
    let (Some(from), Some(to)) = (
        entity(&relation.from_entity_id),
        entity(&relation.to_entity_id),
    ) else {
        return EdgeText::Inconsistent;
    };
    let evidence_set = &revision.revision.material_basis.evidence_set;
    let mut evidence = Vec::with_capacity(relation.evidence_ids.len());
    for evidence_id in &relation.evidence_ids {
        let Some(entry) = evidence_set
            .iter()
            .find(|entry| &entry.evidence_ref == evidence_id)
        else {
            return EdgeText::Inconsistent;
        };
        evidence.push(entry);
    }
    if evidence.is_empty() {
        return EdgeText::Inconsistent;
    }
    // Charge every byte that will be copied before copying any of it.
    let bytes = relation
        .edge_id
        .len()
        .saturating_add(relation.relation_type.len())
        .saturating_add(relation.directionality.len())
        .saturating_add(from.entity_id.len())
        .saturating_add(from.label.len())
        .saturating_add(to.entity_id.len())
        .saturating_add(to.label.len())
        .saturating_add(
            evidence
                .iter()
                .map(|entry| entry.evidence_ref.len().saturating_add(entry.quote.len()))
                .fold(0usize, usize::saturating_add),
        );
    if !text.admit(bytes) {
        return EdgeText::OverLimit;
    }
    EdgeText::Edge(Box::new(GraphPathEdge {
        edge_id: relation.edge_id.clone(),
        relation_type: relation.relation_type.clone(),
        directionality: relation.directionality.clone(),
        from: GraphPathEntity {
            entity_id: from.entity_id.clone(),
            label: from.label.clone(),
        },
        to: GraphPathEntity {
            entity_id: to.entity_id.clone(),
            label: to.label.clone(),
        },
        evidence: evidence
            .into_iter()
            .map(|entry| GraphPathEvidence {
                evidence_id: entry.evidence_ref.clone(),
                quote: entry.quote.clone(),
            })
            .collect(),
    }))
}

/// A3 of this snapshot for the Revisions a Graph names, each evaluated once
/// per requalification (the project-level reads are shared). The evaluation is
/// the Graph's own (`evaluate_nir1_entity_relation_disclosure_for_graph`, with
/// the Decision read for who approved it only): it is the one that made the
/// worker's tokens, so equal inputs give equal tokens (DR-CP3A-6).
struct Evaluator<'a> {
    project_id: &'a str,
    query_scene_id: &'a str,
    reads: Option<Nir1ProjectReads>,
    cache: HashMap<String, Option<Arc<RevisionCurrent>>>,
    text: TextBudget,
    /// A Revision whose Relation text was over the limit or inconsistent.
    text_failure: Option<GraphRequalificationDrop>,
}

impl<'a> Evaluator<'a> {
    fn new(project_id: &'a str, query_scene_id: &'a str) -> Self {
        Self {
            project_id,
            query_scene_id,
            reads: None,
            cache: HashMap::new(),
            text: TextBudget { used: Cell::new(0) },
            text_failure: None,
        }
    }

    /// The current state of `revision_id`, evaluated the first time it is
    /// asked for. `text_edges` are the Relations whose text a path addition
    /// needs; they are read only at that first evaluation (the additions are
    /// made before the Graph-only judgement asks for any Revision).
    fn current(
        &mut self,
        conn: &Connection,
        revision_id: &str,
        text_edges: &[&str],
    ) -> Result<Option<Arc<RevisionCurrent>>> {
        if let Some(hit) = self.cache.get(revision_id) {
            return Ok(hit.clone());
        }
        if self.reads.is_none() {
            self.reads = Some(Nir1ProjectReads::load(
                conn,
                self.project_id,
                self.query_scene_id,
            )?);
        }
        #[cfg(test)]
        EVALUATED.with(|log| log.borrow_mut().push(revision_id.to_owned()));
        let read = evaluate_nir1_entity_relation_disclosure_for_graph(
            conn,
            self.project_id,
            revision_id,
            self.query_scene_id,
            self.reads.as_ref(),
        )?;
        let current = match read {
            Nir1EntityRelationDisclosureRead::Eligible(disclosure) => {
                self.derive(&disclosure, revision_id, text_edges)
            }
            Nir1EntityRelationDisclosureRead::Unavailable { .. } => None,
        };
        self.cache.insert(revision_id.to_owned(), current.clone());
        Ok(current)
    }

    fn derive(
        &mut self,
        disclosure: &Nir1EntityRelationDisclosure,
        revision_id: &str,
        text_edges: &[&str],
    ) -> Option<Arc<RevisionCurrent>> {
        let revision = &disclosure.revision;
        if revision.revision_id != revision_id {
            return None;
        }
        let decision_id = revision.decision.as_ref()?.id().to_owned();
        let mut edges = HashMap::with_capacity(text_edges.len());
        for edge_id in text_edges {
            match edge_text(disclosure, edge_id, &self.text) {
                EdgeText::Edge(edge) => {
                    edges.insert((*edge_id).to_owned(), *edge);
                }
                EdgeText::Inconsistent => {
                    self.text_failure
                        .get_or_insert(GraphRequalificationDrop::PathNotCurrent);
                    return None;
                }
                EdgeText::OverLimit => {
                    self.text_failure = Some(GraphRequalificationDrop::AttachmentLimit);
                    return None;
                }
            }
        }
        Some(Arc::new(RevisionCurrent {
            revision_id: revision.revision_id.clone(),
            decision_id,
            decision_token: disclosure.decision_token.clone(),
            freshness_token: disclosure.freshness_token.clone(),
            scope_authority_revision: disclosure.scope_authority_revision.clone(),
            query_scene_id: disclosure.query_scene_id.clone(),
            query_scene_source_token: disclosure.query_scene_source_token.clone(),
            query_scene_scope_token: disclosure.query_scene_scope_token.clone(),
            query_scene_incarnation_id: disclosure.query_scene_incarnation_id.clone(),
            reveal_state_token: disclosure.reveal_state_token.clone(),
            relation_ids: revision
                .bundle
                .relations
                .iter()
                .map(|relation| relation.edge_id.clone())
                .collect(),
            edges,
        }))
    }
}

/// The projection's edges on one Scene's representative path, or `None` when
/// the association is malformed (not 1 or 2 edges, hop differing from the
/// count, an index outside the frame, or a pin that is not at the path's end).
fn path_edges<'p>(
    projection: &'p Nir1GraphProjection,
    association: &Nir1GraphSceneAssociation,
) -> Option<Vec<&'p Nir1GraphEdge>> {
    let indices = &association.path_edge_indices;
    if indices.is_empty()
        || indices.len() > MAX_PATH_EDGES
        || usize::from(association.path_hop) != indices.len()
    {
        return None;
    }
    let edges = indices
        .iter()
        .map(|index| projection.graph.edges.get(usize::from(*index)))
        .collect::<Option<Vec<_>>>()?;
    // The pin locates an Entity the path reached: an endpoint of its last edge.
    let last = edges.last()?;
    let ends_at_pin = last.from.entity_id == association.pin_entry_id
        || last.to.entity_id == association.pin_entry_id;
    ends_at_pin.then_some(edges)
}

/// Whether a worker's edge is still what this snapshot derives.
fn edge_holds(
    projection: &Nir1GraphProjection,
    query_scene_id: &str,
    edge: &Nir1GraphEdge,
    current: &RevisionCurrent,
) -> bool {
    tokens_match_current(
        &Nir1GraphCandidateBinding::from(&*edge.binding),
        &current.tokens(),
        projection.scope_revision.as_deref(),
        query_scene_id,
    ) && current.relation_ids.contains(&edge.relation.edge_id)
}

/// The path of a Graph-only candidate, compared with this snapshot's A3
/// results (shared with the path additions: a Revision both need is evaluated
/// once).
struct PathRevalidator<'a, 'e> {
    evaluator: &'e RefCell<Evaluator<'a>>,
    projection: &'a Nir1GraphProjection,
    query_scene_id: &'a str,
}

impl GraphPathRevalidator for PathRevalidator<'_, '_> {
    fn revalidate(
        &mut self,
        conn: &Connection,
        association: &Nir1GraphSceneAssociation,
    ) -> Result<bool> {
        let Some(edges) = path_edges(self.projection, association) else {
            return Ok(false);
        };
        for edge in edges {
            let current =
                self.evaluator
                    .borrow_mut()
                    .current(conn, &edge.binding.revision_id, &[])?;
            let Some(current) = current else {
                return Ok(false);
            };
            if !edge_holds(self.projection, self.query_scene_id, edge, &current) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Requalifies a worker's Graph for one Related Scenes response. Call it in
/// the participant's read transaction ([`with_graph_requalification_read`]);
/// `conn` must be in a transaction. `check` is the caller's cancel/deadline
/// checkpoint: an `Err` from it, from SQLite or from storage is returned and
/// no partial result is made. Everything the Graph can not vouch for is a
/// [`GraphRequalification::Dropped`] with a closed reason; a Graph-only
/// candidate that is absent, ineligible or too costly to judge is
/// `graph_only: NotAppended` and changes nothing else.
///
/// After the transaction ended, check
/// [`GraphDisclosureWorkspace::is_quarantined`] once more and drop an
/// `Eligible` when it is true (DR-CB4-12 (4)).
pub fn requalify_graph_for_related_scenes(
    conn: &Connection,
    input: &GraphRequalificationInput<'_>,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphRequalification> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "NIR1_GRAPH_REQUALIFICATION_REQUIRES_READ_TRANSACTION"
    );
    let projection = input.projection;
    let dropped = |reason| Ok(GraphRequalification::Dropped(reason));

    // The Graph was made for this project and this query Scene.
    if projection.project_id != input.project_id
        || projection.query_scene_id != input.query_scene_id
    {
        return dropped(GraphRequalificationDrop::ProjectOrSceneMismatch);
    }

    // Step 1: the seed rule and B's seal, as this snapshot reads them.
    check()?;
    let seed = read_nir1_graph_seed_in_tx(conn, input.project_id, input.query_scene_id)?;
    check()?;
    if seed != Nir1GraphSeedRead::Pinned(projection.graph.seed_entity_id.clone()) {
        return dropped(GraphRequalificationDrop::SeedChanged);
    }
    let Some(seal) = read_nir1_graph_seal(conn, input.project_id)? else {
        return dropped(GraphRequalificationDrop::SealUnavailable);
    };
    check()?;
    if seal.generation != projection.graph.generation {
        return dropped(GraphRequalificationDrop::SealMismatch);
    }

    let evaluator = RefCell::new(Evaluator::new(input.project_id, input.query_scene_id));

    // Step 2: the path of every displayed Scene, all or nothing.
    let attachments = match attach_paths(conn, input, &evaluator, check)? {
        Ok(attachments) => attachments,
        Err(reason) => return dropped(reason),
    };

    // Steps 3 and 4: the common extra slot, judged once, under its own budget.
    let graph_only = graph_only(conn, input, &evaluator, check)?;
    Ok(GraphRequalification::Qualified(Box::new(
        QualifiedGraphForRelatedScenes {
            attachments,
            graph_only,
        },
    )))
}

/// A displayed Scene with its association and the edges of its path.
struct Target<'p> {
    association: &'p Nir1GraphSceneAssociation,
    edges: Vec<&'p Nir1GraphEdge>,
}

fn attach_paths(
    conn: &Connection,
    input: &GraphRequalificationInput<'_>,
    evaluator: &RefCell<Evaluator<'_>>,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<std::result::Result<Vec<GraphPathAttachment>, GraphRequalificationDrop>> {
    let projection = input.projection;
    // A failure of the caller's checkpoint is a cancel: it is never absorbed
    // as a problem of one Scene's pin.
    let control_failed = Cell::new(false);
    let mut check = || -> Result<()> {
        let result = check();
        if result.is_err() {
            control_failed.set(true);
        }
        result
    };
    let mut targets = Vec::new();
    for association in projection
        .graph
        .scenes
        .iter()
        .take(MAX_GRAPH_SCENES)
        .filter(|association| input.displayed_scene_ids.contains(&association.scene_id))
    {
        let Some(edges) = path_edges(projection, association) else {
            return Ok(Err(GraphRequalificationDrop::PathNotCurrent));
        };
        targets.push(Target { association, edges });
    }

    // Every Revision a target's path names, in first-named order, with the
    // Relations whose text is needed.
    let mut revision_order = Vec::<&str>::new();
    let mut wanted = HashMap::<&str, Vec<&str>>::new();
    for target in &targets {
        for edge in &target.edges {
            let revision_id = edge.binding.revision_id.as_str();
            let edges = wanted.entry(revision_id).or_insert_with(|| {
                revision_order.push(revision_id);
                Vec::new()
            });
            if !edges.contains(&edge.relation.edge_id.as_str()) {
                edges.push(edge.relation.edge_id.as_str());
            }
        }
    }
    for revision_id in revision_order {
        check()?;
        let current = evaluator
            .borrow_mut()
            .current(conn, revision_id, &wanted[revision_id])?;
        if current.is_none() {
            let failure = evaluator.borrow().text_failure;
            return Ok(Err(
                failure.unwrap_or(GraphRequalificationDrop::PathNotCurrent)
            ));
        }
    }

    let mut join_budget = SceneJoinBudget::new(PIN_RECHECK_MAX_ROWS, PIN_RECHECK_MAX_BYTES);
    let mut attachments = Vec::with_capacity(targets.len());
    for target in targets {
        let association = target.association;
        let mut edges = Vec::with_capacity(target.edges.len());
        for edge in &target.edges {
            check()?;
            let current = evaluator
                .borrow_mut()
                .current(conn, &edge.binding.revision_id, &[])?;
            let Some(current) = current else {
                return Ok(Err(GraphRequalificationDrop::PathNotCurrent));
            };
            if !edge_holds(projection, input.query_scene_id, edge, &current) {
                return Ok(Err(GraphRequalificationDrop::PathNotCurrent));
            }
            let Some(text) = current.edges.get(&edge.relation.edge_id) else {
                return Ok(Err(GraphRequalificationDrop::PathNotCurrent));
            };
            edges.push(text.clone());
        }
        // The pin that located the Scene is the exact row the frame saw.
        let pin = ScenePinLocator {
            rowid: association.pin_rowid,
            scene_id: association.scene_id.clone(),
            entry_id: association.pin_entry_id.clone(),
            created_at: association.pin_created_at.clone(),
        };
        let rechecked =
            match recheck_scene_pin(conn, input.project_id, &pin, &mut join_budget, &mut check) {
                Ok(rechecked) => rechecked,
                Err(error) if control_failed.get() || is_hard_failure(&error) => return Err(error),
                Err(error) if error_chain_contains(&error, "_LIMIT") => {
                    return Ok(Err(GraphRequalificationDrop::AttachmentLimit));
                }
                Err(_) => return Ok(Err(GraphRequalificationDrop::PathNotCurrent)),
            };
        if rechecked.is_none() {
            return Ok(Err(GraphRequalificationDrop::PathNotCurrent));
        }
        attachments.push(GraphPathAttachment {
            scene_id: association.scene_id.clone(),
            hop: association.path_hop,
            edges,
        });
    }
    Ok(Ok(attachments))
}

fn graph_only<'a>(
    conn: &Connection,
    input: &GraphRequalificationInput<'a>,
    evaluator: &RefCell<Evaluator<'a>>,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphOnlySceneDisclosure> {
    let budget = input.graph_only_budget;
    let scan_input = GraphOnlyScanInput {
        workspace: input.workspace,
        query: input.query,
        slot: input.slot,
        existing_scene_ids: input.displayed_scene_ids,
        candidates: &input.projection.graph.scenes,
    };
    let mut revalidator = PathRevalidator {
        evaluator,
        projection: input.projection,
        query_scene_id: input.query_scene_id,
    };

    // The reader only reads when the slot is open; a closed slot installs
    // nothing and reads nothing.
    if !input.slot.is_open() {
        return evaluate_graph_only_scene(conn, &scan_input, &mut revalidator, check);
    }

    // The judgement's SQL budget is a progress owner nested in the
    // participant's: it stops SQLite when the budget is exceeded and says
    // nothing else, so the participant's own stop (a real cancel) stays
    // distinguishable.
    let exceeded = Arc::new(AtomicBool::new(false));
    let restore = {
        let used = Arc::clone(&budget.used);
        let exceeded = Arc::clone(&exceeded);
        let max_vm_steps = budget.max_vm_steps;
        let deadline = budget.deadline;
        nir1_capacity::push_progress_owner(conn, 1, move || {
            let steps = used.fetch_add(1, Ordering::Relaxed).saturating_add(1);
            // The clock is read every 1024 steps; the checkpoints below read it
            // at every statement boundary.
            let late = steps & 1023 == 0 && deadline.is_some_and(|deadline| now() >= deadline);
            if steps > max_vm_steps || late {
                exceeded.store(true, Ordering::Release);
                true
            } else {
                false
            }
        })?
    };
    let result = {
        let mut guarded = || -> Result<()> {
            check()?;
            if exceeded.load(Ordering::Acquire) || budget.expired() {
                exceeded.store(true, Ordering::Release);
                return Err(anyhow::Error::new(GraphOnlyBudgetExceeded));
            }
            Ok(())
        };
        evaluate_graph_only_scene(conn, &scan_input, &mut revalidator, &mut guarded)
    };
    if restore.restore(conn).is_err() {
        // The connection's progress owner could not be put back: nothing more
        // may run on it.
        return Err(anyhow!(
            "NIR1_GRAPH_REQUALIFICATION_PROGRESS_RESTORE_FAILED"
        ));
    }

    let over_budget = exceeded.load(Ordering::Acquire);
    match result {
        Ok(_) if over_budget => {
            check()?;
            Ok(GraphOnlySceneDisclosure::NotAppended(NotAppended))
        }
        Ok(disclosure) => Ok(disclosure),
        Err(error) => {
            let by_budget = error
                .chain()
                .any(|cause| cause.is::<GraphOnlyBudgetExceeded>())
                || (over_budget && (is_sqlite_interrupt(&error) || is_polled_stop(&error)));
            if by_budget {
                // A real cancel or timeout is the checkpoint's `Err`.
                check()?;
                Ok(GraphOnlySceneDisclosure::NotAppended(NotAppended))
            } else {
                Err(error)
            }
        }
    }
}
