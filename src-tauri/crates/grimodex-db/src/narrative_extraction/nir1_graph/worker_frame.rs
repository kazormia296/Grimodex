//! NQG3: the one-query finite wire format from the isolated C-query worker to
//! Native. All lengths are checked *before* obtaining borrowed slices. Native
//! validates the entire frame in one allocation-free pass; the typed
//! projection can only be obtained from that validation and re-reads the
//! validated bytes with the same parsers.
//!
//! NQG3 differs from NQG2 in two places. The Graph section's Scope revision is
//! optional: a seed with no qualified Revision is an available, empty Graph
//! (no node, no edge, no Scene), as it is for the in-process reader. And a
//! node carries the Scope of its Entity per binding: each binding is followed
//! by the Scope the Entity has in that binding's Revision, so one Entity
//! reached through Revisions that scoped it differently stays one node and
//! keeps every exact version (post-B 6.3). A node binds a Revision at most
//! once, so a binding's Scope is the one Scope its Revision gives the Entity.
use std::cmp::Ordering;
use std::fmt;

use super::{
    Nir1GraphEdge, Nir1GraphMaterialBinding, Nir1GraphNode, Nir1GraphResponse,
    Nir1GraphSceneAssociation,
};
use anyhow::{anyhow, bail, ensure, Result};
use grimodex_core::narrative_nir1::{
    EntityInput, EvidenceInput, GraphEdgeInput, ScopeBinding, ScopeValue, MAX_GRAPH_EDGES,
    MAX_GRAPH_HOPS, MAX_GRAPH_NODES, MAX_GRAPH_QUERY_RECORDS, MAX_GRAPH_RECORDS, MAX_GRAPH_SCENES,
};

pub const FRAME_BYTES: usize = super::c_query_worker::FRAME_BYTES;
const MAGIC: &[u8; 4] = b"NQG3";
/// The retired layouts: NQG1 has no Scene section, NQG2 has neither the
/// optional Scope revision nor the per-binding node Scope. Native accepts only
/// NQG3.
const RETIRED_MAGICS: [&[u8; 4]; 2] = [b"NQG1", b"NQG2"];
/// Fixed v1 terminal commit on the dedicated worker stdout pipe.
pub const TERMINAL_SUCCESS_COMMIT: &[u8; 5] = b"NQGC1";
/// Defensive bound (`nir1-defensive-resource-limits`) on the Scene section,
/// from `scene_total` through the last association. The worker refuses the
/// whole Graph before materializing tokens past it, encode refuses before
/// writing the frame, and validate refuses while scanning.
pub const MAX_SCENE_SECTION_BYTES: usize = 16_384;
/// `scene_total` and `scene_count`, both u16.
pub const SCENE_SECTION_HEADER_BYTES: usize = 4;
const SCOPE_TOKEN_PREFIX: &str = "sha256:";
const SCOPE_TOKEN_HEX_BYTES: usize = 64;
const PATH_SLOTS: usize = MAX_GRAPH_HOPS as usize;

// The fixed validation tables store frame offsets as u32.
const _: () = assert!(FRAME_BYTES <= u32::MAX as usize);

struct Writer {
    bytes: Vec<u8>,
}
impl Writer {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }
    fn add(&mut self, data: &[u8]) -> Result<()> {
        ensure!(
            self.bytes
                .len()
                .checked_add(data.len())
                .is_some_and(|n| n <= FRAME_BYTES),
            "NIR1_GRAPH_FRAME_LIMIT"
        );
        self.bytes.try_reserve(data.len())?;
        self.bytes.extend_from_slice(data);
        Ok(())
    }
    fn byte(&mut self, n: u8) -> Result<()> {
        self.add(&[n])
    }
    fn u16(&mut self, n: usize) -> Result<()> {
        self.add(&u16::try_from(n)?.to_le_bytes())
    }
    fn u32(&mut self, n: usize) -> Result<()> {
        self.add(&u32::try_from(n)?.to_le_bytes())
    }
    fn i64(&mut self, n: i64) -> Result<()> {
        self.add(&n.to_le_bytes())
    }
    fn text(&mut self, s: &str) -> Result<()> {
        self.u32(s.len())?;
        self.add(s.as_bytes())
    }
    fn optional(&mut self, s: Option<&str>) -> Result<()> {
        match s {
            Some(s) => {
                self.byte(1)?;
                self.text(s)
            }
            None => self.byte(0),
        }
    }
    fn scope_value(&mut self, value: &ScopeValue) -> Result<()> {
        match value {
            ScopeValue::Any { purpose } => {
                self.byte(1)?;
                self.optional(purpose.as_deref())
            }
            ScopeValue::Exact { value } => {
                self.byte(2)?;
                self.text(value)
            }
            ScopeValue::NotApplicable { reason } => {
                self.byte(3)?;
                self.text(reason)
            }
            ScopeValue::Unavailable { reason } => {
                self.byte(4)?;
                self.text(reason)
            }
            ScopeValue::LegacyAbsent => self.byte(5),
            ScopeValue::Unresolved => self.byte(6),
        }
    }
    fn scope(&mut self, scope: &ScopeBinding) -> Result<()> {
        self.scope_value(&scope.reading)?;
        self.scope_value(&scope.story)?;
        self.scope_value(&scope.auto)?;
        self.text(&scope.phase)?;
        self.text(&scope.reveal)?;
        self.optional(scope.pov.as_deref())?;
        self.text(&scope.authority_revision)
    }
    fn evidence(&mut self, evidence: &EvidenceInput) -> Result<()> {
        self.text(&evidence.evidence_id)?;
        self.text(&evidence.source_ref)?;
        self.text(&evidence.quote)?;
        self.u32(evidence.start_utf16)?;
        self.u32(evidence.end_utf16)
    }
    fn entity(&mut self, entity: &EntityInput) -> Result<()> {
        self.text(&entity.entity_id)?;
        self.text(&entity.entity_type)?;
        self.text(&entity.label)?;
        self.text(&entity.source_token)?;
        self.scope(&entity.scope)?;
        ensure!(
            entity.evidence.len() <= MAX_GRAPH_RECORDS,
            "NIR1_GRAPH_FRAME_COUNT"
        );
        self.u16(entity.evidence.len())?;
        for evidence in &entity.evidence {
            self.evidence(evidence)?;
        }
        Ok(())
    }
    fn binding(&mut self, b: &Nir1GraphMaterialBinding) -> Result<()> {
        for s in [
            &b.revision_id,
            &b.decision_id,
            &b.decision_token,
            &b.freshness_token,
            &b.scope_authority_revision,
            &b.query_scene_source_token,
            &b.query_scene_scope_token,
            &b.query_scene_incarnation_id,
            &b.reveal_state_token,
        ] {
            self.text(s)?;
        }
        Ok(())
    }
    fn relation(&mut self, r: &GraphEdgeInput) -> Result<()> {
        for s in [
            &r.edge_id,
            &r.from_entity_id,
            &r.to_entity_id,
            &r.relation_type,
            &r.directionality,
            &r.source_token,
        ] {
            self.text(s)?;
        }
        ensure!(
            r.evidence_ids.len() <= MAX_GRAPH_RECORDS,
            "NIR1_GRAPH_FRAME_COUNT"
        );
        self.u16(r.evidence_ids.len())?;
        for s in &r.evidence_ids {
            self.text(s)?;
        }
        Ok(())
    }
    fn node(&mut self, n: &Nir1GraphNode) -> Result<()> {
        self.entity(&n.entity)?;
        self.byte(n.hop)?;
        // A node exists because a qualified Revision carries it, and every
        // binding comes with the Scope its Entity has in that Revision.
        ensure!(
            !n.bindings.is_empty()
                && n.bindings.len() <= MAX_GRAPH_QUERY_RECORDS
                && n.binding_scopes.len() == n.bindings.len(),
            "NIR1_GRAPH_FRAME_COUNT"
        );
        self.u16(n.bindings.len())?;
        for (binding, scope) in n.bindings.iter().zip(&n.binding_scopes) {
            self.binding(binding)?;
            self.scope(scope)?;
        }
        Ok(())
    }
    fn edge(&mut self, e: &Nir1GraphEdge) -> Result<()> {
        self.relation(&e.relation)?;
        self.entity(&e.from)?;
        self.entity(&e.to)?;
        self.binding(&e.binding)
    }
    fn scene(&mut self, scene: &Nir1GraphSceneAssociation) -> Result<()> {
        self.text(&scene.scene_id)?;
        self.optional(scene.scene_incarnation_id.as_deref())?;
        self.text(&scene.scene_source_token)?;
        self.optional(scene.scene_scope_token.as_deref())?;
        self.i64(scene.pin_rowid)?;
        self.text(&scene.pin_entry_id)?;
        self.text(&scene.pin_created_at)?;
        self.byte(scene.path_hop)?;
        self.byte(u8::try_from(scene.path_edge_indices.len())?)?;
        for index in &scene.path_edge_indices {
            self.add(&index.to_le_bytes())?;
        }
        Ok(())
    }
}

/// Encoded byte lengths of one NQG3 Scene association (the layout NQG2
/// introduced). The worker derives
/// them from SQLite `octet_length` values before materializing any token,
/// and encode uses the same arithmetic before writing.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SceneAssociationLengths {
    pub scene_id: usize,
    pub scene_incarnation_id: Option<usize>,
    pub scene_source_token: usize,
    pub scene_scope_token: Option<usize>,
    pub pin_entry_id: usize,
    pub pin_created_at: usize,
    pub path_edge_count: usize,
}

impl SceneAssociationLengths {
    pub fn of(scene: &Nir1GraphSceneAssociation) -> Self {
        Self {
            scene_id: scene.scene_id.len(),
            scene_incarnation_id: scene.scene_incarnation_id.as_deref().map(str::len),
            scene_source_token: scene.scene_source_token.len(),
            scene_scope_token: scene.scene_scope_token.as_deref().map(str::len),
            pin_entry_id: scene.pin_entry_id.len(),
            pin_created_at: scene.pin_created_at.len(),
            path_edge_count: scene.path_edge_indices.len(),
        }
    }

    /// Exact encoded size of the association, or None on overflow.
    pub fn encoded_bytes(&self) -> Option<usize> {
        let text = |bytes: usize| bytes.checked_add(4);
        let optional = |bytes: Option<usize>| match bytes {
            Some(bytes) => bytes.checked_add(5),
            None => Some(1),
        };
        [
            text(self.scene_id)?,
            optional(self.scene_incarnation_id)?,
            text(self.scene_source_token)?,
            optional(self.scene_scope_token)?,
            8, // pin_rowid
            text(self.pin_entry_id)?,
            text(self.pin_created_at)?,
            2, // path_hop, path_edge_count
            self.path_edge_count.checked_mul(2)?,
        ]
        .into_iter()
        .try_fold(0usize, usize::checked_add)
    }
}

/// Structural Scene-section checks for encode. Returns the exact section size.
fn scene_section_bytes(
    scene_total: usize,
    scenes: &[Nir1GraphSceneAssociation],
    edge_count: usize,
) -> Result<usize> {
    ensure!(
        scene_total <= MAX_GRAPH_QUERY_RECORDS && scenes.len() == scene_total.min(MAX_GRAPH_SCENES),
        "NIR1_GRAPH_FRAME_SCENE_COUNT"
    );
    let mut total = SCENE_SECTION_HEADER_BYTES;
    for scene in scenes {
        ensure!(
            (1..=MAX_GRAPH_HOPS).contains(&scene.path_hop)
                && scene.path_edge_indices.len() == usize::from(scene.path_hop)
                && scene
                    .path_edge_indices
                    .iter()
                    .all(|index| usize::from(*index) < edge_count),
            "NIR1_GRAPH_FRAME_SCENE_PATH"
        );
        ensure!(
            scene.scene_incarnation_id.is_some() == scene.scene_scope_token.is_some(),
            "NIR1_GRAPH_FRAME_SCENE_TOKEN"
        );
        total = SceneAssociationLengths::of(scene)
            .encoded_bytes()
            .and_then(|bytes| total.checked_add(bytes))
            .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_SCENE_LIMIT"))?;
    }
    Ok(total)
}

