//! Text-free Graph candidates and their requalification in D-final's snapshot
//! (DI-1a, K6/2 `nir1-final-request-packing-eval`, DSN section 5.1).
//!
//! A worker returns a Graph with Entity labels, Evidence quotes and relation
//! types. D-final takes none of that text. [`Nir1GraphCandidates`] keeps only
//! identifiers and tokens: the project, the query Scene, the seed, B's
//! generation and scope revision, and for each edge its Revision, edge ID, hop
//! and the nine binding tokens the Graph reader recorded.
//!
//! [`pool_graph_candidates`] runs inside the participant read that already
//! evaluated A2 and A3 for the accepted IR. It
//!
//! 1. checks once that B's seal in this snapshot is the generation the worker
//!    answered under,
//! 2. takes each candidate Revision from the A2/A3 results of this snapshot
//!    (a Revision A2 or A3 left out, or one the Native selection did not list,
//!    contributes nothing),
//! 3. compares every binding token with the one this snapshot derives, and
//! 4. builds the `GraphEvidence` group of each admitted relation from the
//!    Revision bundle this snapshot read. The group text is the text of the
//!    relation's accepted IR group; the worker's text is never an input.
//!
//! A Graph group takes the place of the accepted IR group of the same
//! relation, so one relation is never sent twice and the item count does not
//! grow. It costs a few bytes more than the IR group (a longer group ID); when
//! the shared 2 MiB envelope cannot hold that, the Graph group and the later
//! ones are not added and the IR groups stay.

use std::collections::{HashMap, HashSet};

use anyhow::{ensure, Result};
use grimodex_core::narrative_nir1::{
    adapt_candidate_context_item, estimate_nir1_context_tokens, pack_candidate_context,
    CandidateContextItem, CandidatePackingRequest, ContextItemKind, EntityInput, PackedContext,
    PackingPurpose, MAX_GRAPH_EDGES, MAX_PACKING_ITEMS,
};
use rusqlite::{params, Connection, OptionalExtension};

use super::{
    candidate_binding_digest, group_parts, material_evidence_map, reader_part_name,
    relation_group_material, NativeNir1AuthorityBinding, NativeNir1ExcludedRevision,
    NativeNir1RevisionExclusionReason, NativePackingInputBudget, RevisionIndexQualification,
};
use crate::narrative_extraction::nir1_graph::c_query_worker::REQUEST_BYTES;
use crate::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
use crate::narrative_extraction::nir1_graph::{
    read_nir1_graph_seal, Nir1GraphMaterialBinding, Nir1GraphSealRead,
};
use crate::narrative_maintenance_connection::ParticipantSqlOperationBudget;
use crate::nir1_generation::{
    d1_selection_reference, InputReference, InputRole, InputTarget, InputUse,
};
use crate::state::ActiveWorkspaceSnapshot;

const GRAPH_CANDIDATE_BINDING_KIND: &str = "nir1.native.graph-evidence@1";

/// The nine tokens the Graph reader recorded for the Revision of an edge. They
/// are equality keys only: the pooled reader derives the same nine values from
/// its own A2/A3 result and compares them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1GraphCandidateBinding {
    pub revision_id: String,
    pub decision_id: String,
    pub decision_token: String,
    pub freshness_token: String,
    pub scope_authority_revision: String,
    pub query_scene_source_token: String,
    pub query_scene_scope_token: String,
    pub query_scene_incarnation_id: String,
    pub reveal_state_token: String,
}

/// One relation the worker's Graph reached: its identity and the tokens it was
/// qualified under. It carries no relation type, no Entity and no quote.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1GraphCandidateEdge {
    pub edge_id: String,
    /// The shortest-path distance of the edge from the seed (0 for an edge
    /// that leaves the seed).
    pub hop: u8,
    pub binding: Nir1GraphCandidateBinding,
}

impl From<&Nir1GraphMaterialBinding> for Nir1GraphCandidateBinding {
    fn from(binding: &Nir1GraphMaterialBinding) -> Self {
        Self {
            revision_id: binding.revision_id.clone(),
            decision_id: binding.decision_id.clone(),
            decision_token: binding.decision_token.clone(),
            freshness_token: binding.freshness_token.clone(),
            scope_authority_revision: binding.scope_authority_revision.clone(),
            query_scene_source_token: binding.query_scene_source_token.clone(),
            query_scene_scope_token: binding.query_scene_scope_token.clone(),
            query_scene_incarnation_id: binding.query_scene_incarnation_id.clone(),
            reveal_state_token: binding.reveal_state_token.clone(),
        }
    }
}

impl Nir1GraphCandidateEdge {
    pub fn revision_id(&self) -> &str {
        &self.binding.revision_id
    }
}

/// Everything D-final keeps of a worker's Graph. The edges are in the Graph's
/// traversal order (Revision ID, then edge ID).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1GraphCandidates {
    project_id: String,
    query_scene_id: String,
    seed_entity_id: String,
    generation: i64,
    scope_revision: Option<String>,
    edges: Vec<Nir1GraphCandidateEdge>,
}

impl Nir1GraphCandidates {
    pub fn new(
        project_id: String,
        query_scene_id: String,
        seed_entity_id: String,
        generation: i64,
        scope_revision: Option<String>,
        edges: Vec<Nir1GraphCandidateEdge>,
    ) -> Result<Self> {
        ensure!(
            edges.len() <= MAX_GRAPH_EDGES,
            "NIR1_GRAPH_CANDIDATE_EDGE_LIMIT"
        );
        Ok(Self {
            project_id,
            query_scene_id,
            seed_entity_id,
            generation,
            scope_revision,
            edges,
        })
    }

