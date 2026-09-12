use grimodex_core::narrative_nir1::{
    bounded_graph, pack_context, validate_entity_relation_bundle, ContextItemKind, EntityInput,
    EntityRelationBundle, EvidenceInput, GraphEdgeInput, GraphLimits, PackingRequest, ScopeBinding,
    ScopeValue,
};

fn scope() -> ScopeBinding {
    ScopeBinding {
        reading: ScopeValue::Exact {
            value: "scene:s1".into(),
        },
        story: ScopeValue::NotApplicable {
            reason: "reader-reference-purpose".into(),
        },
        auto: ScopeValue::NotApplicable {
            reason: "reader-reference-purpose".into(),
        },
        phase: "draft".into(),
        reveal: "reader".into(),
        pov: None,
        authority_revision:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000".into(),
    }
}

fn entity(id: &str) -> EntityInput {
    EntityInput {
        entity_id: id.into(),
        entity_type: "character".into(),
        label: id.into(),
        source_token: format!("v1:{id}"),
        scope: scope(),
        evidence: vec![EvidenceInput {
            evidence_id: format!("evidence:{id}"),
            source_ref: "scene:s1".into(),
            quote: format!("{id} appears"),
            start_utf16: 0,
            end_utf16: 12,
        }],
    }
}

#[test]
fn entity_relation_adapter_rejects_cross_project_and_missing_evidence() {
    let bundle = EntityRelationBundle {
        project_id: "project-a".into(),
        revision_id: "revision-1".into(),
        producer: "nir1-reviewed-entity-relation-v1".into(),
        entities: vec![entity("entity:a")],
        relations: vec![GraphEdgeInput {
            edge_id: "edge-1".into(),
            from_entity_id: "entity:a".into(),
            to_entity_id: "entity:missing".into(),
            relation_type: "knows".into(),
            directionality: "directed".into(),
            source_token: "v1:edge-1".into(),
            evidence_ids: vec!["evidence:missing".into()],
        }],
    };

    let error = validate_entity_relation_bundle(&bundle).expect_err("invalid bundle");
    assert!(error.to_string().contains("endpoint"));
}

#[test]
fn graph_is_deterministic_and_hard_bounded() {
    let entities = (0..5).map(|i| entity(&format!("entity:{i}"))).collect();
    let relations = (0..4)
        .map(|i| GraphEdgeInput {
            edge_id: format!("edge:{i}"),
            from_entity_id: format!("entity:{i}"),
            to_entity_id: format!("entity:{}", i + 1),
            relation_type: "knows".into(),
            directionality: "directed".into(),
            source_token: format!("v1:edge:{i}"),
            evidence_ids: vec![format!("evidence:entity:{i}")],
        })
        .collect();
    let bundle = EntityRelationBundle {
        project_id: "project-a".into(),
        revision_id: "revision-1".into(),
        producer: "nir1-reviewed-entity-relation-v1".into(),
        entities,
        relations,
    };
    let limits = GraphLimits {
        max_hops: 2,
        max_nodes: 3,
        max_edges: 2,
    };

    let first = bounded_graph(&bundle, "entity:0", limits).expect("bounded graph");
    let second = bounded_graph(&bundle, "entity:0", limits).expect("same graph");
    assert_eq!(first, second);
    assert_eq!(first.seed_entity_id, "entity:0");
    assert_eq!(first.nodes.len(), 3);
    assert_eq!(first.edges.len(), 2);
    assert!(first.nodes.iter().all(|node| node.hop <= 2));
}

#[test]
fn packing_keeps_evidence_units_atomic_and_raw_required() {
    let result = pack_context(PackingRequest {
        budget_tokens: 8,
        items: vec![
            ContextItemKind::Raw {
                id: "raw:query".into(),
                text: "query".into(),
                tokens: 2,
            },
            ContextItemKind::AcceptedIr {
                id: "ir:1".into(),
                text: "statement".into(),
                tokens: 2,
                atomic_group: "ir:1".into(),
            },
            ContextItemKind::GraphEvidence {
                id: "evidence:1".into(),
                text: "quote".into(),
                tokens: 3,
                atomic_group: "ir:1".into(),
            },
            ContextItemKind::AuthorDeclared {
                id: "author:1".into(),
                text: "note".into(),
                tokens: 5,
                atomic_group: "author:1".into(),
            },
        ],
    })
    .expect("packing");

    assert_eq!(result.used_tokens, 7);
    assert_eq!(result.selected_ids, vec!["raw:query", "ir:1", "evidence:1"]);
    assert_eq!(result.omitted_ids, vec!["author:1"]);
}

#[test]
fn scope_requires_purpose_for_any_and_never_accepts_unresolved() {
    let mut binding = scope();
    binding.reading = ScopeValue::Any { purpose: None };
    assert!(binding.validate().is_err());

    binding.reading = ScopeValue::Unresolved;
    assert!(binding.validate().is_err());
}
