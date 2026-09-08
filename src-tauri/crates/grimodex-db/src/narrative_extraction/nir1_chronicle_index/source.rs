use anyhow::{ensure, Result};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};

/// A logical Source roster, not an approval, disclosure or Freshness verdict.
/// Unapproved/currently ineligible revisions stay in its digest so a new
/// decision or replacement can invalidate an empty derived index as well.
pub(crate) struct EligibilitySource {
    pub digest: String,
    pub revisions: Vec<String>,
}

pub(crate) fn source_key(project: &str) -> String {
    format!("project:nir1-chronicle-eligibility:{project}")
}

pub(crate) fn read_eligibility_source(
    conn: &Connection,
    project: &str,
) -> Result<EligibilitySource> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 Source requires a read transaction"
    );
    ensure!(
        !project.is_empty() && project.trim() == project,
        "NEX_SOURCE_KEY_INVALID: nonempty exact project identity required"
    );
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        [project],
        |row| row.get(0),
    )?;
    ensure!(
        exists,
        "NEX_SOURCE_MISSING: eligibility project does not exist"
    );
    let mut statement = conn.prepare(
        "SELECT p.id,p.current_revision_id,p.status,r.reconciliation_envelope_digest,
                s.run_id,d.id,d.revision_id,d.decision,d.actor_kind,d.actor_id,d.authority_scope
         FROM narrative_proposals p JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
         LEFT JOIN narrative_proposal_revisions r ON r.id=p.current_revision_id AND r.proposal_id=p.id
         LEFT JOIN narrative_proposal_decisions d ON d.id=(
           SELECT latest.id FROM narrative_proposal_decisions latest WHERE latest.proposal_id=p.id
           ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
         WHERE s.project_id=?1 ORDER BY p.id",
    )?;
    let rows = statement
        .query_map([project], |row| {
            (0..11)
                .map(|index| row.get::<_, Option<String>>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let bytes = serde_json::to_vec(&json!({
        "contract":"nir1-chronicle-eligibility/1",
        "projectId":project,
        "currentRoster":rows,
    }))?;
    Ok(EligibilitySource {
        digest: format!("sha256:{}", hex::encode(Sha256::digest(bytes))),
        revisions: rows.iter().filter_map(|row| row[1].clone()).collect(),
    })
}
