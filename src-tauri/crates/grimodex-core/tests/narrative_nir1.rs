use grimodex_core::narrative_nir1::{
    adapt_candidate_context_item, adapt_declared_context_item, adapt_raw_context_item,
    bounded_graph, estimate_nir1_context_tokens, pack_candidate_context, pack_context,
    validate_entity_relation_bundle, AtomicPart, CandidateContextItem, CandidatePackingRequest,
    ContextItemKind, EntityInput, EntityRelationBundle, EvidenceInput, GraphEdgeInput, GraphLimits,
    PackingPurpose, PackingRequest, ScopeBinding, ScopeValue,
};
use serde_json::json;

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
    let quote = format!("{id} appears");
    EntityInput {
        entity_id: id.into(),
        entity_type: "character".into(),
        label: id.into(),
        source_token: format!("v1:{id}"),
        scope: scope(),
        evidence: vec![EvidenceInput {
            evidence_id: format!("evidence:{id}"),
            source_ref: "scene:s1".into(),
            end_utf16: quote.encode_utf16().count(),
            quote,
            start_utf16: 0,
        }],
    }
}

fn candidate_binding(id: &str) -> [u8; 32] {
    let mut binding = [0_u8; 32];
    for (index, byte) in id.bytes().enumerate() {
        binding[index % binding.len()] ^= byte;
    }
    if binding.iter().all(|byte| *byte == 0) {
        binding[0] = 1;
    }
    binding
}

fn item_id_and_text(item: &ContextItemKind) -> (&str, &str) {
    match item {
        ContextItemKind::Raw { id, text, .. }
        | ContextItemKind::AcceptedIr { id, text, .. }
        | ContextItemKind::GraphEvidence { id, text, .. }
        | ContextItemKind::AuthorDeclared { id, text, .. }
        | ContextItemKind::UnreviewedForReview { id, text, .. } => (id, text),
    }
}

fn candidate_item(id: &str, part: AtomicPart, text: &str, tokens: usize) -> CandidateContextItem {
    candidate_item_from_binding(
        ContextItemKind::AcceptedIr {
            id: id.into(),
            text: text.into(),
            tokens,
            atomic_group: "group:p01".into(),
        },
        part,
        candidate_binding("p01"),
    )
    .expect("candidate item")
}

fn candidate_item_from_binding(
    item: ContextItemKind,
    part: AtomicPart,
    binding: [u8; 32],
) -> Result<CandidateContextItem, grimodex_core::narrative_nir1::Nir1ContractError> {
    adapt_candidate_context_item(item, part, binding)
}

