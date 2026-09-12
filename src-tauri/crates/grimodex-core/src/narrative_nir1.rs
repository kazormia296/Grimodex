//! Typed, request-local NIR-1 L6--L8 primitives.
//!
//! This module deliberately contains no database or renderer policy.  Native
//! callers use it after they have read the authoritative Scope/Revision
//! snapshot; the types make it impossible for a Graph or Packing result to
//! silently manufacture an identity, discard its Evidence, or exceed the
//! semantic limits fixed by the execution plan.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const ENTITY_RELATION_PRODUCER: &str = "nir1-reviewed-entity-relation-v1";
pub const ENTITY_RELATION_INDEX_KEY: &str = "nir1-reviewed-entity-relation:v1";
pub const ENTITY_RELATION_SOURCE_KIND: &str = "nir1-entity-relation-eligibility-set";

pub const MAX_GRAPH_HOPS: u8 = 2;
pub const MAX_GRAPH_NODES: usize = 12;
pub const MAX_GRAPH_EDGES: usize = 144;
pub const MAX_GRAPH_SCENES: usize = 8;
pub const MAX_GRAPH_RECORDS: usize = 512;
pub const MAX_GRAPH_INPUT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PACKING_ITEMS: usize = 512;
pub const MAX_PACKING_INPUT_BYTES: usize = 2 * 1024 * 1024;

/// One of the three Scope axes that can be used by the initial reader
/// profile.  `Any` remains purpose-bound; it is not a wildcard query identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScopeValue {
    Any { purpose: Option<String> },
    Exact { value: String },
    NotApplicable { reason: String },
    Unavailable { reason: String },
    LegacyAbsent,
    Unresolved,
}

impl ScopeValue {
    fn input_bytes(&self) -> usize {
        match self {
            Self::Any { purpose } => purpose.as_deref().map_or(0, str::len),
            Self::Exact { value } => value.len(),
            Self::NotApplicable { reason } | Self::Unavailable { reason } => reason.len(),
            Self::LegacyAbsent | Self::Unresolved => 0,
        }
    }

