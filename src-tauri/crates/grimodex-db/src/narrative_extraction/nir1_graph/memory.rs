//! Request-local retained-memory accounting for the native Graph reader.
//!
//! `RetainedLedger` is a monotonic, pre-allocation admission ledger. It never
//! measures the process allocator or SQLite/serde internals, and it only gives
//! a hard result after every live structure is charged by the caller. Keep the
//! C reader on hold while any of those structures remain outside this ledger.

use std::mem::size_of;

use anyhow::{ensure, Result};
use grimodex_core::narrative_nir1::{EntityInput, GraphEdgeInput, ScopeValue};

use super::{
    Nir1GraphMaterialBinding, Nir1GraphNode, Nir1GraphResponse, Nir1QualifiedGraph,
    QualifiedGraphMaterial,
};

pub(super) const RETAINED_LIMIT_ERROR: &str = "NIR1_GRAPH_RETAINED_LIMIT";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(usize)]
pub(super) enum RetainedPart {
    Request = 0,
    CandidatePage = 1,
    #[expect(
        dead_code,
        reason = "Revision-cache charging is not yet integrated; the hard-memory claim remains HOLD"
    )]
    RevisionCache = 2,
    A2A3Material = 3,
    GraphMaps = 4,
    Response = 5,
    Serialization = 6,
}

impl RetainedPart {
    const COUNT: usize = 7;
}

/// Monotonic accounting is intentionally stricter than simultaneous liveness:
/// once charged, bytes stay charged until the query ends. This avoids a release
/// ordering proof, but it is not a complete memory certification by itself.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RetainedLedger {
    limit: usize,
    used: usize,
    parts: [usize; RetainedPart::COUNT],
}

impl Default for RetainedLedger {
    fn default() -> Self {
        Self::new(grimodex_core::narrative_nir1::MAX_GRAPH_INPUT_BYTES)
    }
}

impl RetainedLedger {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit: limit.min(grimodex_core::narrative_nir1::MAX_GRAPH_INPUT_BYTES),
            used: 0,
            parts: [0; RetainedPart::COUNT],
        }
    }

    pub(super) fn limit(&self) -> usize {
        self.limit
    }

    pub(super) fn used(&self) -> usize {
        self.used
    }

    pub(super) fn remaining(&self) -> usize {
        self.limit.saturating_sub(self.used)
    }

    pub(super) fn charged(&self, part: RetainedPart) -> usize {
        self.parts[part as usize]
    }

    /// Charge bytes before the corresponding allocation. The ledger is
    /// monotonic, so a failed admission leaves all prior charges intact.
    pub(super) fn admit(&mut self, part: RetainedPart, bytes: usize) -> Result<()> {
        let used = self
            .used
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!(RETAINED_LIMIT_ERROR))?;
        ensure!(used <= self.limit, RETAINED_LIMIT_ERROR);
        let part_total = self.parts[part as usize]
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!(RETAINED_LIMIT_ERROR))?;
        self.used = used;
        self.parts[part as usize] = part_total;
        Ok(())
    }
}

fn add(total: &mut usize, value: usize) -> Result<()> {
    *total = total
        .checked_add(value)
        .ok_or_else(|| anyhow::anyhow!(RETAINED_LIMIT_ERROR))?;
    Ok(())
}

fn multiply(left: usize, right: usize) -> Result<usize> {
    left.checked_mul(right)
        .ok_or_else(|| anyhow::anyhow!(RETAINED_LIMIT_ERROR))
}

pub(super) fn retained_string(value: &String) -> Result<usize> {
    size_of::<String>()
        .checked_add(value.capacity())
        .ok_or_else(|| anyhow::anyhow!(RETAINED_LIMIT_ERROR))
}

pub(super) fn retained_vec<T>(capacity: usize) -> Result<usize> {
    size_of::<Vec<T>>()
        .checked_add(multiply(capacity, size_of::<T>())?)
        .ok_or_else(|| anyhow::anyhow!(RETAINED_LIMIT_ERROR))
}