fn unreviewed_item(id: &str, part: AtomicPart, text: &str, tokens: usize) -> CandidateContextItem {
    adapt_declared_context_item(
        ContextItemKind::UnreviewedForReview {
            id: id.into(),
            text: text.into(),
            tokens,
            atomic_group: "group:review-only".into(),
        },
        part,
    )
    .expect("unreviewed review item")
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
fn evidence_range_uses_absolute_utf16_width() {
    let mut source = entity("entity:a");
    source.evidence[0].quote = "Alice".into();
    source.evidence[0].start_utf16 = 2;
    source.evidence[0].end_utf16 = 7;
    let bundle = EntityRelationBundle {
        project_id: "project-a".into(),
        revision_id: "revision-1".into(),
        producer: "nir1-reviewed-entity-relation-v1".into(),
        entities: vec![source],
        relations: vec![],
    };

    validate_entity_relation_bundle(&bundle)
        .expect("a non-zero absolute UTF-16 range must be accepted");
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
fn packing_accepts_typescript_camel_case_atomic_group_wire() {
    for (kind, id) in [
        ("acceptedIr", "ir:1"),
        ("graphEvidence", "evidence:1"),
        ("authorDeclared", "author:1"),
        ("unreviewedForReview", "review:1"),
    ] {
        let request: PackingRequest = serde_json::from_value(json!({
            "budgetTokens": 8,
            "items": [
                {"kind": "raw", "id": "raw:query", "text": "query", "tokens": 2},
                {
                    "kind": kind,
                    "id": id,
                    "text": "derived",
                    "tokens": 2,
                    "atomicGroup": "unit:1"
                }
            ]
        }))
        .expect("TypeScript camelCase Packing wire parses");

        let packed = pack_context(request).expect("camelCase Packing wire is usable");
        assert_eq!(packed.selected_ids, vec!["raw:query", id]);
    }
}

#[test]
fn candidate_packing_requires_binding_and_complete_atomic_groups() {
    let raw = adapt_raw_context_item(ContextItemKind::Raw {
        id: "raw:p01".into(),
        text: "Raw text".into(),
        tokens: 2,
    })
    .expect("Raw adapter");
    let complete = vec![
        raw.clone(),
        candidate_item("statement:p01", AtomicPart::Statement, "statement", 2),
        candidate_item("negation:p01", AtomicPart::Negation, "negation", 2),
        candidate_item("attribution:p01", AtomicPart::Attribution, "attribution", 2),
        candidate_item("evidence:p01", AtomicPart::Evidence, "evidence", 2),
        candidate_item(
            "qualification:p01",
            AtomicPart::Qualification,
            "human-approved",
            1,
        ),
    ];
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 11,
        purpose: PackingPurpose::Writing,
        items: complete,
    })
    .expect("candidate packing");
    assert_eq!(packed.selected_ids.len(), 6);
    assert_eq!(packed.used_tokens, 11);

    let incomplete = vec![
        raw,
        candidate_item("statement:p01", AtomicPart::Statement, "statement", 2),
        candidate_item("negation:p01", AtomicPart::Negation, "negation", 2),
        candidate_item("attribution:p01", AtomicPart::Attribution, "attribution", 2),
        candidate_item(
            "qualification:p01",
            AtomicPart::Qualification,
            "human-approved",
            1,
        ),
    ];
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 11,
        purpose: PackingPurpose::Writing,
        items: incomplete,
    })
    .expect("incomplete groups are rejected as units");
    assert_eq!(packed.selected_ids, vec!["raw:p01"]);
    assert_eq!(packed.omitted_ids.len(), 4);

    let renderer_labeled = candidate_item_from_binding(
        ContextItemKind::AcceptedIr {
            id: "renderer:p01".into(),
            text: "self-labeled".into(),
            tokens: 1,
            atomic_group: "group:p01".into(),
        },
        AtomicPart::Statement,
        candidate_binding("renderer:p01"),
    )
    .expect("the pure adapter returns an immutable candidate item");
    let mut copied_item = renderer_labeled.item().clone();
    if let ContextItemKind::AcceptedIr { text, .. } = &mut copied_item {
        *text = "foreign replacement".into();
    }
    match renderer_labeled.item() {
        ContextItemKind::AcceptedIr { text, .. } => assert_eq!(text, "self-labeled"),
        _ => panic!("adapter changed the item kind"),
    }
    assert_eq!(renderer_labeled.atomic_part(), Some(AtomicPart::Statement));
    assert!(renderer_labeled.candidate_binding().is_some());

    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 11,
        purpose: PackingPurpose::Writing,
        items: vec![
            adapt_raw_context_item(ContextItemKind::Raw {
                id: "raw:p01".into(),
                text: "Raw text".into(),
                tokens: 2,
            })
            .expect("Raw adapter"),
            renderer_labeled,
        ],
    })
    .expect("an incomplete candidate group is omitted");
    assert_eq!(packed.selected_ids, vec!["raw:p01"]);
}

#[test]
fn candidate_packing_requires_raw_for_empty_and_non_raw_only_inputs() {
    let non_raw = vec![
        candidate_item(
            "statement:raw-required",
            AtomicPart::Statement,
            "statement",
            1,
        ),
        candidate_item("negation:raw-required", AtomicPart::Negation, "negation", 1),
        candidate_item(
            "attribution:raw-required",
            AtomicPart::Attribution,
            "attribution",
            1,
        ),
        candidate_item("evidence:raw-required", AtomicPart::Evidence, "evidence", 1),
        candidate_item(
            "qualification:raw-required",
            AtomicPart::Qualification,
            "qualification",
            1,
        ),
    ];
    for items in [non_raw, Vec::new()] {
        assert!(pack_candidate_context(CandidatePackingRequest {
            budget_tokens: 20,
            purpose: PackingPurpose::Writing,
            items,
        })
        .is_err());
    }
}