    /// Keep the identifiers and tokens of a validated worker projection and
    /// drop everything else. No label, quote, relation type, Scene
    /// association or pin is read.
    pub fn from_projection(projection: &Nir1GraphProjection) -> Result<Self> {
        let graph = &projection.graph;
        let hops = graph
            .nodes
            .iter()
            .map(|node| (node.entity.entity_id.as_str(), node.hop))
            .collect::<HashMap<_, _>>();
        let mut edges = Vec::with_capacity(graph.edges.len().min(MAX_GRAPH_EDGES));
        ensure!(
            graph.edges.len() <= MAX_GRAPH_EDGES,
            "NIR1_GRAPH_CANDIDATE_EDGE_LIMIT"
        );
        for edge in &graph.edges {
            let from = hops.get(edge.from.entity_id.as_str());
            let to = hops.get(edge.to.entity_id.as_str());
            let (Some(from), Some(to)) = (from, to) else {
                anyhow::bail!("NIR1_GRAPH_CANDIDATE_ENDPOINT_MISSING");
            };
            edges.push(Nir1GraphCandidateEdge {
                edge_id: edge.relation.edge_id.clone(),
                hop: (*from).min(*to),
                binding: Nir1GraphCandidateBinding::from(&*edge.binding),
            });
        }
        Self::new(
            projection.project_id.clone(),
            projection.query_scene_id.clone(),
            graph.seed_entity_id.clone(),
            graph.generation,
            projection.scope_revision.clone(),
            edges,
        )
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn query_scene_id(&self) -> &str {
        &self.query_scene_id
    }

    pub fn seed_entity_id(&self) -> &str {
        &self.seed_entity_id
    }

    pub fn generation(&self) -> i64 {
        self.generation
    }

    pub fn scope_revision(&self) -> Option<&str> {
        self.scope_revision.as_deref()
    }

    pub fn edges(&self) -> &[Nir1GraphCandidateEdge] {
        &self.edges
    }
}

/// What D-final's seed rule found for a query Scene (DI-1a, DR-DI1A-6).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Nir1GraphSeedRead {
    /// The Scene has no pinned Entity: nothing to ask the Graph about.
    NoPin,
    /// The deterministic seed: of the Entities pinned to the Scene, the one
    /// with the smallest `(created_at, entry_id)`.
    Pinned(String),
    /// The chosen pin's Entity ID is longer than a Graph request can carry.
    /// It is reported, never cut.
    TooLarge,
}

/// D-final's seed rule, inside the caller's read transaction.
///
/// The seed is the Entity pinned to the query Scene with the smallest
/// `(created_at, entry_id)`. The Scene must be a live scene and the Entity a
/// Codex entry of the same project. A pin is a locator only: it is neither
/// Relation evidence nor an eligibility input, and the Graph's A2/A3
/// requalification stays the authority for everything that follows.
pub fn read_nir1_graph_seed_in_tx(
    conn: &Connection,
    project_id: &str,
    query_scene_id: &str,
) -> Result<Nir1GraphSeedRead> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_GRAPH_SEED_REQUIRES_READ_TRANSACTION"
    );
    let limit = i64::try_from(REQUEST_BYTES)?;
    let row = conn
        .query_row(
            "SELECT octet_length(p.entry_id),
                    CASE WHEN octet_length(p.entry_id) <= ?3 THEN p.entry_id END
               FROM scene_codex_pins p
               JOIN tree_nodes scene
                 ON scene.id = p.scene_id AND scene.project_id = ?1
                AND scene.node_type = 'scene' AND scene.archived_at IS NULL
               JOIN codex_entries entry
                 ON entry.id = p.entry_id AND entry.project_id = ?1
              WHERE p.scene_id = ?2
              ORDER BY p.created_at, p.entry_id
              LIMIT 1",
            params![project_id, query_scene_id, limit],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    Ok(match row {
        None => Nir1GraphSeedRead::NoPin,
        Some((_, None)) => Nir1GraphSeedRead::TooLarge,
        Some((_, Some(entry_id))) if entry_id.is_empty() => Nir1GraphSeedRead::NoPin,
        Some((_, Some(entry_id))) => Nir1GraphSeedRead::Pinned(entry_id),
    })
}

/// The short read that precedes D-final's Graph request: the same rule as
/// [`read_nir1_graph_seed_in_tx`] in its own bounded participant read. The
/// database mutex is returned when it finishes, so the request and the wait
/// that follow hold no database lock.
pub fn read_nir1_graph_seed(
    workspace: &ActiveWorkspaceSnapshot,
    project_id: &str,
    query_scene_id: &str,
    sql_budget: ParticipantSqlOperationBudget,
) -> Result<Nir1GraphSeedRead> {
    let checkpoint_budget = sql_budget.clone();
    workspace.db().with_participant_read_transaction_bounded(
        workspace.participant(),
        sql_budget,
        |conn| {
            checkpoint_budget.check(workspace.participant())?;
            let seed = read_nir1_graph_seed_in_tx(conn, project_id, query_scene_id)?;
            checkpoint_budget.check(workspace.participant())?;
            Ok(seed)
        },
    )
}

/// Why the whole Graph contributed nothing to this request. The set is closed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1GraphDropReason {
    /// The request is not the Native selection (a caller-supplied Revision
    /// list never carries a Graph).
    NotNativeSelection,
    /// The candidate was made for another project or another query Scene.
    ProjectOrSceneMismatch,
    /// The seed rule, read again in this snapshot, names another Entity (or
    /// none) than the one the request was made for.
    SeedChanged,
    /// B has no current seal in this snapshot (dirty, stale or not built).
    SealUnavailable,
    /// B is sealed at another generation than the one the worker answered
    /// under.
    SealMismatch,
    /// With the Graph groups, the budget would have selected no accepted IR
    /// item, which D-final requires. The accepted IR groups stay.
    WouldRemoveRequiredAcceptedIr,
}