pub(super) fn retained_arc_control_block() -> Result<usize> {
    // Arc's two reference counters are part of the allocation that owns T.
    multiply(2, size_of::<usize>())
}

fn retained_scope_value(value: &ScopeValue) -> Result<usize> {
    let mut total = size_of::<ScopeValue>();
    match value {
        ScopeValue::Any { purpose } => {
            if let Some(purpose) = purpose {
                add(&mut total, retained_string(purpose)?)?;
            }
        }
        ScopeValue::Exact { value }
        | ScopeValue::NotApplicable { reason: value }
        | ScopeValue::Unavailable { reason: value } => {
            add(&mut total, retained_string(value)?)?;
        }
        ScopeValue::LegacyAbsent | ScopeValue::Unresolved => {}
    }
    Ok(total)
}

pub(super) fn retained_entity(entity: &EntityInput) -> Result<usize> {
    let mut total = size_of::<EntityInput>();
    for value in [
        &entity.entity_id,
        &entity.entity_type,
        &entity.label,
        &entity.source_token,
        &entity.scope.phase,
        &entity.scope.reveal,
        &entity.scope.authority_revision,
    ] {
        add(&mut total, retained_string(value)?)?;
    }
    for value in [
        &entity.scope.reading,
        &entity.scope.story,
        &entity.scope.auto,
    ] {
        add(&mut total, retained_scope_value(value)?)?;
    }
    if let Some(pov) = &entity.scope.pov {
        add(&mut total, retained_string(pov)?)?;
    }
    add(
        &mut total,
        retained_vec::<grimodex_core::narrative_nir1::EvidenceInput>(entity.evidence.capacity())?,
    )?;
    for evidence in &entity.evidence {
        add(
            &mut total,
            size_of::<grimodex_core::narrative_nir1::EvidenceInput>(),
        )?;
        for value in [&evidence.evidence_id, &evidence.source_ref, &evidence.quote] {
            add(&mut total, retained_string(value)?)?;
        }
    }
    Ok(total)
}

pub(super) fn retained_relation(relation: &GraphEdgeInput) -> Result<usize> {
    let mut total = size_of::<GraphEdgeInput>();
    for value in [
        &relation.edge_id,
        &relation.from_entity_id,
        &relation.to_entity_id,
        &relation.relation_type,
        &relation.directionality,
        &relation.source_token,
    ] {
        add(&mut total, retained_string(value)?)?;
    }
    add(
        &mut total,
        retained_vec::<String>(relation.evidence_ids.capacity())?,
    )?;
    for evidence_id in &relation.evidence_ids {
        add(&mut total, retained_string(evidence_id)?)?;
    }
    Ok(total)
}

pub(super) fn retained_binding(binding: &Nir1GraphMaterialBinding) -> Result<usize> {
    let mut total = size_of::<Nir1GraphMaterialBinding>();
    for value in [
        &binding.revision_id,
        &binding.decision_id,
        &binding.decision_token,
        &binding.freshness_token,
        &binding.scope_authority_revision,
        &binding.query_scene_source_token,
        &binding.query_scene_scope_token,
        &binding.query_scene_incarnation_id,
        &binding.reveal_state_token,
    ] {
        add(&mut total, retained_string(value)?)?;
    }
    Ok(total)
}

#[expect(
    dead_code,
    reason = "material accounting is an unconnected foundation, not hard-memory acceptance"
)]
pub(super) fn retained_material(material: &QualifiedGraphMaterial) -> Result<usize> {
    let mut total = size_of::<QualifiedGraphMaterial>();
    add(&mut total, retained_string(&material.revision_id)?)?;
    add(&mut total, retained_binding(&material.binding)?)?;
    add(&mut total, retained_arc_control_block()?)?;
    add(
        &mut total,
        retained_vec::<std::sync::Arc<EntityInput>>(material.entities.capacity())?,
    )?;
    add(
        &mut total,
        retained_vec::<std::sync::Arc<GraphEdgeInput>>(material.relations.capacity())?,
    )?;
    for entity in &material.entities {
        add(&mut total, retained_entity(entity)?)?;
        add(&mut total, retained_arc_control_block()?)?;
    }
    for relation in &material.relations {
        add(&mut total, retained_relation(relation)?)?;
        add(&mut total, retained_arc_control_block()?)?;
    }
    Ok(total)
}