#[test]
fn candidate_packing_applies_writing_review_gate_to_complete_unreviewed_groups() {
    let raw = adapt_raw_context_item(ContextItemKind::Raw {
        id: "raw:review-gate".into(),
        text: "Raw text".into(),
        tokens: 2,
    })
    .expect("Raw adapter");
    let items = vec![
        raw.clone(),
        unreviewed_item("statement:review", AtomicPart::Statement, "statement", 1),
        unreviewed_item("negation:review", AtomicPart::Negation, "negation", 1),
        unreviewed_item(
            "attribution:review",
            AtomicPart::Attribution,
            "attribution",
            1,
        ),
        unreviewed_item("evidence:review", AtomicPart::Evidence, "evidence", 1),
        unreviewed_item(
            "qualification:review",
            AtomicPart::Qualification,
            "qualification",
            1,
        ),
    ];
    let writing = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 10,
        purpose: PackingPurpose::Writing,
        items: items.clone(),
    })
    .expect("writing gate");
    assert_eq!(writing.selected_ids, vec!["raw:review-gate"]);

    let review = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 10,
        purpose: PackingPurpose::Review,
        items,
    })
    .expect("review gate");
    assert_eq!(review.selected_ids.len(), 6);
}

#[test]
fn candidate_packing_rejects_duplicate_mixed_and_interleaved_groups() {
    let raw = adapt_raw_context_item(ContextItemKind::Raw {
        id: "raw:shape".into(),
        text: "Raw".into(),
        tokens: 1,
    })
    .expect("Raw adapter");
    let duplicate = vec![
        raw.clone(),
        candidate_item("statement:dup", AtomicPart::Statement, "statement", 1),
        candidate_item("statement:dup-2", AtomicPart::Statement, "duplicate", 1),
        candidate_item("negation:dup", AtomicPart::Negation, "negation", 1),
        candidate_item("attribution:dup", AtomicPart::Attribution, "attribution", 1),
        candidate_item("evidence:dup", AtomicPart::Evidence, "evidence", 1),
        candidate_item(
            "qualification:dup",
            AtomicPart::Qualification,
            "qualification",
            1,
        ),
    ];
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 10,
        purpose: PackingPurpose::Writing,
        items: duplicate,
    })
    .expect("duplicate group is omitted");
    assert_eq!(packed.selected_ids, vec!["raw:shape"]);

    let mixed = vec![
        raw.clone(),
        candidate_item("statement:mixed", AtomicPart::Statement, "statement", 1),
        candidate_item_from_binding(
            ContextItemKind::GraphEvidence {
                id: "negation:mixed".into(),
                text: "negation".into(),
                tokens: 1,
                atomic_group: "group:p01".into(),
            },
            AtomicPart::Negation,
            candidate_binding("p01"),
        )
        .expect("mixed graph item"),
    ];
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 10,
        purpose: PackingPurpose::Writing,
        items: mixed,
    })
    .expect("mixed group is omitted");
    assert_eq!(packed.selected_ids, vec!["raw:shape"]);

    let interleaved = vec![
        raw,
        candidate_item(
            "statement:interleaved",
            AtomicPart::Statement,
            "statement",
            1,
        ),
        adapt_raw_context_item(ContextItemKind::Raw {
            id: "raw:middle".into(),
            text: "middle".into(),
            tokens: 1,
        })
        .expect("middle Raw"),
        candidate_item("negation:interleaved", AtomicPart::Negation, "negation", 1),
        candidate_item(
            "attribution:interleaved",
            AtomicPart::Attribution,
            "attribution",
            1,
        ),
        candidate_item("evidence:interleaved", AtomicPart::Evidence, "evidence", 1),
        candidate_item(
            "qualification:interleaved",
            AtomicPart::Qualification,
            "qualification",
            1,
        ),
    ];
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 10,
        purpose: PackingPurpose::Writing,
        items: interleaved,
    })
    .expect("interleaved group is omitted");
    assert_eq!(packed.selected_ids, vec!["raw:shape", "raw:middle"]);

    let colliding = vec![
        adapt_raw_context_item(ContextItemKind::Raw {
            id: "group:p01".into(),
            text: "Raw collision".into(),
            tokens: 1,
        })
        .expect("colliding Raw adapter"),
        candidate_item("statement:collision", AtomicPart::Statement, "statement", 1),
        candidate_item("negation:collision", AtomicPart::Negation, "negation", 1),
        candidate_item(
            "attribution:collision",
            AtomicPart::Attribution,
            "attribution",
            1,
        ),
        candidate_item("evidence:collision", AtomicPart::Evidence, "evidence", 1),
    ];
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 10,
        purpose: PackingPurpose::Writing,
        items: colliding,
    })
    .expect("incomplete colliding group is omitted");
    assert_eq!(packed.selected_ids, vec!["group:p01"]);
}