/// Worker writer is bounded by Native's *remaining* region, not its full size.
pub fn encode(response: &Nir1GraphResponse) -> Result<Vec<u8>> {
    let mut w = Writer::new();
    w.add(MAGIC)?;
    w.byte(if response.status == "available" { 1 } else { 0 })?;
    w.text(&response.project_id)?;
    w.text(&response.query_scene_id)?;
    if let Some(graph) = &response.graph {
        ensure!(
            response.status == "available" && response.reason.is_none(),
            "NIR1_GRAPH_FRAME_STATUS"
        );
        // The Scope revision is the one every qualified Revision agreed on;
        // with no qualified Revision there is none, and nothing else either.
        ensure!(
            response
                .scope_revision
                .as_deref()
                .is_none_or(|scope| !scope.is_empty())
                && (response.scope_revision.is_some()
                    || (graph.nodes.is_empty() && graph.edges.is_empty())),
            "NIR1_GRAPH_FRAME_SCOPE"
        );
        w.optional(response.scope_revision.as_deref())?;
        w.i64(graph.generation)?;
        w.text(&graph.seed_entity_id)?;
        ensure!(
            graph.nodes.len() <= MAX_GRAPH_NODES && graph.edges.len() <= MAX_GRAPH_EDGES,
            "NIR1_GRAPH_FRAME_COUNT"
        );
        // The whole Scene section is checked before any frame byte of it.
        let section = scene_section_bytes(graph.scene_total, &graph.scenes, graph.edges.len())?;
        ensure!(
            section <= MAX_SCENE_SECTION_BYTES,
            "NIR1_GRAPH_FRAME_SCENE_LIMIT"
        );
        w.u16(graph.nodes.len())?;
        w.u16(graph.edges.len())?;
        for node in &graph.nodes {
            w.node(node)?;
        }
        for edge in &graph.edges {
            w.edge(edge)?;
        }
        w.u16(graph.scene_total)?;
        w.u16(graph.scenes.len())?;
        for scene in &graph.scenes {
            w.scene(scene)?;
        }
    } else {
        ensure!(
            response.status == "unavailable" && response.scope_revision.is_none(),
            "NIR1_GRAPH_FRAME_STATUS"
        );
        let reason = response
            .reason
            .as_deref()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_REASON"))?;
        // Worker-internal text never crosses the process boundary.
        ensure!(
            UnavailableReason::parse(reason).is_some(),
            "NIR1_GRAPH_FRAME_REASON"
        );
        w.text(reason)?;
    }
    Ok(w.bytes)
}

/// Where a worker refusal was decided.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WorkerSite {
    Work,
    PostStamp,
}

impl WorkerSite {
    pub const ALL: [Self; 2] = [Self::Work, Self::PostStamp];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::PostStamp => "post-stamp",
        }
    }
}

/// The closed set of worker refusal causes. None carries private detail.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WorkerCause {
    SqliteNoMem,
    CandidateRecordLimit,
    RevisionRecordLimit,
    DisclosureRecordLimit,
    ReadRecordLimit,
    SceneLimit,
    /// More than `MAX_GRAPH_NODES` Entities reached (Entity 50).
    NodeLimit,
    /// More than `MAX_GRAPH_EDGES` distinct edges expanded (edge 512).
    EdgeLimit,
    /// Two qualified Revisions carry the same Entity ID with different
    /// identity fields (type, label, source token, Evidence). A different
    /// Scope is not a conflict: each binding keeps its own.
    EndpointVersionConflict,
    Deadline,
    DeadlineOrSteps,
    Steps,
    ValidationCapacityExceeded,
    ValidationContextUnavailable,
    ValidationCancelled,
    ValidationClosed,
    ValidationWorkspaceGenerationChanged,
    ValidationForegroundPreempted,
    ValidationCleanupFailed,
    Other,
}

impl WorkerCause {
    pub const ALL: [Self; 20] = [
        Self::SqliteNoMem,
        Self::CandidateRecordLimit,
        Self::RevisionRecordLimit,
        Self::DisclosureRecordLimit,
        Self::ReadRecordLimit,
        Self::SceneLimit,
        Self::NodeLimit,
        Self::EdgeLimit,
        Self::EndpointVersionConflict,
        Self::Deadline,
        Self::DeadlineOrSteps,
        Self::Steps,
        Self::ValidationCapacityExceeded,
        Self::ValidationContextUnavailable,
        Self::ValidationCancelled,
        Self::ValidationClosed,
        Self::ValidationWorkspaceGenerationChanged,
        Self::ValidationForegroundPreempted,
        Self::ValidationCleanupFailed,
        Self::Other,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SqliteNoMem => "sqlite-nomem",
            Self::CandidateRecordLimit => "candidate-record-limit",
            Self::RevisionRecordLimit => "revision-record-limit",
            Self::DisclosureRecordLimit => "disclosure-record-limit",
            Self::ReadRecordLimit => "read-record-limit",
            Self::SceneLimit => "scene-limit",
            Self::NodeLimit => "node-limit",
            Self::EdgeLimit => "edge-limit",
            Self::EndpointVersionConflict => "endpoint-version-conflict",
            Self::Deadline => "deadline",
            Self::DeadlineOrSteps => "deadline-or-steps",
            Self::Steps => "steps",
            Self::ValidationCapacityExceeded => "validation-capacity-exceeded",
            Self::ValidationContextUnavailable => "validation-context-unavailable",
            Self::ValidationCancelled => "validation-cancelled",
            Self::ValidationClosed => "validation-closed",
            Self::ValidationWorkspaceGenerationChanged => "validation-workspace-generation-changed",
            Self::ValidationForegroundPreempted => "validation-foreground-preempted",
            Self::ValidationCleanupFailed => "validation-cleanup-failed",
            Self::Other => "other",
        }
    }

    fn parse_exact(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|cause| cause.as_str() == value)
    }

    pub const fn category(self) -> UnavailableCategory {
        match self {
            Self::SqliteNoMem
            | Self::CandidateRecordLimit
            | Self::RevisionRecordLimit
            | Self::DisclosureRecordLimit
            | Self::ReadRecordLimit
            | Self::SceneLimit
            | Self::NodeLimit
            | Self::EdgeLimit
            | Self::Steps
            | Self::ValidationCapacityExceeded => UnavailableCategory::Limit,
            Self::Deadline | Self::DeadlineOrSteps => UnavailableCategory::Timeout,
            Self::ValidationCancelled
            | Self::ValidationClosed
            | Self::ValidationForegroundPreempted => UnavailableCategory::Cancelled,
            Self::ValidationWorkspaceGenerationChanged => UnavailableCategory::Invalidated,
            // Not a resource limit and not transient: the approved Revisions
            // contradict each other about one Entity, which only a new review
            // resolves. It is the generic failure, never an invalidation.
            Self::EndpointVersionConflict
            | Self::ValidationContextUnavailable
            | Self::ValidationCleanupFailed
            | Self::Other => UnavailableCategory::Failed,
        }
    }
}

/// The work outcome observed before the worker's read cleanup.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PreCleanup {
    WorkOk,
    WorkFailed(WorkerCause),
    DeadlineAlreadyCrossed,
}

/// Product-facing grouping of an allowlisted reason (CP-1 table).
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum UnavailableCategory {
    Limit,
    Timeout,
    Stale,
    RegistrationUnavailable,
    Invalidated,
    Cancelled,
    Failed,
}

/// The closed allowlist of reasons an unavailable NQG3 frame may carry:
/// six fixed values and `query-worker-{site}-{cause}{pre-cleanup}`.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum UnavailableReason {
    ReaderUnavailable,
    RegistrationRequired,
    RegistrationProjectMismatch,
    SeedNotFound,
    RegistrationDrift,
    QueryInvalidated,
    Worker {
        site: WorkerSite,
        cause: WorkerCause,
        pre_cleanup: Option<PreCleanup>,
    },
}

const WORKER_REASON_PREFIX: &str = "query-worker-";
const PRE_CLEANUP_PREFIX: &str = "-pre-cleanup-";
const PRE_CLEANUP_WORK_OK: &str = "-pre-cleanup-work-ok";
const PRE_CLEANUP_WORK_FAILED: &str = "-pre-cleanup-work-failed-";
const PRE_CLEANUP_DEADLINE_ALREADY_CROSSED: &str = "-pre-cleanup-deadline-already-crossed";

impl UnavailableReason {
    pub const FIXED: [Self; 6] = [
        Self::ReaderUnavailable,
        Self::RegistrationRequired,
        Self::RegistrationProjectMismatch,
        Self::SeedNotFound,
        Self::RegistrationDrift,
        Self::QueryInvalidated,
    ];

    const fn fixed_str(self) -> Option<&'static str> {
        match self {
            Self::ReaderUnavailable => Some("reader-unavailable"),
            Self::RegistrationRequired => Some("registration-required"),
            Self::RegistrationProjectMismatch => Some("registration-project-mismatch"),
            Self::SeedNotFound => Some("seed-not-found"),
            Self::RegistrationDrift => Some("registration-drift"),
            Self::QueryInvalidated => Some("query-invalidated"),
            Self::Worker { .. } => None,
        }
    }

    /// Allocation-free parse of exactly one allowlisted value.
    pub fn parse(value: &str) -> Option<Self> {
        if let Some(fixed) = Self::FIXED
            .into_iter()
            .find(|reason| reason.fixed_str() == Some(value))
        {
            return Some(fixed);
        }
        let rest = value.strip_prefix(WORKER_REASON_PREFIX)?;
        let (site, rest) = WorkerSite::ALL.into_iter().find_map(|site| {
            rest.strip_prefix(site.as_str())
                .and_then(|rest| rest.strip_prefix('-'))
                .map(|rest| (site, rest))
        })?;
        // `deadline` is a prefix of `deadline-or-steps`; a cause must be
        // followed by nothing or by the fixed pre-cleanup prefix.
        let (cause, status) = WorkerCause::ALL.into_iter().find_map(|cause| {
            rest.strip_prefix(cause.as_str())
                .filter(|status| status.is_empty() || status.starts_with(PRE_CLEANUP_PREFIX))
                .map(|status| (cause, status))
        })?;
        let pre_cleanup = match status {
            "" => None,
            PRE_CLEANUP_WORK_OK => Some(PreCleanup::WorkOk),
            PRE_CLEANUP_DEADLINE_ALREADY_CROSSED => Some(PreCleanup::DeadlineAlreadyCrossed),
            other => Some(PreCleanup::WorkFailed(WorkerCause::parse_exact(
                other.strip_prefix(PRE_CLEANUP_WORK_FAILED)?,
            )?)),
        };
        Some(Self::Worker {
            site,
            cause,
            pre_cleanup,
        })
    }

    pub const fn category(self) -> UnavailableCategory {
        match self {
            Self::ReaderUnavailable => UnavailableCategory::Cancelled,
            Self::RegistrationRequired => UnavailableCategory::RegistrationUnavailable,
            Self::RegistrationProjectMismatch => UnavailableCategory::Failed,
            Self::SeedNotFound => UnavailableCategory::Invalidated,
            Self::RegistrationDrift => UnavailableCategory::Stale,
            // The worker has no reader cancellation path; this is the
            // post-cleanup deadline observation.
            Self::QueryInvalidated => UnavailableCategory::Timeout,
            Self::Worker {
                cause, pre_cleanup, ..
            } => match pre_cleanup {
                Some(PreCleanup::WorkFailed(cause)) => cause.category(),
                Some(PreCleanup::DeadlineAlreadyCrossed) => WorkerCause::Deadline.category(),
                Some(PreCleanup::WorkOk) | None => cause.category(),
            },
        }
    }
}

impl fmt::Display for UnavailableReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self::Worker {
            site,
            cause,
            pre_cleanup,
        } = *self
        else {
            return f.write_str(self.fixed_str().unwrap_or_default());
        };
        f.write_str(WORKER_REASON_PREFIX)?;
        f.write_str(site.as_str())?;
        f.write_str("-")?;
        f.write_str(cause.as_str())?;
        match pre_cleanup {
            None => Ok(()),
            Some(PreCleanup::WorkOk) => f.write_str(PRE_CLEANUP_WORK_OK),
            Some(PreCleanup::WorkFailed(cause)) => {
                f.write_str(PRE_CLEANUP_WORK_FAILED)?;
                f.write_str(cause.as_str())
            }
            Some(PreCleanup::DeadlineAlreadyCrossed) => {
                f.write_str(PRE_CLEANUP_DEADLINE_ALREADY_CROSSED)
            }
        }
    }
}

/// Borrowed cursor over validated (or being-validated) frame bytes.
#[derive(Clone, Copy, Debug)]
struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

/// A counted run of records whose bytes were validated by [`validate`].
#[derive(Clone, Copy, Debug)]
struct RecordRun<'a> {
    start: Cursor<'a>,
    count: usize,
}

