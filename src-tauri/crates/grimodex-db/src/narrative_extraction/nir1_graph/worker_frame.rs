//! One-query finite wire format. All lengths are checked *before* obtaining
//! borrowed slices. Native validates the entire frame without an owned tree.
use super::{Nir1GraphEdge, Nir1GraphMaterialBinding, Nir1GraphNode, Nir1GraphResponse};
use anyhow::{ensure, Result};
use grimodex_core::narrative_nir1::{
    EntityInput, EvidenceInput, GraphEdgeInput, ScopeBinding, ScopeValue, MAX_GRAPH_EDGES,
    MAX_GRAPH_NODES, MAX_GRAPH_RECORDS,
};

pub const FRAME_BYTES: usize = super::c_query_worker::FRAME_BYTES;
const MAGIC: &[u8; 4] = b"NQG1";

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
        ensure!(
            n.bindings.len() <= MAX_GRAPH_RECORDS,
            "NIR1_GRAPH_FRAME_COUNT"
        );
        self.u16(n.bindings.len())?;
        for b in &n.bindings {
            self.binding(b)?;
        }
        Ok(())
    }
    fn edge(&mut self, e: &Nir1GraphEdge) -> Result<()> {
        self.relation(&e.relation)?;
        self.entity(&e.from)?;
        self.entity(&e.to)?;
        self.binding(&e.binding)
    }
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
        w.text(
            response
                .scope_revision
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_FRAME_SCOPE"))?,
        )?;
        w.add(&graph.generation.to_le_bytes())?;
        w.text(&graph.seed_entity_id)?;
        ensure!(
            graph.nodes.len() <= MAX_GRAPH_NODES && graph.edges.len() <= MAX_GRAPH_EDGES,
            "NIR1_GRAPH_FRAME_COUNT"
        );
        w.u16(graph.nodes.len())?;
        w.u16(graph.edges.len())?;
        for node in &graph.nodes {
            w.node(node)?;
        }
        for edge in &graph.edges {
            w.edge(edge)?;
        }
    } else {
        ensure!(
            response.status == "unavailable" && response.scope_revision.is_none(),
            "NIR1_GRAPH_FRAME_STATUS"
        );
        w.text(
            response
                .reason
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_FRAME_REASON"))?,
        )?;
    }
    Ok(w.bytes)
}

