//! Ephemeral compare-and-swap of every persisted input read by cold L1/L2.
//! Full row bytes are streamed into a digest once per project; no material or
//! request closure is retained. Index writes and new embedding audit events
//! are deliberately outside this input domain, and have their own validators.
use anyhow::{ensure, Result};
use rusqlite::{types::ValueRef, Connection};
use sha2::{Digest, Sha256};

const QUERIES: &[&str] = &[
    "SELECT s.* FROM narrative_proposal_sets s WHERE s.project_id=?1 ORDER BY s.id",
    "SELECT p.* FROM narrative_proposals p JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id WHERE s.project_id=?1 ORDER BY p.id",
    "SELECT r.* FROM narrative_proposal_revisions r JOIN narrative_proposals p ON p.id=r.proposal_id JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id WHERE s.project_id=?1 ORDER BY r.id",
    "SELECT d.* FROM narrative_proposal_decisions d JOIN narrative_proposals p ON p.id=d.proposal_id JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id WHERE s.project_id=?1 ORDER BY d.id",
    "SELECT b.* FROM narrative_revision_source_basis b JOIN narrative_proposal_revisions r ON r.id=b.revision_id JOIN narrative_proposals p ON p.id=r.proposal_id JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id WHERE s.project_id=?1 ORDER BY b.revision_id,b.source_kind,b.source_key",
    "SELECT r.* FROM narrative_extraction_runs r WHERE r.project_id=?1 ORDER BY r.id",
    "SELECT t.* FROM narrative_extraction_tasks t JOIN narrative_extraction_runs r ON r.id=t.run_id WHERE r.project_id=?1 ORDER BY t.id",
    "SELECT a.* FROM narrative_extraction_attempts a JOIN narrative_extraction_tasks t ON t.id=a.task_id JOIN narrative_extraction_runs r ON r.id=t.run_id WHERE r.project_id=?1 ORDER BY a.id",
    "SELECT a.* FROM narrative_extraction_artifacts a JOIN narrative_extraction_runs r ON r.id=a.run_id WHERE r.project_id=?1 ORDER BY a.id",
    "SELECT r.* FROM narrative_extraction_stage_receipts r WHERE r.project_id=?1 ORDER BY r.id",
    "SELECT b.* FROM narrative_extraction_stage_model_bindings b WHERE b.project_id=?1 ORDER BY b.id",
    "SELECT a.* FROM ai_audit_events a WHERE a.project_id=?1 AND EXISTS(SELECT 1 FROM narrative_extraction_stage_receipts r WHERE r.project_id=?1 AND r.stage_execution_id=a.execution_id) ORDER BY a.scope_id,a.sequence",
    "SELECT h.* FROM narrative_dependency_declaration_heads h WHERE h.project_id=?1 AND h.consumer_kind='proposal-revision' ORDER BY h.consumer_key",
    "SELECT s.* FROM narrative_dependency_declaration_sets s WHERE s.project_id=?1 AND s.consumer_kind='proposal-revision' ORDER BY s.id",
    "SELECT e.* FROM narrative_dependency_declaration_entries e JOIN narrative_dependency_declaration_sets s ON s.id=e.declaration_set_id WHERE s.project_id=?1 AND s.consumer_kind='proposal-revision' ORDER BY e.declaration_set_id,e.source_object_identity",
    "SELECT e.* FROM narrative_dependency_edges e WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' ORDER BY e.id",
    "SELECT s.* FROM narrative_dependency_edge_states s JOIN narrative_dependency_edges e ON e.id=s.edge_id WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' ORDER BY s.edge_id",
    "SELECT f.* FROM narrative_consumer_freshness f WHERE f.project_id=?1 AND f.consumer_kind='proposal-revision' ORDER BY f.consumer_key",
];

pub(super) fn read(conn: &Connection, project: &str) -> Result<String> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 input guard requires a transaction"
    );
    let mut hash = Sha256::new();
    hash.update(b"nir1-cold-input-cas/1");
    for (index, query) in QUERIES.iter().enumerate() {
        hash.update((index as u64).to_le_bytes());
        let mut statement = conn.prepare(query)?;
        let columns = statement.column_count();
        hash.update((columns as u64).to_le_bytes());
        let mut rows = statement.query([project])?;
        while let Some(row) = rows.next()? {
            hash.update(b"row");
            for column in 0..columns {
                match row.get_ref(column)? {
                    ValueRef::Null => hash.update(b"null"),
                    ValueRef::Integer(value) => {
                        hash.update(b"int");
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hash.update(b"real");
                        hash.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(value) => {
                        hash.update(b"text");
                        hash.update((value.len() as u64).to_le_bytes());
                        hash.update(value);
                    }
                    ValueRef::Blob(value) => {
                        hash.update(b"blob");
                        hash.update((value.len() as u64).to_le_bytes());
                        hash.update(value);
                    }
                }
            }
        }
        hash.update(b"end");
    }
    Ok(hex::encode(hash.finalize()))
}