impl<'a> RecordRun<'a> {
    fn records<T>(self, parse: fn(&mut Cursor<'a>) -> Result<T>) -> Records<'a, T> {
        Records {
            cursor: self.start,
            remaining: self.count,
            parse,
        }
    }
}

/// Sequential typed projection of validated records. Each item is re-read
/// with the parser that validated it; an impossible failure ends iteration.
pub struct Records<'a, T> {
    cursor: Cursor<'a>,
    remaining: usize,
    parse: fn(&mut Cursor<'a>) -> Result<T>,
}

impl<T> Iterator for Records<'_, T> {
    type Item = Result<T>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        let item = (self.parse)(&mut self.cursor);
        if item.is_err() {
            self.remaining = 0;
        }
        Some(item)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (0, Some(self.remaining))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EvidenceView<'a> {
    pub id: &'a str,
    pub source: &'a str,
    pub quote: &'a str,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScopeView<'a> {
    Any(Option<&'a str>),
    Exact(&'a str),
    NotApplicable(&'a str),
    Unavailable(&'a str),
    LegacyAbsent,
    Unresolved,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScopeBindingView<'a> {
    pub reading: ScopeView<'a>,
    pub story: ScopeView<'a>,
    pub auto: ScopeView<'a>,
    pub phase: &'a str,
    pub reveal: &'a str,
    pub pov: Option<&'a str>,
    pub authority_revision: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct EntityView<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub label: &'a str,
    pub source: &'a str,
    pub scope: ScopeBindingView<'a>,
    evidence: RecordRun<'a>,
}

impl<'a> EntityView<'a> {
    pub fn evidence_count(&self) -> usize {
        self.evidence.count
    }

    pub fn evidence(&self) -> Records<'a, EvidenceView<'a>> {
        self.evidence.records(Cursor::evidence)
    }
}

/// All nine material-binding tokens of one Revision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BindingView<'a> {
    pub revision_id: &'a str,
    pub decision_id: &'a str,
    pub decision_token: &'a str,
    pub freshness_token: &'a str,
    pub scope_authority_revision: &'a str,
    pub query_scene_source_token: &'a str,
    pub query_scene_scope_token: &'a str,
    pub query_scene_incarnation_id: &'a str,
    pub reveal_state_token: &'a str,
}

/// One binding of a node and the Scope the node's Entity has in that
/// binding's Revision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NodeBindingView<'a> {
    pub binding: BindingView<'a>,
    pub scope: ScopeBindingView<'a>,
}

#[derive(Clone, Copy, Debug)]
pub struct NodeView<'a> {
    /// The Entity as its first binding carries it; validate proves that this
    /// Scope is the first binding's.
    pub entity: EntityView<'a>,
    pub hop: u8,
    bindings: RecordRun<'a>,
}

impl<'a> NodeView<'a> {
    /// Always at least one.
    pub fn binding_count(&self) -> usize {
        self.bindings.count
    }

    pub fn bindings(&self) -> Records<'a, NodeBindingView<'a>> {
        self.bindings.records(Cursor::node_binding)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Directionality {
    Directed,
    Symmetric,
}

impl Directionality {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Directed => "directed",
            Self::Symmetric => "symmetric",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RelationView<'a> {
    pub edge_id: &'a str,
    pub from_entity_id: &'a str,
    pub to_entity_id: &'a str,
    pub relation_type: &'a str,
    pub directionality: Directionality,
    pub source_token: &'a str,
    evidence_ids: RecordRun<'a>,
}

impl<'a> RelationView<'a> {
    pub fn evidence_id_count(&self) -> usize {
        self.evidence_ids.count
    }

    pub fn evidence_ids(&self) -> Records<'a, &'a str> {
        self.evidence_ids.records(Cursor::text)
    }

    /// The Entity reached from `at`, under the Graph traversal rule: a
    /// relation is followed from its source, and also from its target when
    /// it is symmetric.
    pub fn traverse_from(&self, at: &str) -> Option<&'a str> {
        if self.from_entity_id == at {
            Some(self.to_entity_id)
        } else if self.directionality == Directionality::Symmetric && self.to_entity_id == at {
            Some(self.from_entity_id)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EdgeView<'a> {
    pub relation: RelationView<'a>,
    pub from: EntityView<'a>,
    pub to: EntityView<'a>,
    pub binding: BindingView<'a>,
}

/// Request-local pin locator; never a durable identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PinView<'a> {
    pub rowid: i64,
    pub entry_id: &'a str,
    pub created_at: &'a str,
}

/// Frame edge indices of a representative path, in traversal order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PathRef {
    hop: u8,
    edges: [u16; PATH_SLOTS],
}

impl PathRef {
    pub fn hop(&self) -> u8 {
        self.hop
    }

    pub fn edge_indices(&self) -> &[u16] {
        &self.edges[..usize::from(self.hop)]
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SceneView<'a> {
    pub scene_id: &'a str,
    pub scene_incarnation_id: Option<&'a str>,
    pub scene_source_token: &'a str,
    pub scene_scope_token: Option<&'a str>,
    pub pin: PinView<'a>,
    pub path: PathRef,
}

#[derive(Clone, Copy, Debug)]
pub struct PathStep<'a> {
    pub edge_index: u16,
    pub edge: EdgeView<'a>,
    pub from: &'a str,
    pub to: &'a str,
}

/// A representative path resolved against the frame's edges.
#[derive(Clone, Copy, Debug)]
pub struct ScenePath<'a> {
    steps: [Option<PathStep<'a>>; PATH_SLOTS],
}

impl<'a> ScenePath<'a> {
    pub fn len(&self) -> usize {
        self.steps.iter().flatten().count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn steps(&self) -> impl Iterator<Item = &PathStep<'a>> {
        self.steps.iter().flatten()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GraphView<'a> {
    bytes: &'a [u8],
    scope_revision: Option<&'a str>,
    generation: i64,
    seed: &'a str,
    node_count: usize,
    nodes_start: usize,
    edge_count: usize,
    edges_start: usize,
    edge_offsets: [u32; MAX_GRAPH_EDGES],
    scene_total: usize,
    scene_count: usize,
    scenes_start: usize,
}

impl<'a> GraphView<'a> {
    /// The Scope revision every qualified Revision agreed on. None exactly
    /// when no Revision qualified, which is an empty Graph.
    pub fn scope_revision(&self) -> Option<&'a str> {
        self.scope_revision
    }

    /// Always positive; validate refuses any other value.
    pub fn generation(&self) -> i64 {
        self.generation
    }

    pub fn seed(&self) -> &'a str {
        self.seed
    }

    pub fn node_count(&self) -> usize {
        self.node_count
    }

    pub fn nodes(&self) -> Records<'a, NodeView<'a>> {
        RecordRun {
            start: Cursor::at(self.bytes, self.nodes_start),
            count: self.node_count,
        }
        .records(Cursor::node)
    }

    pub fn edge_count(&self) -> usize {
        self.edge_count
    }

    pub fn edges(&self) -> Records<'a, EdgeView<'a>> {
        RecordRun {
            start: Cursor::at(self.bytes, self.edges_start),
            count: self.edge_count,
        }
        .records(Cursor::edge)
    }

    /// O(1) random access used to resolve representative paths.
    pub fn edge(&self, index: usize) -> Result<EdgeView<'a>> {
        self.edge_cursor(index)?.edge()
    }

    pub fn scene_count(&self) -> usize {
        self.scene_count
    }

    /// Scene associations in strictly ascending tuple order.
    pub fn scenes(&self) -> Records<'a, SceneView<'a>> {
        RecordRun {
            start: Cursor::at(self.bytes, self.scenes_start),
            count: self.scene_count,
        }
        .records(Cursor::scene)
    }

    /// Distinct pinned Scenes the worker enumerated. Diagnostic only: it is
    /// never an eligibility, ranking or acceptance input.
    pub fn diagnostic_scene_total(&self) -> usize {
        self.scene_total
    }

    pub fn scene_path(&self, scene: &SceneView<'a>) -> Result<ScenePath<'a>> {
        let mut steps = [None; PATH_SLOTS];
        let mut at = self.seed;
        for (slot, index) in steps.iter_mut().zip(scene.path.edge_indices()) {
            let edge = self.edge(usize::from(*index))?;
            let to = edge
                .relation
                .traverse_from(at)
                .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_SCENE_PATH"))?;
            *slot = Some(PathStep {
                edge_index: *index,
                edge,
                from: at,
                to,
            });
            at = to;
        }
        ensure!(at == scene.pin.entry_id, "NIR1_GRAPH_FRAME_SCENE_PATH");
        Ok(ScenePath { steps })
    }

    fn edge_cursor(&self, index: usize) -> Result<Cursor<'a>> {
        ensure!(index < self.edge_count, "NIR1_GRAPH_FRAME_SCENE_PATH");
        Ok(Cursor::at(self.bytes, self.edge_offsets[index] as usize))
    }

    /// Only the relation prefix of an edge; validation never re-reads Evidence.
    fn relation(&self, index: u16) -> Result<RelationView<'a>> {
        self.edge_cursor(usize::from(index))?.relation()
    }

    /// Tuple order: (hop, traversal-order edge IDs, reached Entity ID,
    /// Scene ID), every ID compared as UTF-8 bytes.
    fn scene_order(&self, a: &SceneView<'a>, b: &SceneView<'a>) -> Result<Ordering> {
        let order = a.path.hop.cmp(&b.path.hop);
        if order != Ordering::Equal {
            return Ok(order);
        }
        for (left, right) in a.path.edge_indices().iter().zip(b.path.edge_indices()) {
            let order = self
                .relation(*left)?
                .edge_id
                .as_bytes()
                .cmp(self.relation(*right)?.edge_id.as_bytes());
            if order != Ordering::Equal {
                return Ok(order);
            }
        }
        Ok(a.pin
            .entry_id
            .as_bytes()
            .cmp(b.pin.entry_id.as_bytes())
            .then_with(|| a.scene_id.as_bytes().cmp(b.scene_id.as_bytes())))
    }
}

// Validation never allocates, so the Graph projection keeps its fixed
// edge-offset table inline instead of boxing it.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Copy, Debug)]
pub enum FrameOutcome<'a> {
    Available(GraphView<'a>),
    Unavailable(UnavailableReason),
}

#[derive(Clone, Copy, Debug)]
pub struct FrameView<'a> {
    project: &'a str,
    query_scene: &'a str,
    outcome: FrameOutcome<'a>,
}

impl<'a> FrameView<'a> {
    pub fn project(&self) -> &'a str {
        self.project
    }

    pub fn query_scene(&self) -> &'a str {
        self.query_scene
    }

    pub fn outcome(&self) -> &FrameOutcome<'a> {
        &self.outcome
    }

    pub fn graph(&self) -> Option<&GraphView<'a>> {
        match &self.outcome {
            FrameOutcome::Available(graph) => Some(graph),
            FrameOutcome::Unavailable(_) => None,
        }
    }

    pub fn unavailable_reason(&self) -> Option<UnavailableReason> {
        match self.outcome {
            FrameOutcome::Available(_) => None,
            FrameOutcome::Unavailable(reason) => Some(reason),
        }
    }
}

