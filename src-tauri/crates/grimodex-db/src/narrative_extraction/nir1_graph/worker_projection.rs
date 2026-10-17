//! Owned projection of one validated NQG3 frame. Built while the result lease
//! is held; nothing here borrows the Native region. Counts are checked before
//! any allocation. Manuscript bodies are never part of a frame.
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, ensure, Result};
use grimodex_core::narrative_nir1::{
    EntityInput, EvidenceInput, GraphEdgeInput, ScopeBinding, ScopeValue, MAX_GRAPH_EDGES,
    MAX_GRAPH_NODES, MAX_GRAPH_QUERY_RECORDS, MAX_GRAPH_RECORDS, MAX_GRAPH_SCENES,
};

use super::worker_frame::{
    BindingView, EdgeView, EntityView, FrameView, RelationView, SceneView, ScopeBindingView,
    ScopeView,
};
use super::{
    Nir1GraphEdge, Nir1GraphMaterialBinding, Nir1GraphNode, Nir1GraphResponse,
    Nir1GraphSceneAssociation, Nir1QualifiedGraph,
};

/// A validated available frame, owned. `elapsed` is the admission-to-lease
/// time of the worker query and is diagnostic only.
#[derive(Debug)]
pub struct Nir1GraphProjection {
    pub project_id: String,
    pub query_scene_id: String,
    /// None exactly when no Revision qualified: an available, empty Graph.
    pub scope_revision: Option<String>,
    /// The same owned type as the in-process reader.
    pub graph: Nir1QualifiedGraph,
    /// Admission→lease of the worker query. Diagnostic only.
    pub elapsed: Duration,
}

impl Nir1GraphProjection {
    /// Project a validated frame. Refuses an unavailable frame and any count
    /// above the Graph bounds before the first allocation.
    pub fn from_frame(view: &FrameView<'_>, elapsed: Duration) -> Result<Self> {
        let graph = view
            .graph()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_PROJECTION_UNAVAILABLE"))?;
        ensure!(
            graph.node_count() <= MAX_GRAPH_NODES
                && graph.edge_count() <= MAX_GRAPH_EDGES
                && graph.scene_count() <= MAX_GRAPH_SCENES,
            "NIR1_GRAPH_PROJECTION_COUNT"
        );
        for node in graph.nodes() {
            let node = node?;
            ensure!(
                node.binding_count() <= MAX_GRAPH_QUERY_RECORDS
                    && node.entity.evidence_count() <= MAX_GRAPH_RECORDS,
                "NIR1_GRAPH_PROJECTION_COUNT"
            );
        }
        for edge in graph.edges() {
            let edge = edge?;
            ensure!(
                edge.relation.evidence_id_count() <= MAX_GRAPH_RECORDS
                    && edge.from.evidence_count() <= MAX_GRAPH_RECORDS
                    && edge.to.evidence_count() <= MAX_GRAPH_RECORDS,
                "NIR1_GRAPH_PROJECTION_COUNT"
            );
        }

        let mut nodes = Vec::with_capacity(graph.node_count());
        for node in graph.nodes() {
            let node = node?;
            let entity = Arc::new(entity_input(&node.entity)?);
            let mut bindings = Vec::with_capacity(node.binding_count());
            let mut binding_scopes = Vec::with_capacity(node.binding_count());
            for item in node.bindings() {
                let item = item?;
                bindings.push(Arc::new(material_binding(&item.binding)));
                binding_scopes.push(Arc::new(scope_binding(&item.scope)));
            }
            nodes.push(Nir1GraphNode {
                entity,
                hop: node.hop,
                bindings,
                binding_scopes,
            });
        }

        let mut edges = Vec::with_capacity(graph.edge_count());
        for edge in graph.edges() {
            let edge = edge?;
            edges.push(edge_projection(&nodes, &edge)?);
        }

        let mut scenes = Vec::with_capacity(graph.scene_count());
        for scene in graph.scenes() {
            scenes.push(scene_association(&scene?));
        }

        Ok(Self {
            project_id: view.project().to_owned(),
            query_scene_id: view.query_scene().to_owned(),
            scope_revision: graph.scope_revision().map(str::to_owned),
            graph: Nir1QualifiedGraph {
                seed_entity_id: graph.seed().to_owned(),
                generation: graph.generation(),
                nodes,
                edges,
                scene_total: graph.diagnostic_scene_total(),
                scenes,
            },
            elapsed,
        })
    }

    /// The in-process response shape (re-encode in tests; CP-3a serialization).
    pub fn into_response(self) -> Nir1GraphResponse {
        Nir1GraphResponse {
            status: "available",
            project_id: self.project_id,
            query_scene_id: self.query_scene_id,
            scope_revision: self.scope_revision,
            graph: Some(self.graph),
            reason: None,
        }
    }
}

