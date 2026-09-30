//! Cold authoritative reader for the initial reviewed Chronicle profile.
//! Index/runtime authority and async response revalidation remain separate.
pub(in crate::narrative_extraction) mod build;
mod current;
mod disclosure;
mod query_context;
mod scene_source;
mod types;

pub use query_context::read_retrieval_query_context;
pub(in crate::narrative_extraction) use query_context::scene_axis;
pub use scene_source::read_retrieval_scene_source;
#[cfg(feature = "native-current-human-capture")]
pub(in crate::narrative_extraction) use scene_source::read_retrieval_scene_source_bounded;
pub use types::*;

use anyhow::{ensure, Result};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::material_membership::{read_revision_material_membership, MaterialMembershipRead};
use super::revision_eligibility::{freshness, RevisionFreshnessRead};

fn unavailable(reason: RevisionEligibilityReason) -> RevisionEligibilityRead {
    RevisionEligibilityRead::Unavailable { reason }
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// The caller owns one SQLite read transaction. This returns no Index, runtime,
/// renderer or navigation capability. SQL/I/O failures remain errors.
pub fn read_revision_retrieval_eligibility(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
    query_scene_id: &str,
) -> Result<RevisionEligibilityRead> {
    ensure!(
        !conn.is_autocommit(),
        "retrieval admission requires a read transaction"
    );
    ensure!(
        !project_id.trim().is_empty() && !revision_id.trim().is_empty(),
        "nonempty identity required"
    );
    let query = match read_retrieval_query_context(conn, project_id, query_scene_id)? {
        RetrievalQueryContextRead::Available(query) => query,
        RetrievalQueryContextRead::Unavailable { reason } => return Ok(unavailable(reason)),
    };
    let Some(current) = current::read(conn, project_id, revision_id)? else {
        return Ok(unavailable(
            RevisionEligibilityReason::RevisionNotCurrentHumanApproved,
        ));
    };
    let membership = match read_revision_material_membership(conn, project_id, revision_id)? {
        MaterialMembershipRead::Complete(membership) => membership,
        MaterialMembershipRead::Unavailable { .. } => {
            return Ok(unavailable(
                RevisionEligibilityReason::MembershipUnavailable,
            ));
        }
    };
    // Membership validated these exact persisted bytes in the same snapshot.
    let envelope: Value = serde_json::from_str(&current.envelope_json)?;
    let payload: Value = serde_json::from_str(&current.payload_json)?;
    if membership.proposal_id != current.proposal_id
        || membership
            .lineage
            .last()
            .is_none_or(|r| r.envelope_digest != current.envelope_digest)
    {
        return Ok(unavailable(RevisionEligibilityReason::BindingInvalid));
    }
    if let Some(reason) = disclosure::check(&membership, &query, &envelope, &payload)? {
        return Ok(unavailable(reason));
    }
    let material_source_keys = membership
        .materials
        .iter()
        .map(|material| material.source_key.clone())
        .collect::<Vec<_>>();
    let material_scope_cache = match super::scene_scope::preload_material_scene_scopes(
        conn,
        project_id,
        &material_source_keys,
    ) {
        Ok(scopes) => scopes,
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => {
            return Ok(unavailable(
                RevisionEligibilityReason::MaterialAuthorityUnavailable,
            ))
        }
    };
    let material_scopes = match super::scene_scope::select_material_scene_scopes(
        &material_scope_cache,
        &material_source_keys,
    ) {
        Ok(scopes) => scopes,
        Err(_) => {
            return Ok(unavailable(
                RevisionEligibilityReason::MaterialAuthorityUnavailable,
            ));
        }
    };
    if let Some(reason) = super::scene_scope::check_material_constraints(
        &material_scopes,
        &query,
        &query.authority,
        &membership.active_scope_controls,
        &membership.run_id,
    ) {
        return Ok(unavailable(reason));
    }
    // Reuse the one verified membership replay; the cold canonical API also
    // composes this same evaluator, rather than becoming another authority.
    let canonical = match freshness::read(conn, project_id, &membership)? {
        RevisionFreshnessRead::Fresh(snapshot) => snapshot,
        RevisionFreshnessRead::Unavailable { reason } => {
            return Ok(unavailable(RevisionEligibilityReason::CanonicalFreshness(
                reason,
            )));
        }
    };
    let Some(document) = statement(revision_id, &current.envelope_digest, &envelope)? else {
        return Ok(unavailable(RevisionEligibilityReason::BindingInvalid));
    };
    Ok(RevisionEligibilityRead::Eligible(
        RevisionEligibilitySnapshot {
            revision_id: revision_id.into(),
            owning_run_id: membership.run_id,
            proposal_id: current.proposal_id,
            envelope_digest: current.envelope_digest,
            current_decision: RevisionEligibilityDecision {
                id: current.decision_id,
                revision_id: current.decision_revision_id,
                decision: current.decision,
                decision_json: current.decision_json,
                actor_kind: current.actor_kind,
                actor_id: current.actor_id,
                authority_scope: current.authority_scope,
            },
            material_basis_digest: membership.material_basis.material_basis_digest.clone(),
            dependency_ids: membership
                .material_basis
                .dependency_set
                .iter()
                .map(|dependency| dependency.dependency_id.clone())
                .collect(),
            query_context: query,
            canonical_freshness: canonical,
            document,
            evidence: membership.material_basis.evidence_set,
            _verified: (),
        },
    ))
}

fn statement(
    revision: &str,
    envelope_digest: &str,
    envelope: &Value,
) -> Result<Option<ChronicleRetrievalDocument>> {
    // Field order is the approved wire text; canonical JSON sorts these keys
    // and therefore must not be substituted for this ordered serializer.
    #[derive(Serialize)]
    struct Statement<'a> {
        summary: &'a str,
        actuality: &'a str,
        attribution: &'a str,
        #[serde(rename = "narrativeFrame")]
        narrative_frame: &'a str,
    }
    let payload = &envelope["assertion"]["payload"];
    let (Some(summary), Some(actuality), Some(attribution), Some(narrative_frame)) = (
        payload["summary"].as_str(),
        payload["actuality"].as_str(),
        payload["attribution"].as_str(),
        payload["narrativeFrame"].as_str(),
    ) else {
        return Ok(None);
    };
    let serialized = serde_json::to_string(&Statement {
        summary,
        actuality,
        attribution,
        narrative_frame,
    })?;
    Ok(Some(ChronicleRetrievalDocument {
        revision_id: revision.into(),
        envelope_digest: envelope_digest.into(),
        serializer_ref: "chronicle-semantic-retrieval/1",
        serialized_statement_digest: digest(serialized.as_bytes()),
        serialized_statement: serialized,
    }))
}