impl Nir1GraphDropReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotNativeSelection => "not-native-selection",
            Self::ProjectOrSceneMismatch => "project-or-scene-mismatch",
            Self::SeedChanged => "seed-changed",
            Self::SealUnavailable => "seal-unavailable",
            Self::SealMismatch => "seal-mismatch",
            Self::WouldRemoveRequiredAcceptedIr => "would-remove-required-accepted-ir",
        }
    }
}

/// Why one candidate Revision contributed no Graph group. The set is closed;
/// the request continues with the other Revisions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1GraphExclusionReason {
    /// A2 or A3 reported the Revision unavailable in this snapshot.
    RevisionUnavailable(NativeNir1RevisionExclusionReason),
    /// The Native selection did not list the Revision (another project, not
    /// current, not approved, not a typed Revision, or unknown).
    RevisionNotSelected,
    /// At least one of the nine tokens (or the scope revision) differs from
    /// the value this snapshot derives.
    BindingMismatch,
    /// The Revision this snapshot read has no relation with that edge ID.
    EdgeUnknown,
}

impl Nir1GraphExclusionReason {
    pub fn code(self) -> String {
        match self {
            Self::RevisionUnavailable(reason) => {
                format!("revision-unavailable:{}", reason.code())
            }
            Self::RevisionNotSelected => "revision-not-selected".into(),
            Self::BindingMismatch => "binding-mismatch".into(),
            Self::EdgeUnknown => "edge-unknown".into(),
        }
    }
}

/// One Revision left out of the Graph, with the closed reason.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1GraphExclusion {
    revision_id: String,
    reason: Nir1GraphExclusionReason,
}

impl NativeNir1GraphExclusion {
    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn reason(&self) -> Nir1GraphExclusionReason {
        self.reason
    }
}

/// One relation whose Graph group is in the candidate set.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1GraphGroup {
    revision_id: String,
    edge_id: String,
    group_id: String,
}

impl NativeNir1GraphGroup {
    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn edge_id(&self) -> &str {
        &self.edge_id
    }

    pub fn group_id(&self) -> &str {
        &self.group_id
    }
}

/// What the Graph candidates did in the snapshot. It holds identifiers and
/// closed reasons only.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1GraphOutcome {
    dropped: Option<Nir1GraphDropReason>,
    seal: Option<Nir1GraphSealRead>,
    groups: Vec<NativeNir1GraphGroup>,
    excluded: Vec<NativeNir1GraphExclusion>,
    limited: usize,
}

impl NativeNir1GraphOutcome {
    fn dropped(reason: Nir1GraphDropReason) -> Self {
        Self {
            dropped: Some(reason),
            seal: None,
            groups: Vec::new(),
            excluded: Vec::new(),
            limited: 0,
        }
    }

    /// Set when no Graph group was made at all.
    pub fn dropped_reason(&self) -> Option<Nir1GraphDropReason> {
        self.dropped
    }

    /// B's seal as this snapshot read it (None when it was not read, or B has
    /// none).
    pub fn seal(&self) -> Option<&Nir1GraphSealRead> {
        self.seal.as_ref()
    }

    /// The relations whose Graph group is in the candidate set, in pool order
    /// (hop, then traversal).
    pub fn groups(&self) -> &[NativeNir1GraphGroup] {
        &self.groups
    }

    /// The Revisions left out, in the order the Graph first named them.
    pub fn excluded(&self) -> &[NativeNir1GraphExclusion] {
        &self.excluded
    }

    /// The qualified relations that were not added because the shared input
    /// envelope was full. Their accepted IR groups stay.
    pub fn limited_count(&self) -> usize {
        self.limited
    }
}

/// The form of a Graph-derived input's Index reference (DI-1a, DR-DI1A-3). It
/// is versioned so that the history confirmation that lifts the Pending of a
/// Graph-derived input may adopt this form or replace it with a later one.
/// The history reader does not read it yet.
pub const GRAPH_INDEX_REF_FORM: &str = "nir1-graph-index-ref@1";

/// The form of a Graph-derived input's `evidence_ref`.
pub const GRAPH_EVIDENCE_REF_FORM: &str = "nir1-graph-evidence-ref@1";

/// The stable reference of one Graph group: a digest over the Revision and the
/// edge IDs as separate JSON fields, so no delimiter in an ID can make two
/// groups share a reference.
pub fn graph_evidence_ref(revision_id: &str, edge_id: &str) -> Result<String> {
    Ok(grimodex_core::canonical_json_digest(&serde_json::json!({
        "form": GRAPH_EVIDENCE_REF_FORM,
        "revisionId": revision_id,
        "edgeId": edge_id,
    }))?)
}

