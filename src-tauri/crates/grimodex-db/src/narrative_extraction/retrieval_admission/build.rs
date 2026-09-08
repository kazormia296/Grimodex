//! Cold build verification. Only compact Source/Scope/Evidence bindings survive
//! the replay; neither request bodies nor the material closure is retained.
use anyhow::{ensure, Result};
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use rusqlite::Connection;
use serde_json::Value;

use super::super::{
    human_material_basis::{MaterialEvidenceEntry, MaterialSourceBasisEntry},
    material_membership::{read_revision_material_membership, MaterialMembershipRead},
    revision_eligibility::{freshness, RevisionFreshnessRead, RevisionFreshnessSnapshot},
};
use super::{
    current, disclosure, statement, ChronicleRetrievalDocument, RetrievalQueryContext,
    RevisionEligibilityReason as Reason,
};

#[derive(Debug)]
pub(in crate::narrative_extraction) struct BuildCandidate {
    pub revision_id: String,
    pub proposal_id: String,
    pub owning_run_id: String,
    pub envelope_digest: String,
    pub current_decision_id: String,
    pub document: ChronicleRetrievalDocument,
    pub sources: Vec<MaterialSourceBasisEntry>,
    pub evidence: Vec<MaterialEvidenceEntry>,
    pub canonical: RevisionFreshnessSnapshot,
    disclosure: disclosure::VerifiedDisclosureMaterial,
    pub evidence_artifacts: Vec<(String, String)>,
}

impl BuildCandidate {
    pub(in crate::narrative_extraction) fn admits(&self, query: &RetrievalQueryContext) -> bool {
        self.disclosure.check_query(query).is_none()
    }
}

pub(in crate::narrative_extraction) fn read_build_candidate(
    conn: &Connection,
    project: &str,
    revision: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
) -> Result<std::result::Result<BuildCandidate, Reason>> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 build verification requires a read transaction"
    );
    let Some(current) = current::read(conn, project, revision)? else {
        return Ok(Err(Reason::RevisionNotCurrentHumanApproved));
    };
    let membership = match read_revision_material_membership(conn, project, revision)? {
        MaterialMembershipRead::Complete(value) => value,
        MaterialMembershipRead::Unavailable { .. } => {
            return Ok(Err(Reason::MembershipUnavailable))
        }
    };
    if membership.proposal_id != current.proposal_id
        || membership
            .lineage
            .last()
            .is_none_or(|r| r.envelope_digest != current.envelope_digest)
    {
        return Ok(Err(Reason::BindingInvalid));
    }
    let envelope: Value = serde_json::from_str(&current.envelope_json)?;
    let payload: Value = serde_json::from_str(&current.payload_json)?;
    let disclosure = match disclosure::prepare(&membership, authority, &envelope, &payload)? {
        Ok(value) => value,
        Err(reason) => return Ok(Err(reason)),
    };
    let canonical = match freshness::read(conn, project, &membership)? {
        RevisionFreshnessRead::Fresh(value) => value,
        RevisionFreshnessRead::Unavailable { reason } => {
            return Ok(Err(Reason::CanonicalFreshness(reason)))
        }
    };
    let Some(document) = statement(revision, &current.envelope_digest, &envelope)? else {
        return Ok(Err(Reason::BindingInvalid));
    };
    let evidence_artifacts = membership
        .verified_artifacts
        .iter()
        .filter(|artifact| artifact.artifact_kind == "evidence.resolved@1")
        .map(|artifact| (artifact.artifact_id.clone(), artifact.digest.clone()))
        .collect();
    Ok(Ok(BuildCandidate {
        revision_id: revision.into(),
        proposal_id: current.proposal_id,
        owning_run_id: membership.run_id,
        envelope_digest: current.envelope_digest,
        current_decision_id: current.decision_id,
        document,
        sources: membership.material_basis.source_basis,
        evidence: membership.material_basis.evidence_set,
        canonical,
        disclosure,
        evidence_artifacts,
    }))
}