    fn validate(&self, field: &str) -> Result<(), Nir1ContractError> {
        match self {
            Self::Any { purpose } => {
                let Some(purpose) = purpose.as_deref().filter(|value| !value.trim().is_empty())
                else {
                    return Err(Nir1ContractError::InvalidScope {
                        field: field.into(),
                        reason: "Any requires a non-empty purpose".into(),
                    });
                };
                if purpose.len() > 128 {
                    return Err(Nir1ContractError::InvalidScope {
                        field: field.into(),
                        reason: "purpose is too long".into(),
                    });
                }
            }
            Self::Exact { value } if value.trim().is_empty() => {
                return Err(Nir1ContractError::InvalidScope {
                    field: field.into(),
                    reason: "Exact requires a non-empty value".into(),
                })
            }
            Self::NotApplicable { reason } if reason.trim().is_empty() => {
                return Err(Nir1ContractError::InvalidScope {
                    field: field.into(),
                    reason: "NotApplicable requires a reason".into(),
                })
            }
            Self::Unavailable { reason } if reason.trim().is_empty() => {
                return Err(Nir1ContractError::InvalidScope {
                    field: field.into(),
                    reason: "Unavailable requires a reason".into(),
                })
            }
            Self::LegacyAbsent | Self::Unresolved => {
                return Err(Nir1ContractError::InvalidScope {
                    field: field.into(),
                    reason: "unresolved Scope cannot authorize NIR-1 material".into(),
                })
            }
            Self::Exact { .. } | Self::NotApplicable { .. } | Self::Unavailable { .. } => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeBinding {
    pub reading: ScopeValue,
    pub story: ScopeValue,
    pub auto: ScopeValue,
    pub phase: String,
    pub reveal: String,
    pub pov: Option<String>,
    pub authority_revision: String,
}

impl ScopeBinding {
    fn input_bytes(&self) -> usize {
        self.reading
            .input_bytes()
            .saturating_add(self.story.input_bytes())
            .saturating_add(self.auto.input_bytes())
            .saturating_add(self.phase.len())
            .saturating_add(self.reveal.len())
            .saturating_add(self.pov.as_deref().map_or(0, str::len))
            .saturating_add(self.authority_revision.len())
    }

    pub fn validate(&self) -> Result<(), Nir1ContractError> {
        self.reading.validate("reading")?;
        self.story.validate("story")?;
        self.auto.validate("auto")?;
        for (field, value) in [("phase", &self.phase), ("reveal", &self.reveal)] {
            if value.trim().is_empty() {
                return Err(Nir1ContractError::InvalidScope {
                    field: field.into(),
                    reason: "value must be non-empty".into(),
                });
            }
        }
        if self
            .pov
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(Nir1ContractError::InvalidScope {
                field: "pov".into(),
                reason: "value must be non-empty when present".into(),
            });
        }
        if !is_sha256_digest(&self.authority_revision) {
            return Err(Nir1ContractError::InvalidScope {
                field: "authorityRevision".into(),
                reason: "must be a canonical sha256 digest".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceInput {
    pub evidence_id: String,
    pub source_ref: String,
    pub quote: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityInput {
    pub entity_id: String,
    pub entity_type: String,
    pub label: String,
    pub source_token: String,
    pub scope: ScopeBinding,
    pub evidence: Vec<EvidenceInput>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphEdgeInput {
    pub edge_id: String,
    pub from_entity_id: String,
    pub to_entity_id: String,
    pub relation_type: String,
    #[serde(deserialize_with = "deserialize_directionality")]
    pub directionality: String,
    pub source_token: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityRelationBundle {
    pub project_id: String,
    pub revision_id: String,
    pub producer: String,
    pub entities: Vec<EntityInput>,
    pub relations: Vec<GraphEdgeInput>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GraphLimits {
    pub max_hops: u8,
    pub max_nodes: usize,
    pub max_edges: usize,
}

impl Default for GraphLimits {
    fn default() -> Self {
        Self {
            max_hops: MAX_GRAPH_HOPS,
            max_nodes: MAX_GRAPH_NODES,
            max_edges: MAX_GRAPH_EDGES,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub entity_id: String,
    pub entity_type: String,
    pub label: String,
    pub hop: u8,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub edge_id: String,
    pub from_entity_id: String,
    pub to_entity_id: String,
    pub relation_type: String,
    pub directionality: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedGraph {
    pub seed_entity_id: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum Nir1ContractError {
    #[error("NIR1_INVALID_SCOPE:{field}:{reason}")]
    InvalidScope { field: String, reason: String },
    #[error("NIR1_INVALID_BUNDLE:{0}")]
    InvalidBundle(String),
    #[error("NIR1_UNKNOWN_ENTITY:{0}")]
    UnknownEntity(String),
    #[error("NIR1_GRAPH_LIMIT:{0}")]
    GraphLimit(String),
    #[error("NIR1_PACKING:{0}")]
    Packing(String),
}

pub fn validate_entity_relation_bundle(
    bundle: &EntityRelationBundle,
) -> Result<(), Nir1ContractError> {
    if bundle.project_id.trim().is_empty() || bundle.revision_id.trim().is_empty() {
        return Err(Nir1ContractError::InvalidBundle(
            "project and revision identities are required".into(),
        ));
    }
    if bundle.producer != ENTITY_RELATION_PRODUCER {
        return Err(Nir1ContractError::InvalidBundle(format!(
            "unsupported producer '{}', expected '{ENTITY_RELATION_PRODUCER}'",
            bundle.producer
        )));
    }
    if bundle.entities.is_empty() || bundle.entities.len() > MAX_GRAPH_RECORDS {
        return Err(Nir1ContractError::InvalidBundle(
            "entity count is outside the bounded request envelope".into(),
        ));
    }
    let mut entities = HashSet::new();
    let mut evidence = HashSet::new();
    let mut input_bytes = bundle
        .project_id
        .len()
        .saturating_add(bundle.revision_id.len())
        .saturating_add(bundle.producer.len());
    for entity in &bundle.entities {
        if entity.entity_id.trim().is_empty()
            || entity.entity_type.trim().is_empty()
            || entity.label.trim().is_empty()
            || entity.source_token.trim().is_empty()
        {
            return Err(Nir1ContractError::InvalidBundle(
                "entity identity, type, label, and source token are required".into(),
            ));
        }
        input_bytes = input_bytes
            .saturating_add(entity.entity_id.len())
            .saturating_add(entity.entity_type.len())
            .saturating_add(entity.label.len())
            .saturating_add(entity.source_token.len())
            .saturating_add(entity.scope.input_bytes());
        if !entities.insert(entity.entity_id.clone()) {
            return Err(Nir1ContractError::InvalidBundle(format!(
                "duplicate entity '{}'",
                entity.entity_id
            )));
        }
        entity.scope.validate()?;
        if entity.evidence.is_empty() {
            return Err(Nir1ContractError::InvalidBundle(format!(
                "entity '{}' has no Evidence",
                entity.entity_id
            )));
        }
        for item in &entity.evidence {
            input_bytes = input_bytes
                .saturating_add(item.evidence_id.len())
                .saturating_add(item.source_ref.len())
                .saturating_add(item.quote.len());
            if item.evidence_id.trim().is_empty()
                || item.source_ref.trim().is_empty()
                || item.quote.trim().is_empty()
                || item.end_utf16 < item.start_utf16
                || item.end_utf16 - item.start_utf16 != item.quote.encode_utf16().count()
            {
                return Err(Nir1ContractError::InvalidBundle(format!(
                    "invalid Evidence for entity '{}'",
                    entity.entity_id
                )));
            }
            if !evidence.insert(item.evidence_id.clone()) {
                return Err(Nir1ContractError::InvalidBundle(format!(
                    "duplicate Evidence '{}'",
                    item.evidence_id
                )));
            }
        }
    }
    if bundle.relations.len() > MAX_GRAPH_RECORDS {
        return Err(Nir1ContractError::InvalidBundle(
            "relation count is outside the bounded request envelope".into(),
        ));
    }
    let record_count = 1usize
        .saturating_add(bundle.entities.len())
        .saturating_add(bundle.relations.len())
        .saturating_add(
            bundle
                .entities
                .iter()
                .map(|entity| entity.evidence.len())
                .sum::<usize>(),
        );
    if record_count > MAX_GRAPH_RECORDS {
        return Err(Nir1ContractError::InvalidBundle(
            "object, relation, revision, and Evidence count exceeds the request envelope".into(),
        ));
    }
    let mut edges = HashSet::new();
    for relation in &bundle.relations {
        input_bytes = input_bytes
            .saturating_add(relation.edge_id.len())
            .saturating_add(relation.from_entity_id.len())
            .saturating_add(relation.to_entity_id.len())
            .saturating_add(relation.relation_type.len())
            .saturating_add(relation.directionality.len())
            .saturating_add(relation.source_token.len())
            .saturating_add(relation.evidence_ids.iter().map(String::len).sum::<usize>());
        if relation.edge_id.trim().is_empty()
            || relation.relation_type.trim().is_empty()
            || relation.source_token.trim().is_empty()
        {
            return Err(Nir1ContractError::InvalidBundle(
                "relation identity, type, and source token are required".into(),
            ));
        }
        if relation.directionality != "directed" && relation.directionality != "symmetric" {
            return Err(Nir1ContractError::InvalidBundle(format!(
                "relation '{}' has invalid directionality",
                relation.edge_id
            )));
        }
        if !entities.contains(&relation.from_entity_id)
            || !entities.contains(&relation.to_entity_id)
        {
            return Err(Nir1ContractError::InvalidBundle(format!(
                "relation '{}' endpoint is not present in the same project bundle",
                relation.edge_id
            )));
        }
        if !edges.insert(relation.edge_id.clone()) {
            return Err(Nir1ContractError::InvalidBundle(format!(
                "duplicate relation '{}'",
                relation.edge_id
            )));
        }
        if relation.evidence_ids.is_empty()
            || relation
                .evidence_ids
                .iter()
                .any(|id| !evidence.contains(id))
        {
            return Err(Nir1ContractError::InvalidBundle(format!(
                "relation '{}' references missing Evidence",
                relation.edge_id
            )));
        }
    }
    if input_bytes > MAX_GRAPH_INPUT_BYTES {
        return Err(Nir1ContractError::InvalidBundle(
            "graph input exceeds the request memory envelope".into(),
        ));
    }
    Ok(())
}

pub fn bounded_graph(
    bundle: &EntityRelationBundle,
    seed_entity_id: &str,
    limits: GraphLimits,
) -> Result<BoundedGraph, Nir1ContractError> {
    validate_entity_relation_bundle(bundle)?;
    if limits.max_hops > MAX_GRAPH_HOPS
        || limits.max_nodes == 0
        || limits.max_nodes > MAX_GRAPH_NODES
        || limits.max_edges == 0
        || limits.max_edges > MAX_GRAPH_EDGES
    {
        return Err(Nir1ContractError::GraphLimit(
            "requested limits exceed the NIR-1 semantic envelope".into(),
        ));
    }
    let by_id: HashMap<_, _> = bundle
        .entities
        .iter()
        .map(|entity| (entity.entity_id.as_str(), entity))
        .collect();
    if !by_id.contains_key(seed_entity_id) {
        return Err(Nir1ContractError::UnknownEntity(seed_entity_id.into()));
    }

    let mut adjacency: HashMap<&str, Vec<(&GraphEdgeInput, &str)>> = HashMap::new();
    for edge in &bundle.relations {
        adjacency
            .entry(edge.from_entity_id.as_str())
            .or_default()
            .push((edge, edge.to_entity_id.as_str()));
        if edge.directionality == "symmetric" {
            adjacency
                .entry(edge.to_entity_id.as_str())
                .or_default()
                .push((edge, edge.from_entity_id.as_str()));
        }
    }
    for edges in adjacency.values_mut() {
        edges.sort_by(|(left, left_to), (right, right_to)| {
            left.edge_id
                .cmp(&right.edge_id)
                .then_with(|| left_to.cmp(right_to))
        });
    }

    let mut queue = VecDeque::from([(seed_entity_id, 0u8)]);
    let mut hops = HashMap::from([(seed_entity_id, 0u8)]);
    let mut selected_edge_ids = HashSet::new();
    let mut selected_edges = Vec::new();
    let mut truncated = false;
    while let Some((current, hop)) = queue.pop_front() {
        if hop >= limits.max_hops {
            continue;
        }
        for (edge, target) in adjacency.get(current).into_iter().flatten() {
            // Never publish an edge whose endpoint could not be admitted to
            // the bounded node set.  A partial edge is less useful than a
            // conservative unavailable/truncated graph because it cannot
            // carry valid path Evidence.
            if !hops.contains_key(target) && hops.len() == limits.max_nodes {
                truncated = true;
                continue;
            }
            if !selected_edge_ids.contains(&edge.edge_id) {
                if selected_edges.len() == limits.max_edges {
                    truncated = true;
                    continue;
                }
                selected_edge_ids.insert(edge.edge_id.clone());
                selected_edges.push(*edge);
            }
            if !hops.contains_key(target) {
                hops.insert(*target, hop + 1);
                queue.push_back((*target, hop + 1));
            }
        }
    }

    let mut nodes = hops
        .into_iter()
        .map(|(id, hop)| {
            let entity = by_id[id];
            GraphNode {
                entity_id: id.into(),
                entity_type: entity.entity_type.clone(),
                label: entity.label.clone(),
                hop,
                evidence_ids: entity
                    .evidence
                    .iter()
                    .map(|item| item.evidence_id.clone())
                    .collect(),
            }
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        left.hop
            .cmp(&right.hop)
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });
    selected_edges.sort_by(|left, right| left.edge_id.cmp(&right.edge_id));
    let edges = selected_edges
        .into_iter()
        .map(|edge| GraphEdge {
            edge_id: edge.edge_id.clone(),
            from_entity_id: edge.from_entity_id.clone(),
            to_entity_id: edge.to_entity_id.clone(),
            relation_type: edge.relation_type.clone(),
            directionality: edge.directionality.clone(),
            evidence_ids: edge.evidence_ids.clone(),
        })
        .collect();
    Ok(BoundedGraph {
        seed_entity_id: seed_entity_id.into(),
        nodes,
        edges,
        truncated,
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextItemKind {
    Raw {
        id: String,
        text: String,
        tokens: usize,
    },
    AcceptedIr {
        id: String,
        text: String,
        tokens: usize,
        atomic_group: String,
    },
    GraphEvidence {
        id: String,
        text: String,
        tokens: usize,
        atomic_group: String,
    },
    AuthorDeclared {
        id: String,
        text: String,
        tokens: usize,
        atomic_group: String,
    },
    UnreviewedForReview {
        id: String,
        text: String,
        tokens: usize,
        atomic_group: String,
    },
}

impl ContextItemKind {
    fn fields(&self) -> (&str, &str, usize, Option<&str>) {
        match self {
            Self::Raw { id, text, tokens } => (id, text, *tokens, None),
            Self::AcceptedIr {
                id,
                text,
                tokens,
                atomic_group,
            }
            | Self::GraphEvidence {
                id,
                text,
                tokens,
                atomic_group,
            }
            | Self::AuthorDeclared {
                id,
                text,
                tokens,
                atomic_group,
            }
            | Self::UnreviewedForReview {
                id,
                text,
                tokens,
                atomic_group,
            } => (id, text, *tokens, Some(atomic_group)),
        }
    }

    fn priority(&self) -> u8 {
        match self {
            Self::Raw { .. } => 4,
            Self::AcceptedIr { .. } => 3,
            Self::GraphEvidence { .. } => 3,
            Self::AuthorDeclared { .. } => 2,
            Self::UnreviewedForReview { .. } => 1,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackingRequest {
    pub budget_tokens: usize,
    pub items: Vec<ContextItemKind>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedContext {
    pub selected_ids: Vec<String>,
    pub omitted_ids: Vec<String>,
    pub used_tokens: usize,
    pub remaining_tokens: usize,
}

pub fn pack_context(request: PackingRequest) -> Result<PackedContext, Nir1ContractError> {
    if request.budget_tokens == 0 || request.items.len() > MAX_PACKING_ITEMS {
        return Err(Nir1ContractError::Packing(
            "budget or item count is outside the bounded envelope".into(),
        ));
    }
    let mut ids = HashSet::new();
    let mut groups: HashMap<&str, (usize, usize, u8, Vec<usize>)> = HashMap::new();
    let mut selected = HashSet::new();
    let mut used_tokens = 0usize;
    let mut has_raw = false;
    let mut input_bytes = 0usize;
    for (index, item) in request.items.iter().enumerate() {
        let (id, text, tokens, group) = item.fields();
        input_bytes = input_bytes
            .saturating_add(id.len())
            .saturating_add(text.len())
            .saturating_add(group.map_or(0, str::len));
        if id.trim().is_empty() || text.is_empty() || tokens == 0 || !ids.insert(id) {
            return Err(Nir1ContractError::Packing(
                "each item needs a unique id, text, and positive token count".into(),
            ));
        }
        if let Some(group) = group {
            if group.trim().is_empty() {
                return Err(Nir1ContractError::Packing(
                    "every non-Raw item requires a non-empty atomic group".into(),
                ));
            }
            let entry = groups
                .entry(group)
                .or_insert((0, index, item.priority(), Vec::new()));
            entry.0 = entry.0.saturating_add(tokens);
            entry.1 = entry.1.min(index);
            entry.2 = entry.2.max(item.priority());
            entry.3.push(index);
        } else {
            if used_tokens.saturating_add(tokens) > request.budget_tokens {
                return Err(Nir1ContractError::Packing(
                    "required Raw context does not fit the budget".into(),
                ));
            }
            used_tokens += tokens;
            selected.insert(index);
            has_raw = true;
        }
    }
    if input_bytes > MAX_PACKING_INPUT_BYTES {
        return Err(Nir1ContractError::Packing(
            "packing input exceeds the request memory envelope".into(),
        ));
    }
    if !has_raw {
        return Err(Nir1ContractError::Packing(
            "at least one required Raw context item is needed".into(),
        ));
    }
    let mut candidates = groups.into_iter().collect::<Vec<_>>();
    candidates
        .sort_by(|(_, left), (_, right)| right.2.cmp(&left.2).then_with(|| left.1.cmp(&right.1)));
    for (_, (tokens, _, _, indexes)) in candidates {
        if used_tokens.saturating_add(tokens) <= request.budget_tokens {
            used_tokens += tokens;
            selected.extend(indexes);
        }
    }
    let selected_ids = request
        .items
        .iter()
        .enumerate()
        .filter(|(index, _)| selected.contains(index))
        .map(|(_, item)| item.fields().0.to_string())
        .collect::<Vec<_>>();
    let omitted_ids = request
        .items
        .iter()
        .enumerate()
        .filter(|(index, _)| !selected.contains(index))
        .map(|(_, item)| item.fields().0.to_string())
        .collect::<Vec<_>>();
    Ok(PackedContext {
        selected_ids,
        omitted_ids,
        used_tokens,
        remaining_tokens: request.budget_tokens.saturating_sub(used_tokens),
    })
}

fn deserialize_directionality<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Ok(value)
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == "sha256:".len() + 64
        && value.starts_with("sha256:")
        && value["sha256:".len()..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}
