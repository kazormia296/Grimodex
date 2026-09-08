//! Compact current-candidate checks. Immutable D1 contents and root request
//! receipts were verified during build; their exact active heads remain bound.
//! Source observations are checked once by the Index's union of dependencies.
use std::collections::{HashMap, HashSet};

use anyhow::Result;
use rusqlite::Connection;

use super::{canonical::canonical_instant, runtime::IndexProof};

pub(super) fn still_current(conn: &Connection, proof: &IndexProof) -> Result<bool> {
    let expected = proof
        .candidates
        .iter()
        .map(|candidate| (&candidate.verified.revision_id, &candidate.verified))
        .collect::<HashMap<_, _>>();
    if expected.is_empty() {
        return Ok(true);
    }
    let mut seen = HashSet::new();
    let mut statement = conn.prepare("SELECT p.current_revision_id,f.evidence_freshness,f.build_action,f.semantic_epoch_id,
        f.last_evaluated_run_id,f.dependency_set_digest,f.updated_at,h.active_declaration_set_id,h.producer_id,h.producer_generation,
        s.dependency_set_digest,s.state,s.producer_id,s.producer_generation,s.project_id,s.consumer_kind,s.consumer_key,
        p.id,r.reconciliation_envelope_digest,d.id
        FROM narrative_proposals p JOIN narrative_proposal_sets ps ON ps.id=p.proposal_set_id
        LEFT JOIN narrative_proposal_revisions r ON r.id=p.current_revision_id AND r.proposal_id=p.id
        LEFT JOIN narrative_proposal_decisions d ON d.id=(SELECT latest.id FROM narrative_proposal_decisions latest
            WHERE latest.proposal_id=p.id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
        LEFT JOIN narrative_consumer_freshness f ON f.project_id=ps.project_id AND f.consumer_kind='proposal-revision' AND f.consumer_key=p.current_revision_id
        LEFT JOIN narrative_dependency_declaration_heads h ON h.project_id=ps.project_id AND h.consumer_kind='proposal-revision' AND h.consumer_key=p.current_revision_id
        LEFT JOIN narrative_dependency_declaration_sets s ON s.id=h.active_declaration_set_id
        WHERE ps.project_id=?1 AND p.current_revision_id IS NOT NULL")?;
    let mut rows = statement.query([&proof.project])?;
    while let Some(row) = rows.next()? {
        let revision: String = row.get(0)?;
        let Some(candidate) = expected.get(&revision) else {
            continue;
        };
        if !seen.insert(revision.clone()) {
            return Ok(false);
        }
        let text = |column| row.get::<_, Option<String>>(column);
        let eq = |column, value: &str| -> rusqlite::Result<bool> {
            Ok(text(column)?.as_deref() == Some(value))
        };
        let (_, expected_generation) =
            super::super::human_material_basis::source_basis_d1_producer(&candidate.sources);
        if !eq(1, "fresh")?
            || !eq(2, "none")?
            || !eq(3, &proof.semantic_epoch)?
            || text(4)? != candidate.canonical.last_evaluated_run_id
            || !eq(5, &candidate.canonical.dependency_set_digest)?
            || !text(6)?.is_some_and(|value| canonical_instant(&value))
            || !eq(7, &candidate.canonical.declaration_set_id)?
            || !eq(8, "proposal-revision-source-basis")?
            || row.get::<_, Option<i64>>(9)? != Some(expected_generation)
            || !eq(10, &candidate.canonical.declaration_set_digest)?
            || !eq(11, "sealed")?
            || !eq(12, "proposal-revision-source-basis")?
            || row.get::<_, Option<i64>>(13)? != Some(expected_generation)
            || !eq(14, &proof.project)?
            || !eq(15, "proposal-revision")?
            || !eq(16, &revision)?
            || !eq(17, &candidate.proposal_id)?
            || !eq(18, &candidate.envelope_digest)?
            || !eq(19, &candidate.current_decision_id)?
        {
            return Ok(false);
        }
    }
    if seen.len() != expected.len() {
        return Ok(false);
    }
    let mut observed = HashMap::<String, HashSet<String>>::new();
    let mut statement = conn.prepare("SELECT e.consumer_key,e.source_object_identity,e.read_set_json,e.owning_run_id,
        s.project_id,s.evidence_freshness,s.reason_code,s.build_action,s.evaluated_at_epoch_id,s.evaluated_at
        FROM narrative_dependency_edges e JOIN narrative_proposals p ON p.current_revision_id=e.consumer_key
        JOIN narrative_proposal_sets ps ON ps.id=p.proposal_set_id AND ps.project_id=e.project_id
        LEFT JOIN narrative_dependency_edge_states s ON s.edge_id=e.id
        WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision'")?;
    let mut rows = statement.query([&proof.project])?;
    while let Some(row) = rows.next()? {
        let revision: String = row.get(0)?;
        let Some(candidate) = expected.get(&revision) else {
            continue;
        };
        let source: String = row.get(1)?;
        let Some(basis) = candidate
            .sources
            .iter()
            .find(|basis| basis.source_key == source)
        else {
            return Ok(false);
        };
        if !observed.entry(revision).or_default().insert(source) {
            return Ok(false);
        }
        let text = |column| row.get::<_, Option<String>>(column);
        let eq = |column, value: &str| -> rusqlite::Result<bool> {
            Ok(text(column)?.as_deref() == Some(value))
        };
        if !eq(2, &serde_json::to_string(&[&basis.revision_token])?)?
            || !eq(3, &candidate.owning_run_id)?
            || !eq(4, &proof.project)?
            || !eq(5, "fresh")?
            || text(6)?.is_some()
            || !eq(7, "none")?
            || !eq(8, &proof.semantic_epoch)?
            || !text(9)?.is_some_and(|value| canonical_instant(&value))
        {
            return Ok(false);
        }
    }
    Ok(expected.iter().all(|(revision, candidate)| {
        observed
            .get(*revision)
            .is_some_and(|sources| sources.len() == candidate.canonical.edge_count)
    }))
}