/// An edge endpoint shares the node's Arc when the same Entity value is
/// already a node; otherwise it gets its own Arc.
fn edge_projection(nodes: &[Nir1GraphNode], edge: &EdgeView<'_>) -> Result<Nir1GraphEdge> {
    Ok(Nir1GraphEdge {
        relation: Arc::new(relation_input(&edge.relation)?),
        from: shared_entity(nodes, &edge.from)?,
        to: shared_entity(nodes, &edge.to)?,
        binding: Arc::new(material_binding(&edge.binding)),
    })
}

fn shared_entity(nodes: &[Nir1GraphNode], view: &EntityView<'_>) -> Result<Arc<EntityInput>> {
    let candidate = entity_input(view)?;
    Ok(nodes
        .iter()
        .find(|node| *node.entity == candidate)
        .map(|node| Arc::clone(&node.entity))
        .unwrap_or_else(|| Arc::new(candidate)))
}

fn entity_input(view: &EntityView<'_>) -> Result<EntityInput> {
    let mut evidence = Vec::with_capacity(view.evidence_count());
    for item in view.evidence() {
        let item = item?;
        evidence.push(EvidenceInput {
            evidence_id: item.id.to_owned(),
            source_ref: item.source.to_owned(),
            quote: item.quote.to_owned(),
            start_utf16: usize::try_from(item.start)?,
            end_utf16: usize::try_from(item.end)?,
        });
    }
    Ok(EntityInput {
        entity_id: view.id.to_owned(),
        entity_type: view.kind.to_owned(),
        label: view.label.to_owned(),
        source_token: view.source.to_owned(),
        scope: scope_binding(&view.scope),
        evidence,
    })
}

fn scope_binding(view: &ScopeBindingView<'_>) -> ScopeBinding {
    ScopeBinding {
        reading: scope_value(view.reading),
        story: scope_value(view.story),
        auto: scope_value(view.auto),
        phase: view.phase.to_owned(),
        reveal: view.reveal.to_owned(),
        pov: view.pov.map(str::to_owned),
        authority_revision: view.authority_revision.to_owned(),
    }
}

fn scope_value(view: ScopeView<'_>) -> ScopeValue {
    match view {
        ScopeView::Any(purpose) => ScopeValue::Any {
            purpose: purpose.map(str::to_owned),
        },
        ScopeView::Exact(value) => ScopeValue::Exact {
            value: value.to_owned(),
        },
        ScopeView::NotApplicable(reason) => ScopeValue::NotApplicable {
            reason: reason.to_owned(),
        },
        ScopeView::Unavailable(reason) => ScopeValue::Unavailable {
            reason: reason.to_owned(),
        },
        ScopeView::LegacyAbsent => ScopeValue::LegacyAbsent,
        ScopeView::Unresolved => ScopeValue::Unresolved,
    }
}

fn relation_input(view: &RelationView<'_>) -> Result<GraphEdgeInput> {
    let mut evidence_ids = Vec::with_capacity(view.evidence_id_count());
    for id in view.evidence_ids() {
        evidence_ids.push(id?.to_owned());
    }
    Ok(GraphEdgeInput {
        edge_id: view.edge_id.to_owned(),
        from_entity_id: view.from_entity_id.to_owned(),
        to_entity_id: view.to_entity_id.to_owned(),
        relation_type: view.relation_type.to_owned(),
        directionality: view.directionality.as_str().to_owned(),
        source_token: view.source_token.to_owned(),
        evidence_ids,
    })
}

fn material_binding(view: &BindingView<'_>) -> Nir1GraphMaterialBinding {
    Nir1GraphMaterialBinding {
        revision_id: view.revision_id.to_owned(),
        decision_id: view.decision_id.to_owned(),
        decision_token: view.decision_token.to_owned(),
        freshness_token: view.freshness_token.to_owned(),
        scope_authority_revision: view.scope_authority_revision.to_owned(),
        query_scene_source_token: view.query_scene_source_token.to_owned(),
        query_scene_scope_token: view.query_scene_scope_token.to_owned(),
        query_scene_incarnation_id: view.query_scene_incarnation_id.to_owned(),
        reveal_state_token: view.reveal_state_token.to_owned(),
    }
}

fn scene_association(view: &SceneView<'_>) -> Nir1GraphSceneAssociation {
    Nir1GraphSceneAssociation {
        scene_id: view.scene_id.to_owned(),
        scene_incarnation_id: view.scene_incarnation_id.map(str::to_owned),
        scene_source_token: view.scene_source_token.to_owned(),
        scene_scope_token: view.scene_scope_token.map(str::to_owned),
        pin_rowid: view.pin.rowid,
        pin_entry_id: view.pin.entry_id.to_owned(),
        pin_created_at: view.pin.created_at.to_owned(),
        path_hop: view.path.hop(),
        path_edge_indices: view.path.edge_indices().to_vec(),
    }
}
