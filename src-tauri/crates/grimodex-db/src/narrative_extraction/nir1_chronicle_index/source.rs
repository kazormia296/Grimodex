use anyhow::{ensure, Result};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::super::nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage};

/// A logical Source roster, not an approval, disclosure or Freshness verdict.
/// Unapproved/currently ineligible revisions stay in its digest so a new
/// decision or replacement can invalidate an empty derived index as well.
#[derive(Debug)]
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
    let mut control = super::super::nir1_entity_relation_index::NeverStopGraphWorkControl;
    read_eligibility_source_with_control(conn, project, &mut control)
}

/// Read the Chronicle eligibility roster under the caller's finite lifecycle
/// owner.  Chronicle is a whole-project roster, so a plain `SELECT` is not a
/// sufficient cancellation boundary: the owner must be able to stop row
/// iteration and canonical serialization before the digest is published.
///
/// The controlled and ordinary readers deliberately share the exact SQL,
/// ordering and wire contract.  The control object is borrowed and cannot be
/// retained by the Source value, which prevents a stale lifecycle owner from
/// becoming a Source authority.
pub(crate) fn read_eligibility_source_with_control(
    conn: &Connection,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<EligibilitySource> {
    control.check(GraphWorkStage::Source)?;
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
    let mut cursor = statement.query([project])?;
    let mut rows = Vec::new();
    while let Some(row) = cursor.next()? {
        control.check(GraphWorkStage::Row)?;
        rows.push(
            (0..11)
                .map(|index| row.get::<_, Option<String>>(index))
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    control.check(GraphWorkStage::Serialization)?;
    let bytes = serde_json::to_vec(&json!({
        "contract":"nir1-chronicle-eligibility/1",
        "projectId":project,
        "currentRoster":rows,
    }))?;
    control.check(GraphWorkStage::Digest)?;
    Ok(EligibilitySource {
        digest: format!("sha256:{}", hex::encode(Sha256::digest(bytes))),
        revisions: rows.iter().filter_map(|row| row[1].clone()).collect(),
    })
}