/// The Index reference of one Graph group: `(identity, version)`.
///
/// The identity names B's sealed Graph Index (project, index key and
/// generation). The version binds the whole seal (source digest, dependency
/// set digest, semantic epoch) and the edge's binding: the Revision, the edge
/// and the nine tokens this snapshot derived for the Revision. Both are
/// domain-separated canonical JSON digests. Nothing here comes from the
/// worker: D-final derives it from the seal it read and the binding it
/// requalified, and a return-time and dispatch-time check derive it again.
pub fn graph_index_reference(
    project_id: &str,
    seal: &Nir1GraphSealRead,
    binding: &NativeNir1AuthorityBinding,
    edge_id: &str,
) -> Result<(String, String)> {
    let scope = binding.scope();
    let identity = grimodex_core::canonical_json_digest(&serde_json::json!({
        "form": GRAPH_INDEX_REF_FORM,
        "part": "identity",
        "projectId": project_id,
        "indexKey": seal.index_key,
        "generation": seal.generation,
    }))?;
    let version = grimodex_core::canonical_json_digest(&serde_json::json!({
        "form": GRAPH_INDEX_REF_FORM,
        "part": "version",
        "projectId": project_id,
        "seal": {
            "indexKey": seal.index_key,
            "generation": seal.generation,
            "sourceDigest": seal.source_digest,
            "dependencySetDigest": seal.dependency_set_digest,
            "semanticEpochId": seal.semantic_epoch_id,
        },
        "edge": {
            "revisionId": binding.revision_id(),
            "edgeId": edge_id,
        },
        "tokens": {
            "decisionId": binding.decision().id(),
            "decisionToken": binding.decision_token(),
            "freshnessToken": binding.freshness_token(),
            "scopeAuthorityRevision": scope.scope_authority_revision(),
            "querySceneSourceToken": scope.query_scene_source_token(),
            "querySceneScopeToken": scope.query_scene_scope_token(),
            "querySceneIncarnationId": scope.query_scene_incarnation_id(),
            "revealStateToken": scope.reveal_state_token(),
        },
    }))?;
    Ok((identity, version))
}

/// One adopted Graph-derived input of a prepared request: the group, its
/// ordinal among the attempt's inputs and the Index reference recorded for it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1GraphInput {
    pub(super) input_ordinal: usize,
    pub(super) revision_id: String,
    pub(super) edge_id: String,
    pub(super) group_id: String,
    pub(super) index_identity: String,
    pub(super) index_version: String,
}

impl NativeNir1GraphInput {
    pub fn input_ordinal(&self) -> usize {
        self.input_ordinal
    }

    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn edge_id(&self) -> &str {
        &self.edge_id
    }

    pub fn group_id(&self) -> &str {
        &self.group_id
    }

    pub fn index_identity(&self) -> &str {
        &self.index_identity
    }

    pub fn index_version(&self) -> &str {
        &self.index_version
    }
}

/// B's seal and the Graph-derived inputs a request adopted (none is held when
/// the request adopted no Graph group). Identifiers, tokens and digests only.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNir1GraphBinding {
    pub(super) seal: Nir1GraphSealRead,
    pub(super) inputs: Vec<NativeNir1GraphInput>,
}

impl NativeNir1GraphBinding {
    pub fn seal(&self) -> &Nir1GraphSealRead {
        &self.seal
    }

    pub fn inputs(&self) -> &[NativeNir1GraphInput] {
        &self.inputs
    }
}

pub(super) struct GraphPoolContext<'a> {
    pub candidates: &'a Nir1GraphCandidates,
    pub project_id: &'a str,
    pub query_scene_id: &'a str,
    pub native_selection: bool,
    /// Number of Raw items at the head of the candidate list.
    pub raw_item_count: usize,
    pub budget_tokens: usize,
    pub purpose: PackingPurpose,
    /// The Revisions A2 or A3 left out of the pooled read, with their reason.
    pub excluded: &'a [NativeNir1ExcludedRevision],
    /// The A2/A3 results of this snapshot (eligible Revisions only).
    pub bindings: &'a [NativeNir1AuthorityBinding],
    pub authority_digests: &'a HashMap<String, [u8; 32]>,
}

/// The nine tokens a snapshot derived itself for one Revision, borrowed from
/// wherever that snapshot keeps them: D-final's authority binding
/// ([`NativeNir1AuthorityBinding`]) or the A3 result of the Related Scenes
/// requalification. The comparison with a worker's frame is one function so
/// the two callers cannot drift apart (CP-3a S1).
pub(crate) struct CurrentGraphTokens<'a> {
    pub(crate) revision_id: &'a str,
    pub(crate) decision_id: &'a str,
    pub(crate) decision_token: &'a str,
    pub(crate) freshness_token: &'a str,
    pub(crate) scope_authority_revision: &'a str,
    pub(crate) query_scene_id: &'a str,
    pub(crate) query_scene_source_token: &'a str,
    pub(crate) query_scene_scope_token: &'a str,
    pub(crate) query_scene_incarnation_id: &'a str,
    pub(crate) reveal_state_token: &'a str,
}

impl<'a> CurrentGraphTokens<'a> {
    fn of_binding(binding: &'a NativeNir1AuthorityBinding) -> Self {
        let scope = binding.scope();
        Self {
            revision_id: binding.revision_id(),
            decision_id: binding.decision().id(),
            decision_token: binding.decision_token(),
            freshness_token: binding.freshness_token(),
            scope_authority_revision: scope.scope_authority_revision(),
            query_scene_id: scope.query_scene_id(),
            query_scene_source_token: scope.query_scene_source_token(),
            query_scene_scope_token: scope.query_scene_scope_token(),
            query_scene_incarnation_id: scope.query_scene_incarnation_id(),
            reveal_state_token: scope.reveal_state_token(),
        }
    }
}