#[test]
fn candidate_packing_poisoned_sixth_group_member_cannot_reappear() {
    let raw = adapt_raw_context_item(ContextItemKind::Raw {
        id: "raw:poison".into(),
        text: "Raw".into(),
        tokens: 1,
    })
    .expect("Raw adapter");
    let mut items = vec![
        raw,
        candidate_item("statement:poison", AtomicPart::Statement, "statement", 1),
        candidate_item("negation:poison", AtomicPart::Negation, "negation", 1),
        candidate_item(
            "attribution:poison",
            AtomicPart::Attribution,
            "attribution",
            1,
        ),
        candidate_item("evidence:poison", AtomicPart::Evidence, "evidence", 1),
        candidate_item(
            "qualification:poison",
            AtomicPart::Qualification,
            "qualification",
            1,
        ),
    ];
    items.push(candidate_item(
        "sixth:poison",
        AtomicPart::Statement,
        "duplicate statement",
        1,
    ));
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 20,
        purpose: PackingPurpose::Writing,
        items,
    })
    .expect("poisoned group is omitted as one unit");
    assert_eq!(packed.selected_ids, vec!["raw:poison"]);
    assert!(packed.selected_ids.iter().all(|id| id == "raw:poison"));
}

#[test]
fn candidate_priority_order_matches_typescript_for_equal_budget_groups() {
    let raw = adapt_raw_context_item(ContextItemKind::Raw {
        id: "raw:priority".into(),
        text: "Raw".into(),
        tokens: 1,
    })
    .expect("Raw adapter");
    let parts = [
        (AtomicPart::Statement, "statement"),
        (AtomicPart::Negation, "negation"),
        (AtomicPart::Attribution, "attribution"),
        (AtomicPart::Evidence, "evidence"),
        (AtomicPart::Qualification, "qualification"),
    ];
    let mut items = vec![raw];
    for (part, name) in parts {
        items.push(
            candidate_item_from_binding(
                ContextItemKind::AcceptedIr {
                    id: format!("accepted-{name}"),
                    text: name.into(),
                    tokens: 1,
                    atomic_group: "priority-accepted".into(),
                },
                part,
                candidate_binding("priority"),
            )
            .expect("accepted item"),
        );
    }
    for (part, name) in parts {
        items.push(
            adapt_declared_context_item(
                ContextItemKind::AuthorDeclared {
                    id: format!("author-{name}"),
                    text: name.into(),
                    tokens: 1,
                    atomic_group: "priority-author".into(),
                },
                part,
            )
            .expect("author item"),
        );
    }
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 6,
        purpose: PackingPurpose::Writing,
        items: items.clone(),
    })
    .expect("equal budget priority selection");
    assert_eq!(
        packed.selected_ids,
        vec![
            "raw:priority",
            "accepted-statement",
            "accepted-negation",
            "accepted-attribution",
            "accepted-evidence",
            "accepted-qualification",
        ]
    );
    let selected_text = packed
        .selected_ids
        .iter()
        .map(|selected_id| {
            items
                .iter()
                .find_map(|candidate| {
                    let (id, text) = item_id_and_text(candidate.item());
                    (id == selected_id).then_some(text.to_owned())
                })
                .expect("selected item text")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        selected_text,
        vec![
            "Raw",
            "statement",
            "negation",
            "attribution",
            "evidence",
            "qualification",
        ]
    );
}

#[test]
fn candidate_graph_group_has_the_same_priority_as_typescript_p12() {
    let raw = adapt_raw_context_item(ContextItemKind::Raw {
        id: "p12-raw".into(),
        text: "Raw".into(),
        tokens: 4,
    })
    .expect("Raw adapter");
    let parts = [
        (AtomicPart::Statement, "graph-statement", 5),
        (AtomicPart::Negation, "graph-negation", 10),
        (AtomicPart::Attribution, "graph-attribution", 2),
        (AtomicPart::Evidence, "graph-evidence", 18),
        (AtomicPart::Qualification, "graph-qualification", 1),
    ];
    let mut items = vec![raw];
    for (part, id, tokens) in parts {
        items.push(
            candidate_item_from_binding(
                ContextItemKind::GraphEvidence {
                    id: id.into(),
                    text: id.into(),
                    tokens,
                    atomic_group: "p12-graph".into(),
                },
                part,
                candidate_binding("p12-graph"),
            )
            .expect("Graph candidate binding"),
        );
    }
    for (part, id) in [
        (AtomicPart::Statement, "accepted-statement"),
        (AtomicPart::Negation, "accepted-negation"),
        (AtomicPart::Attribution, "accepted-attribution"),
        (AtomicPart::Evidence, "accepted-evidence"),
        (AtomicPart::Qualification, "accepted-qualification"),
    ] {
        items.push(
            candidate_item_from_binding(
                ContextItemKind::AcceptedIr {
                    id: id.into(),
                    text: id.into(),
                    tokens: 2,
                    atomic_group: "p12-accepted".into(),
                },
                part,
                candidate_binding("p12-accepted"),
            )
            .expect("Accepted candidate binding"),
        );
    }
    let packed = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 40,
        purpose: PackingPurpose::Writing,
        items,
    })
    .expect("P-12 shared candidate packing");
    assert_eq!(packed.used_tokens, 40);
    assert_eq!(
        packed.selected_ids,
        vec![
            "p12-raw",
            "graph-statement",
            "graph-negation",
            "graph-attribution",
            "graph-evidence",
            "graph-qualification",
        ]
    );
}