#[derive(Clone, Copy)]
pub struct EvidenceView<'a> {
    pub id: &'a str,
    pub source: &'a str,
    pub quote: &'a str,
    pub start: u32,
    pub end: u32,
}
#[derive(Clone, Copy)]
pub struct EntityView<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub label: &'a str,
    pub source: &'a str,
    pub reading: ScopeView<'a>,
    pub evidence_count: usize,
    pub first_evidence: Option<EvidenceView<'a>>,
}
#[derive(Clone, Copy)]
pub enum ScopeView<'a> {
    Any(Option<&'a str>),
    Exact(&'a str),
    NotApplicable(&'a str),
    Unavailable(&'a str),
    LegacyAbsent,
    Unresolved,
}
#[derive(Clone, Copy)]
pub struct BindingView<'a> {
    pub revision_id: &'a str,
    pub decision_id: &'a str,
}
#[derive(Clone, Copy)]
pub struct NodeView<'a> {
    pub entity: EntityView<'a>,
    pub hop: u8,
    pub binding_count: usize,
    pub first_binding: Option<BindingView<'a>>,
}
#[derive(Clone, Copy)]
pub struct FrameView<'a> {
    pub project: &'a str,
    pub scene: &'a str,
    pub scope: Option<&'a str>,
    pub seed: Option<&'a str>,
    pub generation: Option<i64>,
    pub node_count: usize,
    pub edge_count: usize,
    pub first_node: Option<NodeView<'a>>,
    pub reason: Option<&'a str>,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_FRAME_TRUNCATED"))?;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<usize> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?) as usize)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }
    fn text(&mut self) -> Result<&'a str> {
        let n = self.u32()? as usize;
        Ok(std::str::from_utf8(self.take(n)?)?)
    }
    fn optional(&mut self) -> Result<Option<&'a str>> {
        match self.byte()? {
            0 => Ok(None),
            1 => Ok(Some(self.text()?)),
            _ => anyhow::bail!("NIR1_GRAPH_FRAME_ENUM"),
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
            _ => anyhow::bail!("NIR1_GRAPH_FRAME_ENUM"),
        })
    }
    fn evidence(&mut self) -> Result<EvidenceView<'a>> {
        let id = self.text()?;
        let source = self.text()?;
        let quote = self.text()?;
        let start = self.u32()?;
        let end = self.u32()?;
        let quote_len = quote.encode_utf16().count();
        ensure!(
            end >= start && end as usize <= quote_len,
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
    fn entity(&mut self) -> Result<EntityView<'a>> {
        let id = self.text()?;
        let kind = self.text()?;
        let label = self.text()?;
        let source = self.text()?;
        let reading = self.scope_value()?;
        self.scope_value()?;
        self.scope_value()?;
        self.text()?;
        self.text()?;
        self.optional()?;
        self.text()?;
        let count = self.u16()?;
        ensure!(count <= MAX_GRAPH_RECORDS, "NIR1_GRAPH_FRAME_COUNT");
        let mut first_evidence = None;
        for i in 0..count {
            let e = self.evidence()?;
            if i == 0 {
                first_evidence = Some(e);
            }
        }
        Ok(EntityView {
            id,
            kind,
            label,
            source,
            reading,
            evidence_count: count,
            first_evidence,
        })
    }
    fn binding(&mut self) -> Result<BindingView<'a>> {
        let revision_id = self.text()?;
        let decision_id = self.text()?;
        for _ in 0..7 {
            self.text()?;
        }
        Ok(BindingView {
            revision_id,
            decision_id,
        })
    }
    fn node(&mut self) -> Result<NodeView<'a>> {
        let entity = self.entity()?;
        let hop = self.byte()?;
        ensure!(hop <= 2, "NIR1_GRAPH_FRAME_HOP");
        let count = self.u16()?;
        ensure!(count <= MAX_GRAPH_RECORDS, "NIR1_GRAPH_FRAME_COUNT");
        let mut first_binding = None;
        for i in 0..count {
            let binding = self.binding()?;
            if i == 0 {
                first_binding = Some(binding);
            }
        }
        Ok(NodeView {
            entity,
            hop,
            binding_count: count,
            first_binding,
        })
    }
    fn edge(&mut self) -> Result<()> {
        for i in 0..6 {
            let s = self.text()?;
            if i == 4 {
                ensure!(
                    matches!(s, "directed" | "symmetric"),
                    "NIR1_GRAPH_FRAME_DIRECTION"
                );
            }
        }
        let count = self.u16()?;
        ensure!(count <= MAX_GRAPH_RECORDS, "NIR1_GRAPH_FRAME_COUNT");
        for _ in 0..count {
            self.text()?;
        }
        self.entity()?;
        self.entity()?;
        self.binding()?;
        Ok(())
    }
}

/// Complete structural validation including trailing bytes; this never allocates.
pub fn validate(bytes: &[u8]) -> Result<FrameView<'_>> {
    ensure!(bytes.len() <= FRAME_BYTES, "NIR1_GRAPH_FRAME_LIMIT");
    let mut c = Cursor { bytes, position: 0 };
    ensure!(c.take(4)? == MAGIC, "NIR1_GRAPH_FRAME_MAGIC");
    let available = match c.byte()? {
        0 => false,
        1 => true,
        _ => anyhow::bail!("NIR1_GRAPH_FRAME_ENUM"),
    };
    let project = c.text()?;
    let scene = c.text()?;
    let view = if available {
        let scope = c.text()?;
        let generation = i64::from_le_bytes(c.take(8)?.try_into()?);
        let seed = c.text()?;
        let nodes = c.u16()?;
        let edges = c.u16()?;
        ensure!(
            nodes <= MAX_GRAPH_NODES && edges <= MAX_GRAPH_EDGES,
            "NIR1_GRAPH_FRAME_COUNT"
        );
        let mut first_node = None;
        for i in 0..nodes {
            let n = c.node()?;
            if i == 0 {
                first_node = Some(n);
            }
        }
        for _ in 0..edges {
            c.edge()?;
        }
        FrameView {
            project,
            scene,
            scope: Some(scope),
            seed: Some(seed),
            generation: Some(generation),
            node_count: nodes,
            edge_count: edges,
            first_node,
            reason: None,
        }
    } else {
        FrameView {
            project,
            scene,
            scope: None,
            seed: None,
            generation: None,
            node_count: 0,
            edge_count: 0,
            first_node: None,
            reason: Some(c.text()?),
        }
    };
    ensure!(c.position == bytes.len(), "NIR1_GRAPH_FRAME_TRAILING");
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_child_frame_rejected_before_view() -> Result<()> {
        let mut raw = b"NQG1\x00\x01\x00\x00\x00x\x01\x00\x00\x00s\x01\x00\x00\x00r".to_vec();
        assert_eq!(validate(&raw)?.reason, Some("r"));
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
}
