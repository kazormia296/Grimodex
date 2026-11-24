use grimodex_core::narrative_change_review::{
    diff_evidence_records, identity_objects_from_bundle, EvidenceChange, EvidenceChangeError,
    EvidenceChangeKind, EvidenceRecord,
};
use grimodex_core::narrative_identity_diff::IdentityDiffObject;
use grimodex_core::narrative_nir1::{
    EntityInput, EntityRelationBundle, GraphEdgeInput, ScopeBinding, ScopeValue,
};

fn evidence(source_ref: &str, quote: &str, start_utf16: usize, end_utf16: usize) -> EvidenceRecord {
    EvidenceRecord {
        source_ref: source_ref.to_owned(),
        quote: quote.to_owned(),
        start_utf16,
        end_utf16,
    }
}

fn empty_bundle() -> EntityRelationBundle {
    EntityRelationBundle {
        project_id: "project".to_owned(),
        revision_id: "revision".to_owned(),
        producer: "producer".to_owned(),
        entities: Vec::new(),
        relations: Vec::new(),
    }
}

#[test]
fn bundle_entities_and_relations_become_identity_diff_objects() {
    let mut bundle = empty_bundle();
    bundle.entities.push(EntityInput {
        entity_id: "character-1".to_owned(),
        entity_type: "character".to_owned(),
        label: "Mina".to_owned(),
        source_token: "entity-token".to_owned(),
        scope: ScopeBinding {
            reading: ScopeValue::Exact {
                value: "reading".to_owned(),
            },
            story: ScopeValue::Exact {
                value: "story".to_owned(),
            },
            auto: ScopeValue::Exact {
                value: "auto".to_owned(),
            },
            phase: "phase".to_owned(),
            reveal: "reveal".to_owned(),
            pov: None,
            authority_revision: "authority".to_owned(),
        },
        evidence: Vec::new(),
    });
    bundle.relations.push(GraphEdgeInput {
        edge_id: "edge-1".to_owned(),
        from_entity_id: "character-1".to_owned(),
        to_entity_id: "character-2".to_owned(),
        relation_type: "knows".to_owned(),
        directionality: "directed".to_owned(),
        source_token: "relation-token".to_owned(),
        evidence_ids: Vec::new(),
    });

    assert_eq!(
        identity_objects_from_bundle(&bundle),
        vec![
            IdentityDiffObject {
                identity: "codex:character-1".to_owned(),
                content_token: "entity-token".to_owned(),
            },
            IdentityDiffObject {
                identity: "codex-relation:edge-1".to_owned(),
                content_token: "relation-token".to_owned(),
            },
        ]
    );
}

#[test]
fn empty_bundle_produces_no_identity_diff_objects() {
    assert!(identity_objects_from_bundle(&empty_bundle()).is_empty());
}

#[test]
fn classifies_unchanged_relocated_lost_and_gained_evidence() {
    let previous = [
        evidence("a", "relocated", 2, 8),
        evidence("b", "lost", 1, 4),
        evidence("c", "unchanged", 3, 9),
    ];
    let current = [
        evidence("a", "relocated", 5, 11),
        evidence("c", "unchanged", 3, 9),
        evidence("d", "gained", 0, 6),
    ];

    assert_eq!(
        diff_evidence_records(&previous, &current).unwrap(),
        vec![
            EvidenceChange {
                source_ref: "a".to_owned(),
                quote: "relocated".to_owned(),
                change: EvidenceChangeKind::Relocated,
            },
            EvidenceChange {
                source_ref: "b".to_owned(),
                quote: "lost".to_owned(),
                change: EvidenceChangeKind::Lost,
            },
            EvidenceChange {
                source_ref: "c".to_owned(),
                quote: "unchanged".to_owned(),
                change: EvidenceChangeKind::Unchanged,
            },
            EvidenceChange {
                source_ref: "d".to_owned(),
                quote: "gained".to_owned(),
                change: EvidenceChangeKind::Gained,
            },
        ]
    );
}

#[test]
fn evidence_diff_is_independent_of_input_order() {
    let previous = [evidence("a", "one", 0, 3), evidence("b", "two", 2, 5)];
    let previous_reversed = [previous[1].clone(), previous[0].clone()];
    let current = [evidence("b", "two", 3, 6), evidence("c", "three", 1, 4)];
    let current_reversed = [current[1].clone(), current[0].clone()];

    assert_eq!(
        diff_evidence_records(&previous, &current),
        diff_evidence_records(&previous_reversed, &current_reversed)
    );
}

#[test]
fn rejects_duplicate_evidence_and_empty_keys() {
    let duplicate = EvidenceChangeError::DuplicateEvidence {
        source_ref: "source".to_owned(),
        quote: "quote".to_owned(),
    };
    assert_eq!(
        diff_evidence_records(
            &[
                evidence("source", "quote", 0, 1),
                evidence("source", "quote", 2, 3)
            ],
            &[]
        ),
        Err(duplicate.clone())
    );
    assert_eq!(
        diff_evidence_records(
            &[],
            &[
                evidence("source", "quote", 0, 1),
                evidence("source", "quote", 2, 3)
            ]
        ),
        Err(duplicate)
    );
    assert_eq!(
        diff_evidence_records(&[evidence("", "quote", 0, 1)], &[]),
        Err(EvidenceChangeError::EmptySourceRef)
    );
    assert_eq!(
        diff_evidence_records(&[], &[evidence("source", "", 0, 1)]),
        Err(EvidenceChangeError::EmptyQuote)
    );
}

#[test]
fn same_quote_with_different_source_ref_is_not_a_match() {
    assert_eq!(
        diff_evidence_records(
            &[evidence("source-a", "same quote", 0, 10)],
            &[evidence("source-b", "same quote", 0, 10)]
        )
        .unwrap()
        .iter()
        .map(|change| (&*change.source_ref, &*change.quote, change.change))
        .collect::<Vec<_>>(),
        vec![
            ("source-a", "same quote", EvidenceChangeKind::Lost),
            ("source-b", "same quote", EvidenceChangeKind::Gained),
        ]
    );
}

#[test]
fn sorts_evidence_keys_by_utf16_code_units() {
    let supplementary = "source-\u{10000}";
    let bmp = "source-\u{e000}";
    let changes = diff_evidence_records(
        &[],
        &[
            evidence(bmp, "quote", 0, 1),
            evidence(supplementary, "quote", 0, 1),
        ],
    )
    .unwrap();

    assert_eq!(
        changes
            .iter()
            .map(|change| change.source_ref.as_str())
            .collect::<Vec<_>>(),
        vec![supplementary, bmp]
    );
}