/// The nine tokens plus the scope revision of the worker's frame, against the
/// ones a snapshot derived for the Revision.
pub(crate) fn tokens_match_current(
    candidate: &Nir1GraphCandidateBinding,
    current: &CurrentGraphTokens<'_>,
    scope_revision: Option<&str>,
    query_scene_id: &str,
) -> bool {
    candidate.revision_id == current.revision_id
        && candidate.decision_id == current.decision_id
        && candidate.decision_token == current.decision_token
        && candidate.freshness_token == current.freshness_token
        && candidate.scope_authority_revision == current.scope_authority_revision
        && candidate.query_scene_source_token == current.query_scene_source_token
        && candidate.query_scene_scope_token == current.query_scene_scope_token
        && candidate.query_scene_incarnation_id == current.query_scene_incarnation_id
        && candidate.reveal_state_token == current.reveal_state_token
        && current.query_scene_id == query_scene_id
        && scope_revision == Some(current.scope_authority_revision)
}

/// D-final's comparison: the worker's edge against the authority binding the
/// pooled read derived.
fn tokens_match(
    edge: &Nir1GraphCandidateEdge,
    binding: &NativeNir1AuthorityBinding,
    scope_revision: Option<&str>,
    query_scene_id: &str,
) -> bool {
    tokens_match_current(
        &edge.binding,
        &CurrentGraphTokens::of_binding(binding),
        scope_revision,
        query_scene_id,
    )
}

/// What `reserve_group` charges for a group, without charging it.
fn group_input_bytes(
    group_id: &str,
    parts: &[(grimodex_core::narrative_nir1::AtomicPart, String)],
) -> Result<usize> {
    let mut total = 0usize;
    for (part, text) in parts {
        let id_len = group_id
            .len()
            .checked_add(1)
            .and_then(|length| length.checked_add(reader_part_name(*part).len()))
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native packing input byte count overflow"))?;
        total = total
            .checked_add(id_len)
            .and_then(|bytes| bytes.checked_add(text.len()))
            .and_then(|bytes| bytes.checked_add(group_id.len()))
            .ok_or_else(|| anyhow::anyhow!("NIR-1 Native packing input byte count overflow"))?;
    }
    Ok(total)
}

struct RevisionLookup<'a> {
    evidence_by_id:
        HashMap<String, crate::narrative_extraction::human_material_basis::MaterialEvidenceEntry>,
    entities_by_id: HashMap<&'a str, &'a EntityInput>,
}