fn is_scope_token(value: &str) -> bool {
    value.len() == SCOPE_TOKEN_PREFIX.len() + SCOPE_TOKEN_HEX_BYTES
        && value.starts_with(SCOPE_TOKEN_PREFIX)
        && value.as_bytes()[SCOPE_TOKEN_PREFIX.len()..]
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

impl<'a> Cursor<'a> {
    fn at(bytes: &'a [u8], position: usize) -> Self {
        Self { bytes, position }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_TRUNCATED"))?;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16_value(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }
    fn u16(&mut self) -> Result<usize> {
        Ok(usize::from(self.u16_value()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into()?))
    }
    fn text(&mut self) -> Result<&'a str> {
        let n = self.u32()? as usize;
        Ok(std::str::from_utf8(self.take(n)?)?)
    }
    fn optional(&mut self) -> Result<Option<&'a str>> {
        match self.byte()? {
            0 => Ok(None),
            1 => Ok(Some(self.text()?)),
            _ => bail!("NIR1_GRAPH_FRAME_ENUM"),
        }
    }
    fn scope_value(&mut self) -> Result<ScopeView<'a>> {
        Ok(match self.byte()? {
            1 => ScopeView::Any(self.optional()?),
            2 => ScopeView::Exact(self.text()?),
            3 => ScopeView::NotApplicable(self.text()?),
            4 => ScopeView::Unavailable(self.text()?),
            5 => ScopeView::LegacyAbsent,
            6 => ScopeView::Unresolved,
            _ => bail!("NIR1_GRAPH_FRAME_ENUM"),
        })
    }
    fn scope(&mut self) -> Result<ScopeBindingView<'a>> {
        Ok(ScopeBindingView {
            reading: self.scope_value()?,
            story: self.scope_value()?,
            auto: self.scope_value()?,
            phase: self.text()?,
            reveal: self.text()?,
            pov: self.optional()?,
            authority_revision: self.text()?,
        })
    }
    fn evidence(&mut self) -> Result<EvidenceView<'a>> {
        let id = self.text()?;
        let source = self.text()?;
        let quote = self.text()?;
        let start = self.u32()?;
        let end = self.u32()?;
        let quote_len = quote.encode_utf16().count();
        // These offsets address the canonical source, not the extracted quote.
        ensure!(
            end.checked_sub(start)
                .is_some_and(|span| span as usize == quote_len),
            "NIR1_GRAPH_FRAME_EVIDENCE_RANGE"
        );
        Ok(EvidenceView {
            id,
            source,
            quote,
            start,
            end,
        })
    }
    /// Skip a counted run while validating every record in it.
    fn run<T>(
        &mut self,
        count: usize,
        limit: usize,
        parse: fn(&mut Cursor<'a>) -> Result<T>,
    ) -> Result<RecordRun<'a>> {
        ensure!(count <= limit, "NIR1_GRAPH_FRAME_COUNT");
        let start = *self;
        for _ in 0..count {
            parse(self)?;
        }
        Ok(RecordRun { start, count })
    }
    fn entity(&mut self) -> Result<EntityView<'a>> {
        let id = self.text()?;
        let kind = self.text()?;
        let label = self.text()?;
        let source = self.text()?;
        let scope = self.scope()?;
        let count = self.u16()?;
        let evidence = self.run(count, MAX_GRAPH_RECORDS, Cursor::evidence)?;
        Ok(EntityView {
            id,
            kind,
            label,
            source,
            scope,
            evidence,
        })
    }
    fn binding(&mut self) -> Result<BindingView<'a>> {
        Ok(BindingView {
            revision_id: self.text()?,
            decision_id: self.text()?,
            decision_token: self.text()?,
            freshness_token: self.text()?,
            scope_authority_revision: self.text()?,
            query_scene_source_token: self.text()?,
            query_scene_scope_token: self.text()?,
            query_scene_incarnation_id: self.text()?,
            reveal_state_token: self.text()?,
        })
    }
    fn node_binding(&mut self) -> Result<NodeBindingView<'a>> {
        Ok(NodeBindingView {
            binding: self.binding()?,
            scope: self.scope()?,
        })
    }
    fn node(&mut self) -> Result<NodeView<'a>> {
        let entity = self.entity()?;
        let hop = self.byte()?;
        ensure!(hop <= MAX_GRAPH_HOPS, "NIR1_GRAPH_FRAME_HOP");
        let count = self.u16()?;
        ensure!(count > 0, "NIR1_GRAPH_FRAME_NODE_BINDING");
        let bindings = self.run(count, MAX_GRAPH_QUERY_RECORDS, Cursor::node_binding)?;
        // The node's Entity is the one its first binding's Revision carries.
        let first = bindings
            .records(Cursor::node_binding)
            .next()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_NODE_BINDING"))??;
        ensure!(first.scope == entity.scope, "NIR1_GRAPH_FRAME_NODE_SCOPE");
        Ok(NodeView {
            entity,
            hop,
            bindings,
        })
    }
    fn relation(&mut self) -> Result<RelationView<'a>> {
        let edge_id = self.text()?;
        let from_entity_id = self.text()?;
        let to_entity_id = self.text()?;
        let relation_type = self.text()?;
        let directionality = match self.text()? {
            "directed" => Directionality::Directed,
            "symmetric" => Directionality::Symmetric,
            _ => bail!("NIR1_GRAPH_FRAME_DIRECTION"),
        };
        let source_token = self.text()?;
        let count = self.u16()?;
        let evidence_ids = self.run(count, MAX_GRAPH_RECORDS, Cursor::text)?;
        Ok(RelationView {
            edge_id,
            from_entity_id,
            to_entity_id,
            relation_type,
            directionality,
            source_token,
            evidence_ids,
        })
    }
    fn edge(&mut self) -> Result<EdgeView<'a>> {
        Ok(EdgeView {
            relation: self.relation()?,
            from: self.entity()?,
            to: self.entity()?,
            binding: self.binding()?,
        })
    }
    /// Field-local Scene checks; the path is checked against the Graph.
    fn scene(&mut self) -> Result<SceneView<'a>> {
        let scene_id = self.text()?;
        let scene_incarnation_id = self.optional()?;
        let scene_source_token = self.text()?;
        let scene_scope_token = self.optional()?;
        let rowid = self.i64()?;
        let entry_id = self.text()?;
        let created_at = self.text()?;
        let hop = self.byte()?;
        let edge_count = self.byte()?;
        ensure!(
            (1..=MAX_GRAPH_HOPS).contains(&hop) && edge_count == hop,
            "NIR1_GRAPH_FRAME_SCENE_PATH"
        );
        let mut edges = [0u16; PATH_SLOTS];
        for slot in edges.iter_mut().take(usize::from(hop)) {
            *slot = self.u16_value()?;
        }
        ensure!(
            !scene_id.is_empty()
                && !scene_source_token.is_empty()
                && !entry_id.is_empty()
                && rowid > 0
                && scene_incarnation_id.is_some() == scene_scope_token.is_some()
                && scene_incarnation_id.is_none_or(|value| !value.is_empty())
                && scene_scope_token.is_none_or(is_scope_token),
            "NIR1_GRAPH_FRAME_SCENE_TOKEN"
        );
        Ok(SceneView {
            scene_id,
            scene_incarnation_id,
            scene_source_token,
            scene_scope_token,
            pin: PinView {
                rowid,
                entry_id,
                created_at,
            },
            path: PathRef { hop, edges },
        })
    }
}

fn frame_offset(position: usize) -> Result<u32> {
    u32::try_from(position).map_err(|_| anyhow!("NIR1_GRAPH_FRAME_LIMIT"))
}

/// Node IDs and hops recorded by the single validation pass.
struct NodeTable<'a> {
    ids: [&'a str; MAX_GRAPH_NODES],
    hops: [u8; MAX_GRAPH_NODES],
    count: usize,
}

impl NodeTable<'_> {
    fn hop(&self, id: &str) -> Option<u8> {
        self.ids[..self.count]
            .iter()
            .position(|node| *node == id)
            .map(|index| self.hops[index])
    }
}

fn validate_graph<'a>(c: &mut Cursor<'a>) -> Result<GraphView<'a>> {
    let scope_revision = c.optional()?;
    ensure!(
        scope_revision.is_none_or(|scope| !scope.is_empty()),
        "NIR1_GRAPH_FRAME_SCOPE"
    );
    let generation = c.i64()?;
    ensure!(generation > 0, "NIR1_GRAPH_FRAME_GENERATION");
    let seed = c.text()?;
    ensure!(!seed.is_empty(), "NIR1_GRAPH_FRAME_SEED");
    let node_count = c.u16()?;
    let edge_count = c.u16()?;
    ensure!(
        node_count <= MAX_GRAPH_NODES && edge_count <= MAX_GRAPH_EDGES,
        "NIR1_GRAPH_FRAME_COUNT"
    );
    // No qualified Revision means no Scope revision, no node and no edge.
    ensure!(
        scope_revision.is_some() || (node_count == 0 && edge_count == 0),
        "NIR1_GRAPH_FRAME_SCOPE"
    );
    let nodes_start = c.position;
    let mut nodes = NodeTable {
        ids: [""; MAX_GRAPH_NODES],
        hops: [0; MAX_GRAPH_NODES],
        count: 0,
    };
    // The Revisions one node is bound to, reused by every node.
    let mut revisions = [""; MAX_GRAPH_QUERY_RECORDS];
    for _ in 0..node_count {
        let node = c.node()?;
        // A path endpoint must name exactly one node and therefore one hop.
        ensure!(
            nodes.hop(node.entity.id).is_none(),
            "NIR1_GRAPH_FRAME_NODE_DUPLICATE"
        );
        // A node keeps one Scope per binding, and a Revision gives it one
        // Scope: a Revision bound twice has no single Scope. At most
        // MAX_GRAPH_QUERY_RECORDS bindings per node (the run is already bounded).
        // The borrowed ids are sorted in place and compared with their
        // neighbours: O(n log n), no allocation, and a forged frame of many
        // 2,048-binding nodes cannot cost a quadratic comparison.
        let mut bound = 0;
        for binding in node.bindings() {
            revisions[bound] = binding?.binding.revision_id;
            bound += 1;
        }
        let bound_revisions = &mut revisions[..bound];
        bound_revisions.sort_unstable();
        ensure!(
            bound_revisions.windows(2).all(|pair| pair[0] != pair[1]),
            "NIR1_GRAPH_FRAME_NODE_BINDING_DUPLICATE"
        );
        nodes.ids[nodes.count] = node.entity.id;
        nodes.hops[nodes.count] = node.hop;
        nodes.count += 1;
    }
    let edges_start = c.position;
    let mut edge_offsets = [0u32; MAX_GRAPH_EDGES];
    for offset in edge_offsets.iter_mut().take(edge_count) {
        *offset = frame_offset(c.position)?;
        c.edge()?;
    }
    let section_start = c.position;
    let scene_total = c.u16()?;
    let scene_count = c.u16()?;
    ensure!(
        scene_total <= MAX_GRAPH_QUERY_RECORDS && scene_count == scene_total.min(MAX_GRAPH_SCENES),
        "NIR1_GRAPH_FRAME_SCENE_COUNT"
    );
    let graph = GraphView {
        bytes: c.bytes,
        scope_revision,
        generation,
        seed,
        node_count,
        nodes_start,
        edge_count,
        edges_start,
        edge_offsets,
        scene_total,
        scene_count,
        scenes_start: c.position,
    };
    let mut seen = [""; MAX_GRAPH_SCENES];
    let mut previous: Option<SceneView<'a>> = None;
    for index in 0..scene_count {
        let scene = c.scene()?;
        ensure!(
            c.position - section_start <= MAX_SCENE_SECTION_BYTES,
            "NIR1_GRAPH_FRAME_SCENE_LIMIT"
        );
        validate_scene_path(&graph, &nodes, &scene)?;
        // Strict tuple order; each Scene has exactly one representative.
        ensure!(
            !seen[..index].contains(&scene.scene_id)
                && previous.map_or(Ok(true), |previous| {
                    graph
                        .scene_order(&previous, &scene)
                        .map(|order| order == Ordering::Less)
                })?,
            "NIR1_GRAPH_FRAME_SCENE_ORDER"
        );
        seen[index] = scene.scene_id;
        previous = Some(scene);
    }
    ensure!(
        c.position - section_start <= MAX_SCENE_SECTION_BYTES,
        "NIR1_GRAPH_FRAME_SCENE_LIMIT"
    );
    Ok(graph)
}

/// The path starts at the seed, follows the Graph traversal rule, reaches a
/// hop-1 node after the first edge and ends at the pinned Entity's hop.
fn validate_scene_path(
    graph: &GraphView<'_>,
    nodes: &NodeTable<'_>,
    scene: &SceneView<'_>,
) -> Result<()> {
    let mut at = graph.seed;
    for (step, index) in scene.path.edge_indices().iter().enumerate() {
        let relation = graph.relation(*index)?;
        let reached = relation
            .traverse_from(at)
            .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_SCENE_PATH"))?;
        ensure!(
            nodes
                .hop(reached)
                .is_some_and(|hop| usize::from(hop) == step + 1),
            "NIR1_GRAPH_FRAME_SCENE_PATH"
        );
        at = reached;
    }
    ensure!(at == scene.pin.entry_id, "NIR1_GRAPH_FRAME_SCENE_PATH");
    Ok(())
}