#[test]
fn candidate_priority_tie_and_oversized_high_group_are_stable() {
    let raw = adapt_raw_context_item(ContextItemKind::Raw {
        id: "raw:shared".into(),
        text: "Raw".into(),
        tokens: 1,
    })
    .expect("Raw adapter");
    let make_group = |group: &str, prefix: &str, tokens: usize| {
        [
            (AtomicPart::Statement, "statement"),
            (AtomicPart::Negation, "negation"),
            (AtomicPart::Attribution, "attribution"),
            (AtomicPart::Evidence, "evidence"),
            (AtomicPart::Qualification, "qualification"),
        ]
        .into_iter()
        .map(|(part, suffix)| {
            candidate_item_from_binding(
                ContextItemKind::AcceptedIr {
                    id: format!("{prefix}-{suffix}"),
                    text: suffix.into(),
                    tokens,
                    atomic_group: group.into(),
                },
                part,
                candidate_binding(group),
            )
            .expect("shared accepted candidate binding")
        })
        .collect::<Vec<_>>()
    };
    let mut tie_items = vec![raw.clone()];
    tie_items.extend(make_group("tie-first", "first", 1));
    tie_items.extend(make_group("tie-second", "second", 1));
    let tie = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 6,
        purpose: PackingPurpose::Writing,
        items: tie_items,
    })
    .expect("stable tie");
    assert_eq!(tie.used_tokens, 6);
    assert!(tie.selected_ids.iter().any(|id| id == "first-statement"));
    assert!(!tie.selected_ids.iter().any(|id| id == "second-statement"));

    let mut oversized_items = vec![raw];
    oversized_items.extend(make_group("oversized-high", "high", 9));
    oversized_items.extend(make_group("small-fallback", "small", 1));
    let oversized = pack_candidate_context(CandidatePackingRequest {
        budget_tokens: 6,
        purpose: PackingPurpose::Writing,
        items: oversized_items,
    })
    .expect("oversized high group is skipped");
    assert_eq!(oversized.used_tokens, 6);
    assert!(oversized
        .selected_ids
        .iter()
        .any(|id| id == "small-statement"));
    assert!(!oversized
        .selected_ids
        .iter()
        .any(|id| id == "high-statement"));
}

#[test]
fn candidate_binding_rejects_an_empty_identity() {
    assert!(candidate_item_from_binding(
        ContextItemKind::AcceptedIr {
            id: "unbound".into(),
            text: "unbound".into(),
            tokens: 1,
            atomic_group: "unbound".into(),
        },
        AtomicPart::Statement,
        [0_u8; 32],
    )
    .is_err());
}

#[test]
fn canonical_context_token_estimator_counts_compact_unicode_and_json() {
    assert_eq!(estimate_nir1_context_tokens(""), 0);
    assert!(estimate_nir1_context_tokens(&"日本語".repeat(32)) > 1);
    assert!(
        estimate_nir1_context_tokens(
            r#"{"statement":"門が開いた","evidence":[{"quote":"鐘が鳴った"}],"decision":"approved"}"#
        ) > 1
    );
}

#[test]
fn scope_requires_purpose_for_any_and_never_accepts_unresolved() {
    let mut binding = scope();
    binding.reading = ScopeValue::Any { purpose: None };
    assert!(binding.validate().is_err());

    binding.reading = ScopeValue::Unresolved;
    assert!(binding.validate().is_err());
}
