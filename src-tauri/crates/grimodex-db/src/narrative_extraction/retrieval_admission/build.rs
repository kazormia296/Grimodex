//! Cold build verification. Only compact Source/Scope/Evidence bindings survive
//! the replay; neither request bodies nor the material closure is retained.
use anyhow::{ensure, Result};
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use rusqlite::Connection;
use serde_json::Value;

use super::super::{
    human_material_basis::{MaterialEvidenceEntry, MaterialSourceBasisEntry},
    material_membership::{
        read_revision_material_membership_with_memo, MaterialMembershipRead,
        RevisionMaterialMembership,
    },
    material_membership_root::RunProofMemo,
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
    /// The candidate's active Scope controls, decoded once at build.
    pub active_scope_controls: Vec<super::super::scene_scope::ParsedScopeControl>,
    pub material_scopes: Vec<super::super::scene_scope::MaterialSceneScope>,
    pub material_scope_authority_revision_token: String,
    pub canonical: RevisionFreshnessSnapshot,
    disclosure: disclosure::VerifiedDisclosureMaterial,
    pub evidence_artifacts: Vec<(String, String)>,
}

impl BuildCandidate {
    pub(in crate::narrative_extraction) fn admits(&self, query: &RetrievalQueryContext) -> bool {
        self.admits_with_memo(
            query,
            &mut super::super::scene_scope::ProjectionRevisionMemo::default(),
        )
    }

    /// `admits` for one pass over many candidates of the same `query`; `memo`
    /// belongs to that pass (see `ProjectionRevisionMemo`).
    pub(in crate::narrative_extraction) fn admits_with_memo(
        &self,
        query: &RetrievalQueryContext,
        memo: &mut super::super::scene_scope::ProjectionRevisionMemo,
    ) -> bool {
        if self.disclosure.check_query(query).is_some() {
            return false;
        }
        if query.scope_authority_revision_token != self.material_scope_authority_revision_token {
            return false;
        }
        super::super::scene_scope::check_material_constraints_with_memo(
            &self.material_scopes,
            query,
            &query.authority,
            &self.active_scope_controls,
            &self.owning_run_id,
            memo,
        )
        .is_none()
    }
}

/// The first pass owns exactly one verified membership replay. Scope rows and
/// Freshness are resolved only after every roster entry has passed the
/// candidate-local approval, binding, and disclosure checks.
pub(in crate::narrative_extraction) struct BuildCandidatePreflight {
    pub revision_id: String,
    pub proposal_id: String,
    pub current_decision_id: String,
    pub envelope_digest: String,
    pub envelope: Value,
    /// The replay's `materials`, `replayed_requests` and `verified_receipts`
    /// are released once the preflight has used them (`disclosure` holds what
    /// the later stages need from them), so a Prepare that holds every
    /// candidate's preflight does not hold every Root's replay. The later
    /// stages read only `revision_id`, `run_id`, `material_basis`,
    /// `active_scope_controls` and `verified_artifacts` of this membership.
    pub membership: RevisionMaterialMembership,
    /// `membership.materials[*].source_key`, in the replay's order.
    pub material_source_keys: Vec<String>,
    pub disclosure: disclosure::VerifiedDisclosureMaterial,
}

#[cfg(test)]
pub(in crate::narrative_extraction) fn preflight_build_candidate(
    conn: &Connection,
    project: &str,
    revision: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
) -> Result<std::result::Result<BuildCandidatePreflight, Reason>> {
    preflight_build_candidate_with_memo(
        conn,
        project,
        revision,
        authority,
        &mut RunProofMemo::default(),
    )
}

