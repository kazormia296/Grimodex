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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EvidenceChangeError {
    #[error("evidence source_ref must not be empty")]
    EmptySourceRef,
    #[error("evidence quote must not be empty")]
    EmptyQuote,
    #[error("evidence with source_ref `{source_ref}` and quote `{quote}` appears more than once")]
    DuplicateEvidence { source_ref: String, quote: String },
}

fn index_evidence(
    evidence: &[EvidenceRecord],
) -> Result<HashMap<(&str, &str), &EvidenceRecord>, EvidenceChangeError> {
    if evidence.iter().any(|item| item.source_ref.is_empty()) {
        return Err(EvidenceChangeError::EmptySourceRef);
    }
    if evidence.iter().any(|item| item.quote.is_empty()) {
        return Err(EvidenceChangeError::EmptyQuote);
    }

    let mut indexed = HashMap::with_capacity(evidence.len());
    let mut duplicates = Vec::new();
    for item in evidence {
        let key = (item.source_ref.as_str(), item.quote.as_str());
        if indexed.insert(key, item).is_some() {
            duplicates.push(key);
        }
    }
    if !duplicates.is_empty() {
        duplicates.sort_unstable_by(|left, right| {
            compare_utf16(left.0, right.0).then_with(|| compare_utf16(left.1, right.1))
        });
        let (source_ref, quote) = duplicates[0];
        return Err(EvidenceChangeError::DuplicateEvidence {
            source_ref: source_ref.to_owned(),
            quote: quote.to_owned(),
        });
    }
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

    Ok(keys
        .into_iter()
        .map(|(source_ref, quote)| {
            let change = match (
                previous.get(&(source_ref, quote)),
                current.get(&(source_ref, quote)),
            ) {
                (None, Some(_)) => EvidenceChangeKind::Gained,
                (Some(_), None) => EvidenceChangeKind::Lost,
                (Some(previous), Some(current))
                    if previous.start_utf16 == current.start_utf16
                        && previous.end_utf16 == current.end_utf16 =>
                {
                    EvidenceChangeKind::Unchanged
                }
                (Some(_), Some(_)) => EvidenceChangeKind::Relocated,
                (None, None) => unreachable!("key came from one of the evidence indexes"),
            };
            EvidenceChange {
                source_ref: source_ref.to_owned(),
                quote: quote.to_owned(),
                change,
            }
        })
        .collect())
}