#[expect(
    dead_code,
    reason = "response accounting is an unconnected foundation, not hard-memory acceptance"
)]
pub(super) fn retained_response(response: &Nir1GraphResponse) -> Result<usize> {
    let mut total = size_of::<Nir1GraphResponse>();
    add(&mut total, retained_string(&response.project_id)?)?;
    add(&mut total, retained_string(&response.query_scene_id)?)?;
    if let Some(scope_revision) = &response.scope_revision {
        add(&mut total, retained_string(scope_revision)?)?;
    }
    if let Some(reason) = &response.reason {
        add(&mut total, retained_string(reason)?)?;
    }
    if let Some(graph) = &response.graph {
        add(&mut total, retained_graph(graph)?)?;
    }
    Ok(total)
}

fn retained_graph(graph: &Nir1QualifiedGraph) -> Result<usize> {
    let mut total = size_of::<Nir1QualifiedGraph>();
    add(&mut total, retained_string(&graph.seed_entity_id)?)?;
    add(
        &mut total,
        retained_vec::<Nir1GraphNode>(graph.nodes.capacity())?,
    )?;
    add(
        &mut total,
        retained_vec::<super::Nir1GraphEdge>(graph.edges.capacity())?,
    )?;
    for node in &graph.nodes {
        add(
            &mut total,
            retained_vec::<std::sync::Arc<Nir1GraphMaterialBinding>>(node.bindings.capacity())?,
        )?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_admission_does_not_mutate_the_ledger() {
        let mut ledger = RetainedLedger::new(10);
        ledger.admit(RetainedPart::Request, 7).unwrap();
        assert_eq!(
            ledger
                .admit(RetainedPart::Response, 4)
                .unwrap_err()
                .to_string(),
            RETAINED_LIMIT_ERROR
        );
        assert_eq!(ledger.used(), 7);
        assert_eq!(ledger.charged(RetainedPart::Request), 7);
        assert_eq!(ledger.charged(RetainedPart::Response), 0);
    }

    #[test]
    fn category_charges_share_one_hard_limit() {
        let mut ledger = RetainedLedger::new(12);
        ledger.admit(RetainedPart::CandidatePage, 5).unwrap();
        ledger.admit(RetainedPart::GraphMaps, 4).unwrap();
        assert_eq!(ledger.used(), 9);
        assert_eq!(ledger.remaining(), 3);
        assert_eq!(ledger.charged(RetainedPart::CandidatePage), 5);
        assert_eq!(ledger.charged(RetainedPart::GraphMaps), 4);
    }

    #[test]
    fn requested_limit_cannot_exceed_the_graph_contract() {
        assert_eq!(
            grimodex_core::narrative_nir1::MAX_GRAPH_INPUT_BYTES,
            6_291_456
        );
        assert_eq!(
            RetainedLedger::new(usize::MAX).limit(),
            grimodex_core::narrative_nir1::MAX_GRAPH_INPUT_BYTES
        );
    }

    #[test]
    fn graph_capacity_accepts_n_and_rejects_n_plus_one() {
        let mut ledger = RetainedLedger::new(usize::MAX);
        ledger
            .admit(RetainedPart::Request, 6_291_456)
            .expect("the complete Graph capacity is admitted");
        assert_eq!(ledger.remaining(), 0);
        assert!(ledger.admit(RetainedPart::Response, 1).is_err());
        assert_eq!(ledger.used(), 6_291_456);
    }

    #[test]
    fn string_and_vector_helpers_include_owned_capacity() {
        let mut value = String::with_capacity(32);
        value.push('x');
        assert!(retained_string(&value).unwrap() >= size_of::<String>() + 32);
        assert_eq!(
            retained_vec::<u64>(3).unwrap(),
            size_of::<Vec<u64>>() + 3 * size_of::<u64>()
        );
    }
}