/// `preflight_build_candidate` that shares Run-level proofs with the other
/// candidates of the same prepare (one read transaction).
pub(in crate::narrative_extraction) fn preflight_build_candidate_with_memo(
    conn: &Connection,
    project: &str,
    revision: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
    memo: &mut RunProofMemo,
) -> Result<std::result::Result<BuildCandidatePreflight, Reason>> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 build verification requires a read transaction"
    );
    // Replay the sealed membership once even when the current row is
    // unapproved. It remains candidate-local data and must not contribute to
    // the global scope union until all preliminary gates below pass.
    let mut membership =
        match read_revision_material_membership_with_memo(conn, project, revision, memo)? {
            MaterialMembershipRead::Complete(value) => value,
            MaterialMembershipRead::Unavailable { .. } => {
                return Ok(Err(Reason::MembershipUnavailable))
            }
        };
    let Some(current) = current::read(conn, project, revision)? else {
        return Ok(Err(Reason::RevisionNotCurrentHumanApproved));
    };
    if membership.proposal_id != current.proposal_id
        || membership
            .lineage
            .last()
            .is_none_or(|r| r.envelope_digest != current.envelope_digest)
    {
        return Ok(Err(Reason::BindingInvalid));
    }
    let envelope: Value = match serde_json::from_str(&current.envelope_json) {
        Ok(value) => value,
        Err(_) => return Ok(Err(Reason::BindingInvalid)),
    };
    let payload: Value = match serde_json::from_str(&current.payload_json) {
        Ok(value) => value,
        Err(_) => return Ok(Err(Reason::BindingInvalid)),
    };
    let disclosure = match disclosure::prepare(&membership, authority, &envelope, &payload)? {
        Ok(value) => value,
        Err(reason) => return Ok(Err(reason)),
    };
    let material_source_keys = membership
        .materials
        .iter()
        .map(|material| material.source_key.clone())
        .collect();
    membership.materials = Vec::new();
    membership.replayed_requests = Vec::new();
    membership.verified_receipts = Vec::new();
    Ok(Ok(BuildCandidatePreflight {
        revision_id: revision.to_owned(),
        proposal_id: current.proposal_id,
        current_decision_id: current.decision_id,
        envelope_digest: current.envelope_digest,
        envelope,
        membership,
        material_source_keys,
        disclosure,
    }))
}

#[cfg(test)]
pub(in crate::narrative_extraction) fn finalize_build_candidate(
    conn: &Connection,
    project: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
    preflight: BuildCandidatePreflight,
    material_scope_cache: &super::super::scene_scope::MaterialSceneScopeCache,
) -> Result<std::result::Result<BuildCandidate, Reason>> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    finalize_build_candidate_with_control(
        conn,
        project,
        authority,
        preflight,
        material_scope_cache,
        &mut control,
        None,
    )
}

pub(in crate::narrative_extraction) fn finalize_build_candidate_with_control(
    conn: &Connection,
    project: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
    preflight: BuildCandidatePreflight,
    material_scope_cache: &super::super::scene_scope::MaterialSceneScopeCache,
    control: &mut dyn super::super::nir1_entity_relation_index::GraphWorkControl,
    reads: Option<&mut super::super::source_revision::CandidateFreshnessReads>,
) -> Result<std::result::Result<BuildCandidate, Reason>> {
    let material_scopes = match super::super::scene_scope::select_material_scene_scopes(
        material_scope_cache,
        &preflight.material_source_keys,
    ) {
        Ok(scopes) => scopes,
        Err(_) => return Ok(Err(Reason::MaterialAuthorityUnavailable)),
    };
    let mut context = super::super::source_revision::validation_context(conn, control);
    // `reads: None` (the single-candidate callers) is the ordinary path; the
    // Prepare's finalize loop shares its Scope-dependency reads (DR-IRB-6).
    let freshness_read = match reads {
        Some(reads) => freshness::read_with_validation_context_and_reads(
            &mut context,
            project,
            &preflight.membership,
            reads,
        )?,
        None => {
            freshness::read_with_validation_context(&mut context, project, &preflight.membership)?
        }
    };
    let canonical = match freshness_read {
        RevisionFreshnessRead::Fresh(value) => value,
        RevisionFreshnessRead::Unavailable { reason } => {
            return Ok(Err(Reason::CanonicalFreshness(reason)))
        }
    };
    let Some(document) = statement(
        &preflight.revision_id,
        &preflight.envelope_digest,
        &preflight.envelope,
    )?
    else {
        return Ok(Err(Reason::BindingInvalid));
    };
    let evidence_artifacts = preflight
        .membership
        .verified_artifacts
        .iter()
        .filter(|artifact| artifact.artifact_kind == "evidence.resolved@1")
        .map(|artifact| (artifact.artifact_id.clone(), artifact.digest.clone()))
        .collect();
    Ok(Ok(BuildCandidate {
        revision_id: preflight.revision_id,
        proposal_id: preflight.proposal_id,
        owning_run_id: preflight.membership.run_id.clone(),
        envelope_digest: preflight.envelope_digest,
        current_decision_id: preflight.current_decision_id,
        document,
        sources: preflight.membership.material_basis.source_basis.clone(),
        evidence: preflight.membership.material_basis.evidence_set.clone(),
        active_scope_controls: super::super::scene_scope::ParsedScopeControl::parse_all(
            &preflight.membership.active_scope_controls,
        ),
        material_scopes,
        material_scope_authority_revision_token: authority.source.revision_token.clone(),
        canonical,
        disclosure: preflight.disclosure,
        evidence_artifacts,
    }))
}