/// Requalify the Graph candidates in this snapshot and, for each relation that
/// passes, replace the relation's accepted IR group with its Graph group.
///
/// Nothing here fails the request for a Graph reason: a seal mismatch, a token
/// mismatch, an unavailable Revision and a full envelope all leave the IR
/// groups as they were and are reported in the outcome. Only a SQL error, a
/// cancel and a defect (a Revision this snapshot cannot project) return `Err`.
pub(super) fn pool_graph_candidates(
    conn: &Connection,
    ctx: GraphPoolContext<'_>,
    input_budget: &mut NativePackingInputBudget,
    items: &mut Vec<CandidateContextItem>,
    candidate_owners: &mut HashMap<String, String>,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<NativeNir1GraphOutcome> {
    let candidates = ctx.candidates;
    if !ctx.native_selection {
        return Ok(NativeNir1GraphOutcome::dropped(
            Nir1GraphDropReason::NotNativeSelection,
        ));
    }
    if candidates.project_id != ctx.project_id || candidates.query_scene_id != ctx.query_scene_id {
        return Ok(NativeNir1GraphOutcome::dropped(
            Nir1GraphDropReason::ProjectOrSceneMismatch,
        ));
    }
    // The seed is read again in this snapshot with the rule that chose it.
    checkpoint()?;
    let seed_now = read_nir1_graph_seed_in_tx(conn, ctx.project_id, ctx.query_scene_id)?;
    checkpoint()?;
    if seed_now != Nir1GraphSeedRead::Pinned(candidates.seed_entity_id.clone()) {
        return Ok(NativeNir1GraphOutcome::dropped(
            Nir1GraphDropReason::SeedChanged,
        ));
    }
    let seal = read_nir1_graph_seal(conn, ctx.project_id)?;
    checkpoint()?;
    let Some(seal) = seal else {
        return Ok(NativeNir1GraphOutcome::dropped(
            Nir1GraphDropReason::SealUnavailable,
        ));
    };
    if seal.generation != candidates.generation {
        let mut outcome = NativeNir1GraphOutcome::dropped(Nir1GraphDropReason::SealMismatch);
        outcome.seal = Some(seal);
        return Ok(outcome);
    }
    let mut outcome = NativeNir1GraphOutcome {
        dropped: None,
        seal: Some(seal),
        groups: Vec::new(),
        excluded: Vec::new(),
        limited: 0,
    };

    // Each (Revision, edge) once, grouped by Revision in first-named order.
    let mut revision_order = Vec::<&str>::new();
    let mut edges_by_revision = HashMap::<&str, Vec<(usize, &Nir1GraphCandidateEdge)>>::new();
    let mut seen_edges = HashMap::<(&str, &str), &Nir1GraphCandidateEdge>::new();
    // A Revision whose edge is named twice with different hop or tokens is a
    // malformed answer: it is left out as a binding mismatch, never resolved
    // by keeping the first occurrence.
    let mut conflicting_revisions = HashSet::<&str>::new();
    for (position, edge) in candidates.edges.iter().enumerate() {
        match seen_edges.entry((edge.revision_id(), edge.edge_id.as_str())) {
            std::collections::hash_map::Entry::Occupied(first) => {
                if *first.get() != edge {
                    conflicting_revisions.insert(edge.revision_id());
                }
                continue;
            }
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(edge);
            }
        }
        let entry = edges_by_revision.entry(edge.revision_id()).or_default();
        if entry.is_empty() {
            revision_order.push(edge.revision_id());
        }
        entry.push((position, edge));
    }
    let bindings_by_revision = ctx
        .bindings
        .iter()
        .map(|binding| (binding.revision_id(), binding))
        .collect::<HashMap<_, _>>();
    let unavailable_by_revision = ctx
        .excluded
        .iter()
        .map(|excluded| (excluded.revision_id(), excluded.reason()))
        .collect::<HashMap<_, _>>();

    // A2/A3 and the binding tokens decide per Revision.
    let mut admitted = Vec::<(u8, usize, &Nir1GraphCandidateEdge)>::new();
    for revision_id in revision_order {
        checkpoint()?;
        let exclude = |outcome: &mut NativeNir1GraphOutcome, reason| {
            outcome.excluded.push(NativeNir1GraphExclusion {
                revision_id: revision_id.to_owned(),
                reason,
            });
        };
        let Some(binding) = bindings_by_revision.get(revision_id) else {
            let reason = match unavailable_by_revision.get(revision_id) {
                Some(reason) => Nir1GraphExclusionReason::RevisionUnavailable(*reason),
                None => Nir1GraphExclusionReason::RevisionNotSelected,
            };
            exclude(&mut outcome, reason);
            continue;
        };
        let edges = &edges_by_revision[revision_id];
        if conflicting_revisions.contains(revision_id)
            || !edges.iter().all(|(_, edge)| {
                tokens_match(
                    edge,
                    binding,
                    candidates.scope_revision.as_deref(),
                    ctx.query_scene_id,
                )
            })
        {
            exclude(&mut outcome, Nir1GraphExclusionReason::BindingMismatch);
            continue;
        }
        let relation_ids = binding
            .revision()
            .bundle
            .relations
            .iter()
            .map(|relation| relation.edge_id.as_str())
            .collect::<HashSet<_>>();
        if !edges
            .iter()
            .all(|(_, edge)| relation_ids.contains(edge.edge_id.as_str()))
        {
            exclude(&mut outcome, Nir1GraphExclusionReason::EdgeUnknown);
            continue;
        }
        admitted.extend(
            edges
                .iter()
                .map(|(position, edge)| (edge.hop, *position, *edge)),
        );
    }
    // Hop first, then the Graph's own traversal order.
    admitted.sort_by_key(|(hop, position, _)| (*hop, *position));

    struct Replacement {
        accepted_ir_group_id: String,
        items: Vec<CandidateContextItem>,
        group: NativeNir1GraphGroup,
        /// The input bytes this group charged beyond its accepted IR group.
        extra: usize,
    }
    let mut lookups = HashMap::<&str, RevisionLookup<'_>>::new();
    let mut replacements = Vec::<Replacement>::new();
    let mut reserved_extra = 0usize;
    let admitted_count = admitted.len();
    for (index, (_, _, edge)) in admitted.iter().enumerate() {
        checkpoint()?;
        let revision_id = edge.revision_id();
        let binding = bindings_by_revision[revision_id];
        let revision = binding.revision();
        if !lookups.contains_key(revision_id) {
            let entities_by_id = revision
                .bundle
                .entities
                .iter()
                .map(|entity| (entity.entity_id.as_str(), entity))
                .collect::<HashMap<_, _>>();
            ensure!(
                entities_by_id.len() == revision.bundle.entities.len(),
                "NIR-1 Native typed Entity IDs are not unique"
            );
            lookups.insert(
                revision_id,
                RevisionLookup {
                    evidence_by_id: material_evidence_map(&revision.material_basis.evidence_set)?,
                    entities_by_id,
                },
            );
        }
        let lookup = &lookups[revision_id];
        let relation = revision
            .bundle
            .relations
            .iter()
            .find(|relation| relation.edge_id == edge.edge_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_GRAPH_RELATION_LOST"))?;
        let (projection, evidence) =
            relation_group_material(relation, &lookup.entities_by_id, &lookup.evidence_by_id)?;
        let parts = group_parts(binding, &relation.edge_id, projection, evidence)?;
        let group_id = format!(
            "nir1:graph-evidence:{}:relation:{}",
            revision.revision_id, relation.edge_id
        );
        let accepted_ir_group_id = format!(
            "nir1:accepted-ir:{}:relation:{}",
            revision.revision_id, relation.edge_id
        );
        // The IR group's bytes are already charged. Only the difference is new.
        let extra = group_input_bytes(&group_id, &parts)?
            .saturating_sub(group_input_bytes(&accepted_ir_group_id, &parts)?);
        if !input_budget.try_reserve_additional(extra) {
            // A prefix in Graph order is kept; the rest stay accepted IR.
            outcome.limited = admitted_count - index;
            break;
        }
        reserved_extra += extra;
        let authority_digest = *ctx
            .authority_digests
            .get(revision_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_GRAPH_AUTHORITY_DIGEST_LOST"))?;
        let candidate_binding = candidate_binding_digest(
            GRAPH_CANDIDATE_BINDING_KIND,
            authority_digest,
            &group_id,
            &parts,
        )?;
        let group_items = parts
            .into_iter()
            .map(|(part, text)| {
                adapt_candidate_context_item(
                    ContextItemKind::GraphEvidence {
                        id: format!("{group_id}:{}", reader_part_name(part)),
                        tokens: estimate_nir1_context_tokens(&text),
                        text,
                        atomic_group: group_id.clone(),
                    },
                    part,
                    candidate_binding,
                )
                .map_err(anyhow::Error::from)
            })
            .collect::<Result<Vec<_>>>()?;
        replacements.push(Replacement {
            accepted_ir_group_id,
            extra,
            items: group_items,
            group: NativeNir1GraphGroup {
                revision_id: revision.revision_id.clone(),
                edge_id: relation.edge_id.clone(),
                group_id,
            },
        });
    }
    if replacements.is_empty() {
        return Ok(outcome);
    }

    // D-final needs at least one accepted IR item in the request. A Graph
    // group outranks the IR groups, so on a very small budget it could take
    // the room the only selected IR group had. The Graph never turns a request
    // that was acceptable into a rejected one: then the IR groups stay.
    let pack = |list: &[CandidateContextItem]| {
        pack_candidate_context(CandidatePackingRequest {
            budget_tokens: ctx.budget_tokens,
            purpose: ctx.purpose,
            items: list.to_vec(),
        })
        .map_err(anyhow::Error::from)
    };
    let has_accepted_ir = |list: &[CandidateContextItem], packed: &PackedContext| {
        let selected = packed
            .selected_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        list.iter().any(|candidate| {
            matches!(candidate.item(), ContextItemKind::AcceptedIr { .. })
                && selected.contains(super::item_id(candidate.item()))
        })
    };
    // The swap in a trial list: the first `count` replaced accepted IR groups
    // leave, and their Graph groups follow the Raw items, ahead of the IR
    // groups.
    let build_trial =
        |count: usize, replacements: &[Replacement]| -> (Vec<CandidateContextItem>, Vec<String>) {
            let replaced = replacements[..count]
                .iter()
                .map(|replacement| replacement.accepted_ir_group_id.as_str())
                .collect::<HashSet<_>>();
            let mut removed_ids = Vec::new();
            let mut trial = Vec::with_capacity(items.len());
            trial.extend(items.iter().take(ctx.raw_item_count).cloned());
            for replacement in &replacements[..count] {
                trial.extend(replacement.items.iter().cloned());
            }
            for candidate in items.iter().skip(ctx.raw_item_count) {
                match candidate.item() {
                    ContextItemKind::AcceptedIr {
                        id, atomic_group, ..
                    } if replaced.contains(atomic_group.as_str()) => removed_ids.push(id.clone()),
                    _ => trial.push(candidate.clone()),
                }
            }
            (trial, removed_ids)
        };

    // The attempt records one input per Graph group, each with the whole
    // qualification set of its Revision. The Graph is optional material, so it
    // may not turn a request that fits the attempt's reference caps into one
    // the create refuses: the references the selection would record are
    // counted against the caps, and the Graph groups that do not fit (and the
    // ones after them) are not added (DR-DI1A-23).
    let index_seal = outcome
        .seal
        .clone()
        .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_GRAPH_SEAL_MISSING"))?;
    let mut meter = ReferenceMeter {
        project_id: ctx.project_id,
        seal: &index_seal,
        bindings: &bindings_by_revision,
        cache: HashMap::new(),
    };
    let group_index = replacements
        .iter()
        .enumerate()
        .map(|(position, replacement)| (replacement.group.group_id.as_str(), position))
        .collect::<HashMap<_, _>>();
    let mut fits = |count: usize| -> Result<bool> {
        let (trial, _) = build_trial(count, &replacements);
        let packed = pack(&trial)?;
        let selected = packed
            .selected_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut ir_revisions = std::collections::BTreeSet::<&str>::new();
        let mut graph_groups = std::collections::BTreeSet::<&str>::new();
        for candidate in &trial {
            let id = super::item_id(candidate.item());
            if !selected.contains(id) {
                continue;
            }
            match candidate.item() {
                ContextItemKind::AcceptedIr { .. } => {
                    if let Some(owner) = candidate_owners.get(id) {
                        ir_revisions.insert(owner.as_str());
                    }
                }
                ContextItemKind::GraphEvidence { atomic_group, .. } => {
                    graph_groups.insert(atomic_group.as_str());
                }
                _ => {}
            }
        }
        let mut references = REFERENCE_SLACK_COUNT;
        let mut bytes = REFERENCE_SLACK_BYTES;
        for revision_id in ir_revisions {
            let (count, size) = meter.accepted_revision(revision_id)?;
            references = references.saturating_add(count);
            bytes = bytes.saturating_add(size);
        }
        for group_id in graph_groups {
            let position = *group_index
                .get(group_id)
                .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_GRAPH_REPLACEMENT_LOST_GROUP"))?;
            let (count, size) = meter.graph_group(&replacements[position].group)?;
            references = references.saturating_add(count);
            bytes = bytes.saturating_add(size);
        }
        let (max_references, max_reference_bytes) = reference_caps();
        Ok(references <= max_references && bytes <= max_reference_bytes)
    };
    checkpoint()?;
    let total = replacements.len();
    let mut keep = total;
    if !fits(total)? {
        // The request without any Graph group is the one the cap already
        // accepted (the baseline); search the largest prefix that fits.
        let (mut low, mut high) = (0usize, total - 1);
        while low < high {
            checkpoint()?;
            let mid = (low + high).div_ceil(2);
            if fits(mid)? {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        keep = low;
    }
    for dropped in replacements.split_off(keep) {
        input_budget.release_additional(dropped.extra);
        reserved_extra -= dropped.extra;
        outcome.limited += 1;
    }
    if replacements.is_empty() {
        return Ok(outcome);
    }

    let (trial, removed_ids) = build_trial(replacements.len(), &replacements);
    ensure!(
        removed_ids.len() == replacements.len() * super::NATIVE_ATOMIC_PART_COUNT
            && trial.len() == items.len(),
        "NIR1_NATIVE_GRAPH_REPLACEMENT_LOST_GROUP"
    );
    ensure!(
        trial.len() <= MAX_PACKING_ITEMS,
        "NIR-1 Native projected item count {} exceeds MAX_PACKING_ITEMS {MAX_PACKING_ITEMS}",
        trial.len()
    );
    checkpoint()?;
    if !has_accepted_ir(&trial, &pack(&trial)?) && has_accepted_ir(items, &pack(items)?) {
        input_budget.release_additional(reserved_extra);
        outcome.dropped = Some(Nir1GraphDropReason::WouldRemoveRequiredAcceptedIr);
        return Ok(outcome);
    }

    *items = trial;
    for id in removed_ids {
        candidate_owners.remove(&id);
    }
    for replacement in replacements {
        for candidate in &replacement.items {
            candidate_owners.insert(
                super::item_id(candidate.item()).to_owned(),
                replacement.group.revision_id.clone(),
            );
        }
        outcome.groups.push(replacement.group);
    }
    Ok(outcome)
}

/// The references the attempt would record for the Human and the Raw input
/// (one input, eight and seven qualification rows, one D1 row for the Raw),
/// with room for a few more. The selection is counted exactly for the
/// Revisions and the Graph groups; this covers the rest.
const REFERENCE_SLACK_COUNT: usize = 32;
const REFERENCE_SLACK_BYTES: usize = 32 * 1024;

/// The caps of one local attempt's references (input rows plus qualification
/// rows), applied by the store at the create and at the read back. 16
/// references per input slot at 1 KiB each. The Graph admission counts against
/// the same values, so the create never refuses a request only because the
/// optional Graph groups were added.
pub const NATIVE_ATTEMPT_MAX_REFERENCES: usize = MAX_PACKING_ITEMS * 16;
pub const NATIVE_ATTEMPT_MAX_REFERENCE_BYTES: usize = MAX_PACKING_ITEMS * 16 * 1024;

#[cfg(test)]
thread_local! {
    /// A test lowers the caps to reach them with a small fixture.
    pub(super) static REFERENCE_CAPS_FOR_TEST: std::cell::Cell<Option<(usize, usize)>> =
        const { std::cell::Cell::new(None) };
}

fn reference_caps() -> (usize, usize) {
    #[cfg(test)]
    if let Some(caps) = REFERENCE_CAPS_FOR_TEST.with(std::cell::Cell::get) {
        return caps;
    }
    (
        NATIVE_ATTEMPT_MAX_REFERENCES,
        NATIVE_ATTEMPT_MAX_REFERENCE_BYTES,
    )
}

/// What an input of one Revision costs the attempt: the input row, its
/// qualification rows and the D1 row, in count and in serialized bytes. The
/// rows are derived with the product function, so the count is what the
/// create sees. Cached by Revision (and by group).
struct ReferenceMeter<'a> {
    project_id: &'a str,
    seal: &'a Nir1GraphSealRead,
    bindings: &'a HashMap<&'a str, &'a NativeNir1AuthorityBinding>,
    cache: HashMap<String, (usize, usize)>,
}

impl ReferenceMeter<'_> {
    fn accepted_revision(&mut self, revision_id: &str) -> Result<(usize, usize)> {
        let key = format!("ir:{revision_id}");
        if let Some(cost) = self.cache.get(&key) {
            return Ok(*cost);
        }
        let binding = *self
            .bindings
            .get(revision_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING"))?;
        let input = InputReference {
            role: InputRole::Context,
            target: InputTarget::AcceptedRevision {
                revision_id: revision_id.to_owned(),
                bundle_digest: binding.bundle_digest().to_owned(),
            },
            input_use: InputUse::SelectedMaterial,
        };
        let cost = self.cost(binding, RevisionIndexQualification::NotIndexDerived, &input)?;
        self.cache.insert(key, cost);
        Ok(cost)
    }

    fn graph_group(&mut self, group: &NativeNir1GraphGroup) -> Result<(usize, usize)> {
        let key = format!("graph:{}", group.group_id);
        if let Some(cost) = self.cache.get(&key) {
            return Ok(*cost);
        }
        let binding = *self
            .bindings
            .get(group.revision_id.as_str())
            .ok_or_else(|| anyhow::anyhow!("NIR1_NATIVE_PREPARED_REVISION_BINDING_MISSING"))?;
        let (source_key, revision_token) = super::graph_input_source(binding, &group.edge_id)?;
        let (identity, version) =
            graph_index_reference(self.project_id, self.seal, binding, &group.edge_id)?;
        let input = InputReference {
            role: InputRole::Context,
            target: InputTarget::GraphEvidence {
                evidence_ref: graph_evidence_ref(&group.revision_id, &group.edge_id)?,
                source_key,
                revision_token,
            },
            input_use: InputUse::SelectedMaterial,
        };
        let cost = self.cost(
            binding,
            RevisionIndexQualification::Present { identity, version },
            &input,
        )?;
        self.cache.insert(key, cost);
        Ok(cost)
    }

    fn cost(
        &self,
        binding: &NativeNir1AuthorityBinding,
        index: RevisionIndexQualification,
        input: &InputReference,
    ) -> Result<(usize, usize)> {
        let mut rows = Vec::new();
        super::add_revision_qualifications(
            &mut rows,
            0,
            self.project_id,
            binding.revision_id(),
            binding,
            index,
            &mut || Ok(()),
        )?;
        let d1 = d1_selection_reference(0, &"0".repeat(64));
        let mut bytes = serde_json::to_vec(input)?.len() + serde_json::to_vec(&d1)?.len();
        for row in &rows {
            bytes += serde_json::to_vec(row)?.len();
        }
        // The input row, the qualification rows and the D1 row.
        Ok((rows.len() + 2, bytes))
    }
}
