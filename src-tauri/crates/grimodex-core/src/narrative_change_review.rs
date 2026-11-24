use std::cmp::Ordering;
use std::collections::HashMap;

use crate::narrative_identity_diff::IdentityDiffObject;
use crate::narrative_nir1::EntityRelationBundle;
use crate::narrative_project_scope_authority::compare_utf16;

pub fn identity_objects_from_bundle(bundle: &EntityRelationBundle) -> Vec<IdentityDiffObject> {
    bundle
        .entities
        .iter()
        .map(|entity| IdentityDiffObject {
            identity: format!("codex:{}", entity.entity_id),
            content_token: entity.source_token.clone(),
        })
        .chain(bundle.relations.iter().map(|relation| IdentityDiffObject {
            identity: format!("codex-relation:{}", relation.edge_id),
            content_token: relation.source_token.clone(),
        }))
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceRecord {
    pub source_ref: String,
    pub quote: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum EvidenceChangeKind {
    Unchanged,
    Relocated,
    Lost,
    Gained,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceChange {
    pub source_ref: String,
    pub quote: String,
    pub change: EvidenceChangeKind,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EvidenceChangeError {
    #[error("evidence source_ref must not be empty")]
    EmptySourceRef,
    #[error("evidence quote must not be empty")]
    EmptyQuote,
}

type EvidencePositionIndex<'a> = HashMap<(&'a str, &'a str), Vec<(usize, usize)>>;

fn index_evidence(
    evidence: &[EvidenceRecord],
) -> Result<EvidencePositionIndex<'_>, EvidenceChangeError> {
    if evidence.iter().any(|item| item.source_ref.is_empty()) {
        return Err(EvidenceChangeError::EmptySourceRef);
    }
    if evidence.iter().any(|item| item.quote.is_empty()) {
        return Err(EvidenceChangeError::EmptyQuote);
    }

    let mut indexed = HashMap::with_capacity(evidence.len());
    for item in evidence {
        let key = (item.source_ref.as_str(), item.quote.as_str());
        indexed
            .entry(key)
            .or_insert_with(Vec::new)
            .push((item.start_utf16, item.end_utf16));
    }
    indexed
        .values_mut()
        .for_each(|positions| positions.sort_unstable());
    Ok(indexed)
}

pub fn diff_evidence_records(
    previous: &[EvidenceRecord],
    current: &[EvidenceRecord],
) -> Result<Vec<EvidenceChange>, EvidenceChangeError> {
    let previous = index_evidence(previous)?;
    let current = index_evidence(current)?;
    let mut keys: Vec<_> = previous.keys().chain(current.keys()).copied().collect();
    keys.sort_unstable_by(|left, right| {
        compare_utf16(left.0, right.0).then_with(|| compare_utf16(left.1, right.1))
    });
    keys.dedup();

    let mut changes = Vec::new();
    for (source_ref, quote) in keys {
        let previous_positions = previous
            .get(&(source_ref, quote))
            .cloned()
            .unwrap_or_default();
        let current_positions = current
            .get(&(source_ref, quote))
            .cloned()
            .unwrap_or_default();
        let (mut previous_remaining, mut current_remaining) = (Vec::new(), Vec::new());
        let (mut previous_index, mut current_index) = (0, 0);

        while previous_index < previous_positions.len() && current_index < current_positions.len() {
            match previous_positions[previous_index].cmp(&current_positions[current_index]) {
                Ordering::Equal => {
                    changes.push(evidence_change(
                        source_ref,
                        quote,
                        EvidenceChangeKind::Unchanged,
                        current_positions[current_index],
                    ));
                    previous_index += 1;
                    current_index += 1;
                }
                Ordering::Less => {
                    previous_remaining.push(previous_positions[previous_index]);
                    previous_index += 1;
                }
                Ordering::Greater => {
                    current_remaining.push(current_positions[current_index]);
                    current_index += 1;
                }
            }
        }
        previous_remaining.extend_from_slice(&previous_positions[previous_index..]);
        current_remaining.extend_from_slice(&current_positions[current_index..]);

        let paired = previous_remaining.len().min(current_remaining.len());
        for &position in current_remaining.iter().take(paired) {
            changes.push(evidence_change(
                source_ref,
                quote,
                EvidenceChangeKind::Relocated,
                position,
            ));
        }
        changes.extend(previous_remaining[paired..].iter().map(|position| {
            evidence_change(source_ref, quote, EvidenceChangeKind::Lost, *position)
        }));
        changes.extend(current_remaining[paired..].iter().map(|position| {
            evidence_change(source_ref, quote, EvidenceChangeKind::Gained, *position)
        }));
    }

    changes.sort_unstable_by(|left, right| {
        compare_utf16(&left.source_ref, &right.source_ref)
            .then_with(|| compare_utf16(&left.quote, &right.quote))
            .then_with(|| left.start_utf16.cmp(&right.start_utf16))
            .then_with(|| left.end_utf16.cmp(&right.end_utf16))
            .then_with(|| left.change.cmp(&right.change))
    });
    Ok(changes)
}

fn evidence_change(
    source_ref: &str,
    quote: &str,
    change: EvidenceChangeKind,
    (start_utf16, end_utf16): (usize, usize),
) -> EvidenceChange {
    EvidenceChange {
        source_ref: source_ref.to_owned(),
        quote: quote.to_owned(),
        change,
        start_utf16,
        end_utf16,
    }
}