/// Complete structural validation including trailing bytes; this never allocates.
pub fn validate(bytes: &[u8]) -> Result<FrameView<'_>> {
    ensure!(bytes.len() <= FRAME_BYTES, "NIR1_GRAPH_FRAME_LIMIT");
    let mut c = Cursor::at(bytes, 0);
    let magic = c.take(4)?;
    ensure!(
        !RETIRED_MAGICS
            .iter()
            .any(|retired| magic == retired.as_slice()),
        "NIR1_GRAPH_FRAME_VERSION"
    );
    ensure!(magic == MAGIC, "NIR1_GRAPH_FRAME_MAGIC");
    let available = match c.byte()? {
        0 => false,
        1 => true,
        _ => bail!("NIR1_GRAPH_FRAME_ENUM"),
    };
    let project = c.text()?;
    let query_scene = c.text()?;
    let outcome = if available {
        FrameOutcome::Available(validate_graph(&mut c)?)
    } else {
        FrameOutcome::Unavailable(
            UnavailableReason::parse(c.text()?)
                .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_REASON"))?,
        )
    };
    ensure!(c.position == bytes.len(), "NIR1_GRAPH_FRAME_TRAILING");
    Ok(FrameView {
        project,
        query_scene,
        outcome,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence_bytes(quote: &str, start: u32, end: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        for value in ["id", "source", quote] {
            bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.extend_from_slice(&start.to_le_bytes());
        bytes.extend_from_slice(&end.to_le_bytes());
        bytes
    }

    #[test]
    fn evidence_offsets_are_source_relative_utf16_ranges() -> Result<()> {
        let bytes = evidence_bytes("猫🙂", 8, 11);
        let mut cursor = Cursor::at(&bytes, 0);
        let evidence = cursor.evidence()?;
        assert_eq!(
            (evidence.start, evidence.end, evidence.quote),
            (8, 11, "猫🙂")
        );

        for (start, end) in [(8, 10), (11, 8)] {
            let bytes = evidence_bytes("猫🙂", start, end);
            let mut cursor = Cursor::at(&bytes, 0);
            assert!(cursor.evidence().is_err());
        }
        Ok(())
    }

    #[test]
    fn malformed_child_frame_rejected_before_view() -> Result<()> {
        let mut raw =
            b"NQG3\x00\x01\x00\x00\x00x\x01\x00\x00\x00s\x11\x00\x00\x00query-invalidated".to_vec();
        assert_eq!(
            validate(&raw)?.unavailable_reason(),
            Some(UnavailableReason::QueryInvalidated)
        );
        raw.push(0);
        assert!(validate(&raw).is_err());
        raw.pop();
        raw[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate(&raw).is_err());
        raw[5..9].copy_from_slice(&1_u32.to_le_bytes());
        raw[9] = 0xff;
        assert!(validate(&raw).is_err());
        Ok(())
    }

    use crate::narrative_extraction::nir1_graph::Nir1QualifiedGraph;
    use std::collections::HashSet;
    use std::sync::Arc;

    const SCOPE_TOKEN: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn binding(revision: &str) -> Arc<Nir1GraphMaterialBinding> {
        Arc::new(Nir1GraphMaterialBinding {
            revision_id: revision.into(),
            decision_id: format!("{revision}:decision"),
            decision_token: format!("{revision}:decision-token"),
            freshness_token: format!("{revision}:freshness"),
            scope_authority_revision: "scope-authority".into(),
            query_scene_source_token: "v1@2026-10-13T00:00:00Z".into(),
            query_scene_scope_token: SCOPE_TOKEN.into(),
            query_scene_incarnation_id: "query-incarnation".into(),
            reveal_state_token: format!("{revision}:reveal"),
        })
    }

    fn entity(id: &str) -> Arc<EntityInput> {
        let quote = format!("{id} 日本語🙂");
        Arc::new(EntityInput {
            entity_id: id.into(),
            entity_type: "character".into(),
            label: format!("Label {id}"),
            source_token: format!("codex:{id}@v1"),
            scope: ScopeBinding {
                reading: ScopeValue::Exact {
                    value: "scene:source".into(),
                },
                story: ScopeValue::Any {
                    purpose: Some("story".into()),
                },
                auto: ScopeValue::Unresolved,
                phase: "draft".into(),
                reveal: "visible".into(),
                pov: Some("pov".into()),
                authority_revision: "scope-authority".into(),
            },
            evidence: vec![
                EvidenceInput {
                    evidence_id: format!("{id}:evidence"),
                    source_ref: format!("codex:{id}"),
                    end_utf16: 3 + quote.encode_utf16().count(),
                    quote,
                    start_utf16: 3,
                },
                EvidenceInput {
                    evidence_id: format!("{id}:empty"),
                    source_ref: format!("codex:{id}"),
                    quote: String::new(),
                    start_utf16: 0,
                    end_utf16: 0,
                },
            ],
        })
    }

    fn relation(edge_id: &str, from: &str, to: &str, directionality: &str) -> Arc<GraphEdgeInput> {
        Arc::new(GraphEdgeInput {
            edge_id: edge_id.into(),
            from_entity_id: from.into(),
            to_entity_id: to.into(),
            relation_type: "knows".into(),
            directionality: directionality.into(),
            source_token: format!("v1@relation:{edge_id}"),
            evidence_ids: vec![format!("{from}:evidence"), format!("{to}:evidence")],
        })
    }

    fn edge(
        edge_id: &str,
        from: &str,
        to: &str,
        directionality: &str,
        revision: &str,
    ) -> Nir1GraphEdge {
        Nir1GraphEdge {
            relation: relation(edge_id, from, to, directionality),
            from: entity(from),
            to: entity(to),
            binding: binding(revision),
        }
    }

    /// The Scope of an Entity in the `index`-th Revision that carries it: the
    /// first is the Entity's own, each later one was reviewed under another
    /// Scene.
    fn binding_scope(entity: &EntityInput, index: usize, revision: &str) -> Arc<ScopeBinding> {
        let mut scope = entity.scope.clone();
        if index > 0 {
            scope.reading = ScopeValue::Exact {
                value: format!("scene:{revision}"),
            };
        }
        Arc::new(scope)
    }

    fn node(id: &str, hop: u8, revisions: &[&str]) -> Nir1GraphNode {
        let entity = entity(id);
        Nir1GraphNode {
            binding_scopes: revisions
                .iter()
                .enumerate()
                .map(|(index, revision)| binding_scope(&entity, index, revision))
                .collect(),
            entity,
            hop,
            bindings: revisions.iter().map(|revision| binding(revision)).collect(),
        }
    }

    fn association(
        scene_id: &str,
        bound: bool,
        rowid: i64,
        entry: &str,
        path: &[u16],
    ) -> Nir1GraphSceneAssociation {
        Nir1GraphSceneAssociation {
            scene_id: scene_id.into(),
            scene_incarnation_id: bound.then(|| format!("{scene_id}:incarnation")),
            scene_source_token: format!("v{rowid}@2026-10-13T00:00:00.000Z"),
            scene_scope_token: bound.then(|| SCOPE_TOKEN.to_owned()),
            pin_rowid: rowid,
            pin_entry_id: entry.into(),
            pin_created_at: "2026-10-13T00:00:01.000Z".into(),
            path_hop: u8::try_from(path.len()).unwrap(),
            path_edge_indices: path.to_vec(),
        }
    }

    /// seed s; x and y at hop 1 (y only through a symmetric edge read from
    /// its target); z at hop 2 through x. Associations in tuple order.
    fn sample_response() -> Nir1GraphResponse {
        Nir1GraphResponse {
            status: "available",
            project_id: "project".into(),
            query_scene_id: "query-scene".into(),
            scope_revision: Some("scope-authority".into()),
            graph: Some(Nir1QualifiedGraph {
                seed_entity_id: "s".into(),
                generation: 7,
                nodes: vec![
                    node("s", 0, &["r1"]),
                    node("x", 1, &["r1", "r2"]),
                    node("y", 1, &["r1"]),
                    node("z", 2, &["r2"]),
                ],
                edges: vec![
                    edge("e0", "s", "x", "directed", "r1"),
                    edge("e1", "y", "s", "symmetric", "r1"),
                    edge("e2", "x", "z", "directed", "r2"),
                ],
                scene_total: 4,
                scenes: vec![
                    association("scene-a", true, 7, "x", &[0]),
                    association("scene-b", false, 8, "y", &[1]),
                    association("scene-c", true, 9, "z", &[0, 2]),
                    association("scene-d", false, 10, "z", &[0, 2]),
                ],
            }),
            reason: None,
        }
    }

    fn unavailable_response(reason: &str) -> Nir1GraphResponse {
        Nir1GraphResponse {
            status: "unavailable",
            project_id: "project".into(),
            query_scene_id: "query-scene".into(),
            scope_revision: None,
            graph: None,
            reason: Some(reason.into()),
        }
    }

    /// The encode layout with arbitrary Scene-section values and none of
    /// encode's own Scene checks, so validate alone is under test.
    fn raw_frame(
        response: &Nir1GraphResponse,
        generation: i64,
        scene_total: usize,
        scenes: &[Nir1GraphSceneAssociation],
    ) -> Vec<u8> {
        let graph = response.graph.as_ref().unwrap();
        let mut w = Writer::new();
        w.add(MAGIC).unwrap();
        w.byte(1).unwrap();
        w.text(&response.project_id).unwrap();
        w.text(&response.query_scene_id).unwrap();
        w.optional(response.scope_revision.as_deref()).unwrap();
        w.i64(generation).unwrap();
        w.text(&graph.seed_entity_id).unwrap();
        w.u16(graph.nodes.len()).unwrap();
        w.u16(graph.edges.len()).unwrap();
        for node in &graph.nodes {
            w.node(node).unwrap();
        }
        for edge in &graph.edges {
            w.edge(edge).unwrap();
        }
        w.u16(scene_total).unwrap();
        w.u16(scenes.len()).unwrap();
        for scene in scenes {
            w.scene(scene).unwrap();
        }
        w.bytes
    }

    fn scope_view(value: &ScopeValue) -> ScopeView<'_> {
        match value {
            ScopeValue::Any { purpose } => ScopeView::Any(purpose.as_deref()),
            ScopeValue::Exact { value } => ScopeView::Exact(value),
            ScopeValue::NotApplicable { reason } => ScopeView::NotApplicable(reason),
            ScopeValue::Unavailable { reason } => ScopeView::Unavailable(reason),
            ScopeValue::LegacyAbsent => ScopeView::LegacyAbsent,
            ScopeValue::Unresolved => ScopeView::Unresolved,
        }
    }

    fn scope_binding_view(scope: &ScopeBinding) -> ScopeBindingView<'_> {
        ScopeBindingView {
            reading: scope_view(&scope.reading),
            story: scope_view(&scope.story),
            auto: scope_view(&scope.auto),
            phase: &scope.phase,
            reveal: &scope.reveal,
            pov: scope.pov.as_deref(),
            authority_revision: &scope.authority_revision,
        }
    }

    fn assert_entity(view: &EntityView<'_>, entity: &EntityInput) -> Result<()> {
        assert_eq!(
            (view.id, view.kind, view.label, view.source),
            (
                entity.entity_id.as_str(),
                entity.entity_type.as_str(),
                entity.label.as_str(),
                entity.source_token.as_str()
            )
        );
        assert_eq!(view.scope, scope_binding_view(&entity.scope));
        assert_eq!(view.evidence_count(), entity.evidence.len());
        let evidence = view.evidence().collect::<Result<Vec<_>>>()?;
        assert_eq!(evidence.len(), entity.evidence.len());
        for (view, input) in evidence.iter().zip(&entity.evidence) {
            assert_eq!(
                *view,
                EvidenceView {
                    id: &input.evidence_id,
                    source: &input.source_ref,
                    quote: &input.quote,
                    start: u32::try_from(input.start_utf16)?,
                    end: u32::try_from(input.end_utf16)?,
                }
            );
        }
        Ok(())
    }

    fn binding_view(binding: &Nir1GraphMaterialBinding) -> BindingView<'_> {
        BindingView {
            revision_id: &binding.revision_id,
            decision_id: &binding.decision_id,
            decision_token: &binding.decision_token,
            freshness_token: &binding.freshness_token,
            scope_authority_revision: &binding.scope_authority_revision,
            query_scene_source_token: &binding.query_scene_source_token,
            query_scene_scope_token: &binding.query_scene_scope_token,
            query_scene_incarnation_id: &binding.query_scene_incarnation_id,
            reveal_state_token: &binding.reveal_state_token,
        }
    }

    fn error_text<T: std::fmt::Debug>(result: Result<T>) -> String {
        result.expect_err("frame must be refused").to_string()
    }

    #[test]
    fn nqg3_round_trip_projects_every_node_edge_binding_and_scene() -> Result<()> {
        let response = sample_response();
        let bytes = encode(&response)?;
        let view = validate(&bytes)?;
        let expected = response.graph.as_ref().unwrap();
        assert_eq!(view.project(), "project");
        assert_eq!(view.query_scene(), "query-scene");
        assert_eq!(view.unavailable_reason(), None);
        let graph = view.graph().expect("available frame");
        assert_eq!(graph.scope_revision(), Some("scope-authority"));
        assert_eq!(graph.generation(), 7);
        assert_eq!(graph.seed(), "s");

        assert_eq!(graph.node_count(), expected.nodes.len());
        let nodes = graph.nodes().collect::<Result<Vec<_>>>()?;
        assert_eq!(nodes.len(), expected.nodes.len());
        for (view, node) in nodes.iter().zip(&expected.nodes) {
            assert_entity(&view.entity, &node.entity)?;
            assert_eq!(view.hop, node.hop);
            assert_eq!(view.binding_count(), node.bindings.len());
            let bindings = view.bindings().collect::<Result<Vec<_>>>()?;
            assert_eq!(
                bindings,
                node.bindings
                    .iter()
                    .zip(&node.binding_scopes)
                    .map(|(binding, scope)| NodeBindingView {
                        binding: binding_view(binding),
                        scope: scope_binding_view(scope),
                    })
                    .collect::<Vec<_>>()
            );
        }

        assert_eq!(graph.edge_count(), expected.edges.len());
        let edges = graph.edges().collect::<Result<Vec<_>>>()?;
        assert_eq!(edges.len(), expected.edges.len());
        for (index, (view, edge)) in edges.iter().zip(&expected.edges).enumerate() {
            let relation = &edge.relation;
            assert_eq!(
                (
                    view.relation.edge_id,
                    view.relation.from_entity_id,
                    view.relation.to_entity_id,
                    view.relation.relation_type,
                    view.relation.directionality.as_str(),
                    view.relation.source_token,
                ),
                (
                    relation.edge_id.as_str(),
                    relation.from_entity_id.as_str(),
                    relation.to_entity_id.as_str(),
                    relation.relation_type.as_str(),
                    relation.directionality.as_str(),
                    relation.source_token.as_str(),
                )
            );
            assert_eq!(
                view.relation.evidence_id_count(),
                relation.evidence_ids.len()
            );
            assert_eq!(
                view.relation.evidence_ids().collect::<Result<Vec<_>>>()?,
                relation
                    .evidence_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
            );
            assert_entity(&view.from, &edge.from)?;
            assert_entity(&view.to, &edge.to)?;
            assert_eq!(view.binding, binding_view(&edge.binding));
            // O(1) random access re-reads the same validated edge.
            assert_eq!(graph.edge(index)?.relation.edge_id, relation.edge_id);
        }
        assert!(graph.edge(expected.edges.len()).is_err());

        assert_eq!(graph.diagnostic_scene_total(), 4);
        assert_eq!(graph.scene_count(), expected.scenes.len());
        let scenes = graph.scenes().collect::<Result<Vec<_>>>()?;
        assert_eq!(scenes.len(), expected.scenes.len());
        for (view, scene) in scenes.iter().zip(&expected.scenes) {
            assert_eq!(
                *view,
                SceneView {
                    scene_id: &scene.scene_id,
                    scene_incarnation_id: scene.scene_incarnation_id.as_deref(),
                    scene_source_token: &scene.scene_source_token,
                    scene_scope_token: scene.scene_scope_token.as_deref(),
                    pin: PinView {
                        rowid: scene.pin_rowid,
                        entry_id: &scene.pin_entry_id,
                        created_at: &scene.pin_created_at,
                    },
                    path: view.path,
                }
            );
            assert_eq!(view.path.hop(), scene.path_hop);
            assert_eq!(view.path.edge_indices(), scene.path_edge_indices.as_slice());
        }

        // Paths resolve to traversal-order steps; the symmetric edge is read
        // from its target.
        let steps = |scene: &SceneView<'_>| -> Result<Vec<(u16, String, String, String)>> {
            Ok(graph
                .scene_path(scene)?
                .steps()
                .map(|step| {
                    (
                        step.edge_index,
                        step.edge.relation.edge_id.to_owned(),
                        step.from.to_owned(),
                        step.to.to_owned(),
                    )
                })
                .collect())
        };
        assert_eq!(
            steps(&scenes[0])?,
            vec![(0, "e0".into(), "s".into(), "x".into())]
        );
        assert_eq!(
            steps(&scenes[1])?,
            vec![(1, "e1".into(), "s".into(), "y".into())]
        );
        assert_eq!(
            steps(&scenes[2])?,
            vec![
                (0, "e0".into(), "s".into(), "x".into()),
                (2, "e2".into(), "x".into(), "z".into())
            ]
        );
        assert_eq!(graph.scene_path(&scenes[2])?.len(), 2);
        Ok(())
    }

    #[test]
    fn nqg3_rejects_every_strict_prefix_and_any_trailing_byte() -> Result<()> {
        for response in [
            sample_response(),
            unavailable_response("registration-drift"),
        ] {
            let bytes = encode(&response)?;
            validate(&bytes)?;
            for end in 0..bytes.len() {
                assert!(validate(&bytes[..end]).is_err(), "prefix {end} accepted");
            }
            let mut trailing = bytes.clone();
            trailing.push(0);
            assert_eq!(error_text(validate(&trailing)), "NIR1_GRAPH_FRAME_TRAILING");
        }
        Ok(())
    }

    #[test]
    fn nqg3_rejects_the_retired_frames() -> Result<()> {
        // An NQG1 frame is the current body without its Scene section.
        let mut response = sample_response();
        let graph = response.graph.as_mut().unwrap();
        graph.scene_total = 0;
        graph.scenes.clear();
        let current = encode(&response)?;
        validate(&current)?;
        let mut nqg1 = current[..current.len() - SCENE_SECTION_HEADER_BYTES].to_vec();
        for retired in [b"NQG1", b"NQG2"] {
            nqg1[..4].copy_from_slice(retired);
            assert_eq!(error_text(validate(&nqg1)), "NIR1_GRAPH_FRAME_VERSION");
        }
        // The old body cannot pass as NQG3 either.
        nqg1[..4].copy_from_slice(MAGIC);
        assert!(validate(&nqg1).is_err());

        let mut unavailable = encode(&unavailable_response("query-invalidated"))?;
        for retired in [b"NQG1", b"NQG2"] {
            unavailable[..4].copy_from_slice(retired);
            assert_eq!(
                error_text(validate(&unavailable)),
                "NIR1_GRAPH_FRAME_VERSION"
            );
        }
        unavailable[..4].copy_from_slice(b"NQG4");
        assert_eq!(error_text(validate(&unavailable)), "NIR1_GRAPH_FRAME_MAGIC");
        Ok(())
    }

    fn empty_graph_response() -> Nir1GraphResponse {
        Nir1GraphResponse {
            status: "available",
            project_id: "project".into(),
            query_scene_id: "query-scene".into(),
            scope_revision: None,
            graph: Some(Nir1QualifiedGraph {
                seed_entity_id: "s".into(),
                generation: 7,
                nodes: Vec::new(),
                edges: Vec::new(),
                scene_total: 0,
                scenes: Vec::new(),
            }),
            reason: None,
        }
    }

    // A seed with no qualified Revision is an available, empty Graph in the
    // in-process reader; the frame can say so (it used to fail to encode,
    // which ended the worker with exit 1).
    #[test]
    fn nqg3_carries_an_empty_graph_without_a_scope_revision() -> Result<()> {
        let response = empty_graph_response();
        let bytes = encode(&response)?;
        let view = validate(&bytes)?;
        let graph = view.graph().expect("an empty Graph is available");
        assert_eq!(graph.scope_revision(), None);
        assert_eq!(graph.generation(), 7);
        assert_eq!(graph.seed(), "s");
        assert_eq!(
            (graph.node_count(), graph.edge_count(), graph.scene_count()),
            (0, 0, 0)
        );
        assert_eq!(graph.diagnostic_scene_total(), 0);

        use crate::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
        let projection = Nir1GraphProjection::from_frame(&view, std::time::Duration::ZERO)?;
        assert_eq!(projection.scope_revision, None);
        assert!(projection.graph.nodes.is_empty() && projection.graph.edges.is_empty());
        assert_eq!(encode(&projection.into_response())?, bytes);

        // A qualified Revision that does not hold the seed gives a Scope
        // revision and still no node.
        let mut scoped = empty_graph_response();
        scoped.scope_revision = Some("scope-authority".into());
        validate(&encode(&scoped)?)?;

        // No Scope revision cannot carry a node or an edge, and a present one
        // is never empty.
        let mut with_node = sample_response();
        with_node.scope_revision = None;
        assert_eq!(error_text(encode(&with_node)), "NIR1_GRAPH_FRAME_SCOPE");
        let mut empty_scope = empty_graph_response();
        empty_scope.scope_revision = Some(String::new());
        assert_eq!(error_text(encode(&empty_scope)), "NIR1_GRAPH_FRAME_SCOPE");
        // The same refusals on the validating side, from raw frames.
        let forge = |response: &Nir1GraphResponse, scope: Option<&str>| -> Vec<u8> {
            let graph = response.graph.as_ref().unwrap();
            let mut w = Writer::new();
            w.add(MAGIC).unwrap();
            w.byte(1).unwrap();
            w.text(&response.project_id).unwrap();
            w.text(&response.query_scene_id).unwrap();
            w.optional(scope).unwrap();
            w.i64(graph.generation).unwrap();
            w.text(&graph.seed_entity_id).unwrap();
            w.u16(graph.nodes.len()).unwrap();
            w.u16(graph.edges.len()).unwrap();
            for node in &graph.nodes {
                w.node(node).unwrap();
            }
            for edge in &graph.edges {
                w.edge(edge).unwrap();
            }
            w.u16(0).unwrap();
            w.u16(0).unwrap();
            w.bytes
        };
        assert_eq!(
            error_text(validate(&forge(&sample_response(), None))),
            "NIR1_GRAPH_FRAME_SCOPE"
        );
        assert_eq!(
            error_text(validate(&forge(&empty_graph_response(), Some("")))),
            "NIR1_GRAPH_FRAME_SCOPE"
        );
        validate(&forge(&empty_graph_response(), None))?;
        Ok(())
    }

    // A node keeps one exact Scope per binding, and its Entity is the first
    // binding's version.
    #[test]
    fn nqg3_node_scopes_are_per_binding_and_anchored_to_the_first() -> Result<()> {
        let response = sample_response();
        let bytes = encode(&response)?;
        let view = validate(&bytes)?;
        let nodes = view.graph().unwrap().nodes().collect::<Result<Vec<_>>>()?;
        // x is reached through r1 and r2, which scoped it differently.
        let x = nodes.iter().find(|node| node.entity.id == "x").unwrap();
        assert_eq!(x.binding_count(), 2);
        let scopes = x
            .bindings()
            .map(|item| item.map(|item| item.scope))
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(scopes[0], x.entity.scope);
        assert_ne!(scopes[0], scopes[1]);
        assert_eq!(scopes[1].reading, ScopeView::Exact("scene:r2"));

        let forge = |change: &dyn Fn(&mut Nir1GraphNode)| -> Vec<u8> {
            let mut response = sample_response();
            change(&mut response.graph.as_mut().unwrap().nodes[1]);
            raw_frame(&response, 7, 4, &response.graph.as_ref().unwrap().scenes)
        };
        // A node without a binding, a Scope list shorter than its bindings
        // and a first Scope that is not the Entity's cannot be forged past
        // encode, and validate refuses them in a forged frame.
        let mut hollow = sample_response();
        hollow.graph.as_mut().unwrap().nodes[1].bindings.clear();
        hollow.graph.as_mut().unwrap().nodes[1]
            .binding_scopes
            .clear();
        assert_eq!(error_text(encode(&hollow)), "NIR1_GRAPH_FRAME_COUNT");
        let mut short = sample_response();
        short.graph.as_mut().unwrap().nodes[1].binding_scopes.pop();
        assert_eq!(error_text(encode(&short)), "NIR1_GRAPH_FRAME_COUNT");
        let moved = forge(&|node| {
            let mut scope = (*node.binding_scopes[0]).clone();
            scope.phase = "another-phase".into();
            node.binding_scopes[0] = Arc::new(scope);
        });
        assert_eq!(error_text(validate(&moved)), "NIR1_GRAPH_FRAME_NODE_SCOPE");
        // A node with no bindings, written as a count of zero.
        let mut zero = forge(&|_| {});
        let mut raw_hollow = sample_response();
        {
            let node = &mut raw_hollow.graph.as_mut().unwrap().nodes[1];
            node.bindings.clear();
            node.binding_scopes.clear();
        }
        let hollow_node = {
            let mut w = Writer::new();
            w.entity(&raw_hollow.graph.as_ref().unwrap().nodes[1].entity)
                .unwrap();
            w.byte(1).unwrap();
            w.u16(0).unwrap();
            w.bytes
        };
        let full_node = {
            let mut w = Writer::new();
            w.node(&sample_response().graph.unwrap().nodes[1]).unwrap();
            w.bytes
        };
        let at = zero
            .windows(full_node.len())
            .position(|window| window == full_node.as_slice())
            .expect("the forged frame holds the node");
        zero.splice(at..at + full_node.len(), hollow_node);
        assert_eq!(error_text(validate(&zero)), "NIR1_GRAPH_FRAME_NODE_BINDING");
        Ok(())
    }

    /// `count` distinct Revision ids.
    fn revision_ids(count: usize) -> Vec<String> {
        (0..count).map(|index| format!("rev-{index:03}")).collect()
    }

    /// The frame of `sample_response` with node `x` bound by `revisions`, each
    /// with the Scope its review gave. Written with the Writer's parts so the
    /// node can break what the parent's `validate` checks: `encode` refuses a
    /// node over the cap, and the worker never writes a repeated Revision.
    fn frame_with_x_bound_by(revisions: &[String]) -> Vec<u8> {
        let response = sample_response();
        let graph = response.graph.as_ref().unwrap();
        let x = &graph.nodes[1];
        let original = {
            let mut w = Writer::new();
            w.node(x).unwrap();
            w.bytes
        };
        let replacement = {
            let mut w = Writer::new();
            w.entity(&x.entity).unwrap();
            w.byte(x.hop).unwrap();
            w.u16(revisions.len()).unwrap();
            for (index, revision) in revisions.iter().enumerate() {
                w.binding(&binding(revision)).unwrap();
                w.scope(&binding_scope(&x.entity, index, revision)).unwrap();
            }
            w.bytes
        };
        let mut frame = raw_frame(&response, 7, 4, &graph.scenes);
        let at = frame
            .windows(original.len())
            .position(|window| window == original.as_slice())
            .expect("the frame holds the node");
        frame.splice(at..at + original.len(), replacement);
        frame
    }

    // A node holds at most MAX_GRAPH_QUERY_RECORDS bindings: 2,048 pass encode
    // and validate and are read back one by one; a 2,049th is refused on both
    // sides. (One Revision's own records stay at MAX_GRAPH_RECORDS, 512.)
    #[test]
    fn nqg3_node_binding_cap_admits_2048_and_refuses_2049() -> Result<()> {
        let response_with = |count: usize| {
            let revisions = revision_ids(count);
            let refs = revisions.iter().map(String::as_str).collect::<Vec<_>>();
            let mut response = sample_response();
            response.graph.as_mut().unwrap().nodes[1] = node("x", 1, &refs);
            response
        };
        let at_cap = revision_ids(MAX_GRAPH_QUERY_RECORDS);
        let bytes = encode(&response_with(MAX_GRAPH_QUERY_RECORDS))?;
        assert_eq!(bytes, frame_with_x_bound_by(&at_cap));
        let view = validate(&bytes)?;
        let nodes = view.graph().unwrap().nodes().collect::<Result<Vec<_>>>()?;
        let x = nodes.iter().find(|node| node.entity.id == "x").unwrap();
        assert_eq!(x.binding_count(), MAX_GRAPH_QUERY_RECORDS);
        let listed = x
            .bindings()
            .map(|item| item.map(|item| item.binding.revision_id.to_owned()))
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(listed, at_cap);
        // The parent's projection accepts the same 2,048 bindings.
        let projected = super::super::worker_projection::Nir1GraphProjection::from_frame(
            &view,
            std::time::Duration::ZERO,
        )?
        .into_response();
        let projected = projected.graph.expect("an available Graph");
        let x = projected
            .nodes
            .iter()
            .find(|node| node.entity.entity_id == "x")
            .expect("node x");
        assert_eq!(x.bindings.len(), MAX_GRAPH_QUERY_RECORDS);
        assert_eq!(x.binding_scopes.len(), MAX_GRAPH_QUERY_RECORDS);

        assert_eq!(
            error_text(encode(&response_with(MAX_GRAPH_QUERY_RECORDS + 1))),
            "NIR1_GRAPH_FRAME_COUNT"
        );
        let forged = frame_with_x_bound_by(&revision_ids(MAX_GRAPH_QUERY_RECORDS + 1));
        assert_eq!(error_text(validate(&forged)), "NIR1_GRAPH_FRAME_COUNT");
        Ok(())
    }

    /// A Graph of `nodes` Entities (the seed and `nodes - 1` at hop 1) and
    /// `edges` distinct edges from the seed, no Scene. Written through
    /// `raw_frame` so the counts the parent's `validate` checks can be forged
    /// past what `encode` allows.
    fn graph_of(nodes: usize, edges: usize) -> Nir1GraphResponse {
        let mut response = sample_response();
        let graph = response.graph.as_mut().unwrap();
        graph.nodes = std::iter::once(node("s", 0, &["r1"]))
            .chain((1..nodes).map(|index| node(&format!("n{index:02}"), 1, &["r1"])))
            .collect();
        graph.edges = (0..edges)
            .map(|index| {
                edge(
                    &format!("e{index:03}"),
                    "s",
                    &format!("n{:02}", 1 + index % (nodes - 1)),
                    "directed",
                    "r1",
                )
            })
            .collect();
        graph.scene_total = 0;
        graph.scenes.clear();
        response
    }

    // The Graph holds at most MAX_GRAPH_NODES Entities and MAX_GRAPH_EDGES
    // distinct edges (proposal/7: 50 and 512, they were 12 and 144): the
    // largest Graph encodes, validates and projects, the one past either count
    // is refused on both sides.
    #[test]
    fn nqg3_graph_counts_admit_50_nodes_and_512_edges_and_refuse_51_and_513() -> Result<()> {
        use super::super::worker_projection::Nir1GraphProjection;
        let at_limit = graph_of(MAX_GRAPH_NODES, MAX_GRAPH_EDGES);
        let bytes = encode(&at_limit)?;
        assert!(
            bytes.len() < FRAME_BYTES,
            "{} of {FRAME_BYTES}",
            bytes.len()
        );
        assert_eq!(
            bytes,
            raw_frame(&at_limit, 7, 0, &[]),
            "encode writes the layout the forging helper does"
        );
        let view = validate(&bytes)?;
        let graph = view.graph().unwrap();
        assert_eq!((graph.node_count(), graph.edge_count()), (50, 512));
        let projected =
            Nir1GraphProjection::from_frame(&view, std::time::Duration::ZERO)?.into_response();
        let projected = projected.graph.expect("an available Graph");
        assert_eq!((projected.nodes.len(), projected.edges.len()), (50, 512));

        for (nodes, edges) in [(MAX_GRAPH_NODES + 1, 1), (2, MAX_GRAPH_EDGES + 1)] {
            let over = graph_of(nodes, edges);
            assert_eq!(error_text(encode(&over)), "NIR1_GRAPH_FRAME_COUNT");
            assert_eq!(
                error_text(validate(&raw_frame(&over, 7, 0, &[]))),
                "NIR1_GRAPH_FRAME_COUNT",
                "{nodes} nodes, {edges} edges"
            );
        }
        Ok(())
    }

    // The frame is at most FRAME_BYTES (proposal/7: the Native area is 3 MiB, so
    // the frame limit follows it; it was 1.5 MiB). A frame of exactly that size
    // encodes and validates, and one byte more is refused on both sides with
    // the frame-limit reason, the reason the parent maps to an unavailable Graph.
    // The project identifier is free text here, so it carries the padding.
    #[test]
    fn frame_of_exactly_frame_bytes_is_admitted_and_one_more_byte_is_refused() -> Result<()> {
        let padded = |project_bytes: usize| {
            let mut response = sample_response();
            response.project_id = "p".repeat(project_bytes);
            response
        };
        let base = encode(&padded(0))?.len();
        let at_limit = encode(&padded(FRAME_BYTES - base))?;
        assert_eq!(at_limit.len(), FRAME_BYTES);
        let view = validate(&at_limit)?;
        assert_eq!(view.project().len(), FRAME_BYTES - base);
        assert_eq!(
            error_text(encode(&padded(FRAME_BYTES - base + 1))),
            "NIR1_GRAPH_FRAME_LIMIT"
        );
        let mut over = at_limit.clone();
        over.push(0);
        assert_eq!(error_text(validate(&over)), "NIR1_GRAPH_FRAME_LIMIT");
        Ok(())
    }

    // The largest Graph the query limits allow (50 Entities, 512 edges, and 2,000
    // distinct Revisions bound across the nodes, about the 2,048 records a query
    // may read) with every string short: it fits the frame limit with room, so the
    // frame limit is reached by the content (long quotes, many Scenes), not by the
    // counts. The size is printed for the record (CQ-LIM-2, DR-CQL-10).
    #[test]
    fn frame_of_the_largest_counts_fits_the_frame_limit() -> Result<()> {
        use super::super::worker_projection::Nir1GraphProjection;
        let mut response = graph_of(MAX_GRAPH_NODES, MAX_GRAPH_EDGES);
        let graph = response.graph.as_mut().unwrap();
        for (index, node) in graph.nodes.iter_mut().enumerate() {
            let revisions: Vec<String> = std::iter::once("r1".to_owned())
                .chain((0..40).map(|local| format!("x{index:02}-{local:02}")))
                .collect();
            let refs: Vec<&str> = revisions.iter().map(String::as_str).collect();
            *node = self::node(&node.entity.entity_id.clone(), node.hop, &refs);
        }
        let bytes = encode(&response)?;
        let view = validate(&bytes)?;
        assert_eq!(view.graph().unwrap().node_count(), MAX_GRAPH_NODES);
        let projected = Nir1GraphProjection::from_frame(&view, std::time::Duration::ZERO)?;
        assert_eq!(
            projected.into_response().graph.unwrap().nodes.len(),
            MAX_GRAPH_NODES
        );
        eprintln!(
            "NQG3 frame of 50 nodes, 512 edges, 2,050 bindings: {} of {FRAME_BYTES} B",
            bytes.len()
        );
        assert!(bytes.len() < FRAME_BYTES);
        Ok(())
    }

    // A Revision gives a node one Scope. A frame that binds the same Revision
    // twice, each time with a Scope of its own, has no single Scope for it and
    // is refused wherever the repeat is; the same Revision in different nodes
    // is the ordinary case.
    #[test]
    fn nqg3_refuses_a_node_that_binds_one_revision_twice() -> Result<()> {
        let duplicate = "NIR1_GRAPH_FRAME_NODE_BINDING_DUPLICATE";
        let twice = frame_with_x_bound_by(&["r1".to_owned(), "r1".to_owned()]);
        assert_eq!(error_text(validate(&twice)), duplicate);
        for repeat_at in [1, MAX_GRAPH_QUERY_RECORDS / 2, MAX_GRAPH_QUERY_RECORDS - 1] {
            let mut revisions = revision_ids(MAX_GRAPH_QUERY_RECORDS);
            revisions[repeat_at] = revisions[0].clone();
            assert_eq!(
                error_text(validate(&frame_with_x_bound_by(&revisions))),
                duplicate,
                "the first Revision repeated at {repeat_at}"
            );
        }
        let distinct = frame_with_x_bound_by(&revision_ids(MAX_GRAPH_QUERY_RECORDS));
        validate(&distinct)?;
        // r1 binds s, x and y in the sample.
        validate(&encode(&sample_response())?)?;
        Ok(())
    }

    #[test]
    fn nqg3_scene_invariants_reject_corrupt_associations() -> Result<()> {
        // e3 is a crafted shortcut from the seed straight to the hop-2 node z.
        let mut response = sample_response();
        let graph = response.graph.as_mut().unwrap();
        graph.edges.push(edge("e3", "s", "z", "directed", "r3"));
        let base = graph.scenes.clone();
        assert!(validate(&raw_frame(&response, 7, 4, &base)).is_ok());
        let with = |index: usize, change: &dyn Fn(&mut Nir1GraphSceneAssociation)| {
            let mut scenes = base.clone();
            change(&mut scenes[index]);
            scenes
        };
        let nine = (0..9)
            .map(|index| association(&format!("scene-{index}"), false, 20 + index, "x", &[0]))
            .collect::<Vec<_>>();
        let cases: Vec<(&str, i64, usize, Vec<Nir1GraphSceneAssociation>, &str)> = vec![
            (
                "count over eight",
                7,
                9,
                nine.clone(),
                "NIR1_GRAPH_FRAME_SCENE_COUNT",
            ),
            (
                "count over total",
                7,
                3,
                base.clone(),
                "NIR1_GRAPH_FRAME_SCENE_COUNT",
            ),
            (
                "count under min(total, 8)",
                7,
                9,
                nine[..7].to_vec(),
                "NIR1_GRAPH_FRAME_SCENE_COUNT",
            ),
            (
                "total over 2048",
                7,
                MAX_GRAPH_QUERY_RECORDS + 1,
                nine[..8].to_vec(),
                "NIR1_GRAPH_FRAME_SCENE_COUNT",
            ),
            (
                "hop 0",
                7,
                4,
                with(0, &|scene| {
                    scene.path_hop = 0;
                    scene.path_edge_indices.clear();
                }),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "hop 3",
                7,
                4,
                with(2, &|scene| {
                    scene.path_hop = 3;
                    scene.path_edge_indices.push(2);
                }),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "edge count differs from hop",
                7,
                4,
                with(0, &|scene| scene.path_edge_indices.push(2)),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "edge index out of range",
                7,
                4,
                with(0, &|scene| scene.path_edge_indices[0] = 4),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "disconnected second step",
                7,
                4,
                with(2, &|scene| scene.path_edge_indices = vec![1, 2]),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "first step not from the seed",
                7,
                4,
                with(2, &|scene| scene.path_edge_indices = vec![2, 0]),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "end is not the pinned Entity",
                7,
                4,
                with(0, &|scene| scene.pin_entry_id = "y".into()),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "pinned Entity is not a node",
                7,
                4,
                with(0, &|scene| scene.pin_entry_id = "q".into()),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "hop-2 Entity at path hop 1",
                7,
                4,
                with(2, &|scene| {
                    scene.path_hop = 1;
                    scene.path_edge_indices = vec![3];
                }),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "intermediate is not a hop-1 node",
                7,
                4,
                with(2, &|scene| scene.path_edge_indices = vec![3, 2]),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                "reversed order",
                7,
                4,
                {
                    let mut scenes = base.clone();
                    scenes.swap(0, 1);
                    scenes
                },
                "NIR1_GRAPH_FRAME_SCENE_ORDER",
            ),
            (
                "reversed Scene IDs",
                7,
                4,
                {
                    let mut scenes = base.clone();
                    scenes.swap(2, 3);
                    scenes
                },
                "NIR1_GRAPH_FRAME_SCENE_ORDER",
            ),
            (
                "adjacent duplicate",
                7,
                4,
                with(3, &|scene| scene.scene_id = "scene-c".into()),
                "NIR1_GRAPH_FRAME_SCENE_ORDER",
            ),
            (
                "duplicate through another Entity",
                7,
                4,
                with(1, &|scene| scene.scene_id = "scene-a".into()),
                "NIR1_GRAPH_FRAME_SCENE_ORDER",
            ),
            (
                "scope token without sha256 prefix",
                7,
                4,
                with(0, &|scene| {
                    scene.scene_scope_token = Some(SCOPE_TOKEN.replace("sha256:", "sha512:"))
                }),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "upper-case scope token",
                7,
                4,
                with(0, &|scene| {
                    scene.scene_scope_token =
                        Some(SCOPE_TOKEN.to_uppercase().replace("SHA256:", "sha256:"))
                }),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "short scope token",
                7,
                4,
                with(0, &|scene| {
                    scene.scene_scope_token = Some(SCOPE_TOKEN[..70].into())
                }),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "incarnation without scope token",
                7,
                4,
                with(0, &|scene| scene.scene_scope_token = None),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "scope token without incarnation",
                7,
                4,
                with(0, &|scene| scene.scene_incarnation_id = None),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "empty incarnation",
                7,
                4,
                with(0, &|scene| scene.scene_incarnation_id = Some(String::new())),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "empty source token",
                7,
                4,
                with(0, &|scene| scene.scene_source_token.clear()),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "zero pin rowid",
                7,
                4,
                with(0, &|scene| scene.pin_rowid = 0),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "negative pin rowid",
                7,
                4,
                with(0, &|scene| scene.pin_rowid = -1),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "empty Scene ID",
                7,
                4,
                with(0, &|scene| scene.scene_id.clear()),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
            (
                "zero generation",
                0,
                4,
                base.clone(),
                "NIR1_GRAPH_FRAME_GENERATION",
            ),
            (
                "negative generation",
                -7,
                4,
                base.clone(),
                "NIR1_GRAPH_FRAME_GENERATION",
            ),
        ];
        for (label, generation, total, scenes, expected) in cases {
            let bytes = raw_frame(&response, generation, total, &scenes);
            assert_eq!(error_text(validate(&bytes)), expected, "{label}");
        }

        let mut duplicate_node = sample_response();
        duplicate_node.graph.as_mut().unwrap().nodes[2] = node("x", 2, &["r1"]);
        assert_eq!(
            error_text(validate(&raw_frame(&duplicate_node, 7, 4, &base))),
            "NIR1_GRAPH_FRAME_NODE_DUPLICATE"
        );

        // Encode refuses the structural violations it can see before writing.
        for (total, scenes, expected) in [
            (3, base.clone(), "NIR1_GRAPH_FRAME_SCENE_COUNT"),
            (9, nine.clone(), "NIR1_GRAPH_FRAME_SCENE_COUNT"),
            (
                4,
                with(0, &|scene| scene.path_edge_indices.push(2)),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                4,
                with(0, &|scene| scene.path_edge_indices[0] = 3),
                "NIR1_GRAPH_FRAME_SCENE_PATH",
            ),
            (
                4,
                with(0, &|scene| scene.scene_scope_token = None),
                "NIR1_GRAPH_FRAME_SCENE_TOKEN",
            ),
        ] {
            let mut invalid = sample_response();
            let graph = invalid.graph.as_mut().unwrap();
            graph.scene_total = total;
            graph.scenes = scenes;
            assert_eq!(error_text(encode(&invalid)), expected);
        }
        Ok(())
    }

    #[test]
    fn nqg3_scene_order_is_utf8_byte_order_not_utf16() -> Result<()> {
        // U+FF5E sorts before U+1F600 in UTF-8 bytes but after it in UTF-16
        // code units; `Z` sorts before `a`.
        let tilde = "\u{FF5E}";
        let emoji = "\u{1F600}";
        assert!(tilde.as_bytes() < emoji.as_bytes());
        assert!(
            tilde.encode_utf16().collect::<Vec<_>>() > emoji.encode_utf16().collect::<Vec<_>>()
        );
        let response = sample_response();
        for (first, second) in [(tilde, emoji), ("Z", "a")] {
            let ordered = vec![
                association(first, false, 7, "x", &[0]),
                association(second, false, 8, "x", &[0]),
            ];
            validate(&raw_frame(&response, 7, 2, &ordered))?;
            let reversed = vec![ordered[1].clone(), ordered[0].clone()];
            assert_eq!(
                error_text(validate(&raw_frame(&response, 7, 2, &reversed))),
                "NIR1_GRAPH_FRAME_SCENE_ORDER"
            );
        }
        Ok(())
    }

    #[test]
    fn nqg3_scene_section_cap_admits_n_and_refuses_n_plus_one() -> Result<()> {
        let template = association("", true, 7, "x", &[0]);
        let without_id = SceneAssociationLengths::of(&template)
            .encoded_bytes()
            .unwrap();
        let exact_id = MAX_SCENE_SECTION_BYTES - SCENE_SECTION_HEADER_BYTES - without_id;
        for (id_bytes, admitted) in [(exact_id, true), (exact_id + 1, false)] {
            let mut scene = template.clone();
            scene.scene_id = "s".repeat(id_bytes);
            let mut response = sample_response();
            let graph = response.graph.as_mut().unwrap();
            graph.scene_total = 1;
            graph.scenes = vec![scene.clone()];
            assert_eq!(
                SCENE_SECTION_HEADER_BYTES
                    + SceneAssociationLengths::of(&scene).encoded_bytes().unwrap(),
                MAX_SCENE_SECTION_BYTES + usize::from(!admitted)
            );
            let raw = raw_frame(&response, 7, 1, std::slice::from_ref(&scene));
            if admitted {
                // The arithmetic is the encoded size: encode writes `raw`.
                assert_eq!(encode(&response)?, raw);
                validate(&raw)?;
            } else {
                assert_eq!(
                    error_text(encode(&response)),
                    "NIR1_GRAPH_FRAME_SCENE_LIMIT"
                );
                assert_eq!(error_text(validate(&raw)), "NIR1_GRAPH_FRAME_SCENE_LIMIT");
            }
        }
        Ok(())
    }

    fn every_allowlisted_reason() -> Vec<UnavailableReason> {
        let mut reasons = UnavailableReason::FIXED.to_vec();
        let statuses = [
            None,
            Some(PreCleanup::WorkOk),
            Some(PreCleanup::DeadlineAlreadyCrossed),
        ]
        .into_iter()
        .chain(
            WorkerCause::ALL
                .into_iter()
                .map(|cause| Some(PreCleanup::WorkFailed(cause))),
        )
        .collect::<Vec<_>>();
        for site in WorkerSite::ALL {
            for cause in WorkerCause::ALL {
                for pre_cleanup in &statuses {
                    reasons.push(UnavailableReason::Worker {
                        site,
                        cause,
                        pre_cleanup: *pre_cleanup,
                    });
                }
            }
        }
        reasons
    }

    #[test]
    fn unavailable_reason_allowlist_round_trips_all_926_and_rejects_others() {
        let reasons = every_allowlisted_reason();
        assert_eq!(reasons.len(), 6 + 2 * 20 * (3 + 20));
        assert_eq!(reasons.len(), 926);
        let mut texts = HashSet::new();
        for reason in &reasons {
            let text = reason.to_string();
            assert_eq!(UnavailableReason::parse(&text), Some(*reason), "{text}");
            assert!(texts.insert(text.clone()), "duplicate text {text}");
            assert!(
                text.bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'-'),
                "{text}"
            );
        }
        for text in &texts {
            for extended in [
                format!("{text}x"),
                format!("{text}-"),
                format!(" {text}"),
                format!("{text}\n"),
            ] {
                assert_eq!(UnavailableReason::parse(&extended), None, "{extended:?}");
            }
            let shortened = &text[..text.len() - 1];
            if !texts.contains(shortened) {
                assert_eq!(UnavailableReason::parse(shortened), None, "{shortened:?}");
            }
        }
        for rejected in [
            "",
            "r",
            "private detail",
            "query-budget-or-validation-failed",
            "Reader-unavailable",
            "query-worker",
            "query-worker-",
            "query-worker-work",
            "query-worker-work-",
            "query-worker-unknown-deadline",
            "query-worker-work-unknown",
            "query-worker-work-deadlinex",
            "query-worker-work-deadline-or",
            "query-worker-work-deadline-or-steps-or-steps",
            "query-worker-work-deadline-pre-cleanup-",
            "query-worker-work-deadline-pre-cleanup-work-failed-",
            "query-worker-work-deadline-pre-cleanup-work-failed-unknown",
            "query-worker-work-deadline-pre-cleanup-work-ok-pre-cleanup-work-ok",
            "NIR1_GRAPH_WORKER_UNAVAILABLE: query-worker-work-deadline",
        ] {
            assert_eq!(UnavailableReason::parse(rejected), None, "{rejected:?}");
        }
    }

    #[test]
    fn encode_and_validate_refuse_non_allowlisted_reasons() -> Result<()> {
        for reason in [
            "r",
            "private detail",
            "query-budget-or-validation-failed",
            "",
        ] {
            assert_eq!(
                error_text(encode(&unavailable_response(reason))),
                "NIR1_GRAPH_FRAME_REASON"
            );
            let mut w = Writer::new();
            w.add(MAGIC)?;
            w.byte(0)?;
            w.text("project")?;
            w.text("query-scene")?;
            w.text(reason)?;
            assert_eq!(error_text(validate(&w.bytes)), "NIR1_GRAPH_FRAME_REASON");
        }
        for reason in every_allowlisted_reason() {
            let bytes = encode(&unavailable_response(&reason.to_string()))?;
            assert_eq!(validate(&bytes)?.unavailable_reason(), Some(reason));
        }
        Ok(())
    }

    #[test]
    fn unavailable_reason_categories_match_the_cp1_table() {
        use UnavailableCategory::*;
        for (reason, category) in [
            (UnavailableReason::ReaderUnavailable, Cancelled),
            (
                UnavailableReason::RegistrationRequired,
                RegistrationUnavailable,
            ),
            (UnavailableReason::RegistrationProjectMismatch, Failed),
            (UnavailableReason::SeedNotFound, Invalidated),
            (UnavailableReason::RegistrationDrift, Stale),
            (UnavailableReason::QueryInvalidated, Timeout),
        ] {
            assert_eq!(reason.category(), category, "{reason}");
        }
        let expected = |cause: WorkerCause| match cause.as_str() {
            "sqlite-nomem"
            | "candidate-record-limit"
            | "revision-record-limit"
            | "disclosure-record-limit"
            | "read-record-limit"
            | "scene-limit"
            | "node-limit"
            | "edge-limit"
            | "steps"
            | "validation-capacity-exceeded" => Limit,
            "deadline" | "deadline-or-steps" => Timeout,
            "validation-cancelled" | "validation-closed" | "validation-foreground-preempted" => {
                Cancelled
            }
            "validation-workspace-generation-changed" => Invalidated,
            "endpoint-version-conflict"
            | "validation-context-unavailable"
            | "validation-cleanup-failed"
            | "other" => Failed,
            other => panic!("unclassified cause {other}"),
        };
        for site in WorkerSite::ALL {
            for cause in WorkerCause::ALL {
                for (pre_cleanup, effective) in [
                    (None, cause),
                    (Some(PreCleanup::WorkOk), cause),
                    (
                        Some(PreCleanup::DeadlineAlreadyCrossed),
                        WorkerCause::Deadline,
                    ),
                    (
                        Some(PreCleanup::WorkFailed(WorkerCause::SceneLimit)),
                        WorkerCause::SceneLimit,
                    ),
                    (
                        Some(PreCleanup::WorkFailed(WorkerCause::Other)),
                        WorkerCause::Other,
                    ),
                ] {
                    let reason = UnavailableReason::Worker {
                        site,
                        cause,
                        pre_cleanup,
                    };
                    assert_eq!(reason.category(), expected(effective), "{reason}");
                }
            }
        }
    }

    #[test]
    fn owned_projection_round_trips_every_record_and_refuses_unavailable_frames() -> Result<()> {
        use crate::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
        use std::sync::Arc;
        use std::time::Duration;

        let bytes = encode(&sample_response())?;
        let view = validate(&bytes)?;
        let projection = Nir1GraphProjection::from_frame(&view, Duration::from_millis(3))?;
        assert_eq!(projection.elapsed, Duration::from_millis(3));
        let graph = &projection.graph;
        for edge in &graph.edges {
            for endpoint in [&edge.from, &edge.to] {
                let node = graph
                    .nodes
                    .iter()
                    .find(|node| *node.entity == **endpoint)
                    .expect("sample edge endpoints are Graph nodes");
                assert!(Arc::ptr_eq(&node.entity, endpoint));
            }
        }
        assert_eq!(encode(&projection.into_response())?, bytes);

        let unavailable = encode(&unavailable_response("registration-drift"))?;
        let view = validate(&unavailable)?;
        assert!(Nir1GraphProjection::from_frame(&view, Duration::ZERO).is_err());
        Ok(())
    }
}
