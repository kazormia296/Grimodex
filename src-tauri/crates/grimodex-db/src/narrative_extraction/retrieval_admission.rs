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
use super::revision_eligibility::{freshness, RevisionFreshnessRead, RevisionFreshnessReason};

fn unavailable(reason: RevisionEligibilityReason) -> RevisionEligibilityRead {
    RevisionEligibilityRead::Unavailable { reason }
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// The caller owns one SQLite read transaction. This returns no Index, runtime,
/// renderer or navigation capability. SQL/I/O failures remain errors.
pub fn read_revision_retrieval_eligibility(
    conn: &mut Connection,
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
        &super::scene_scope::ParsedScopeControl::parse_all(&membership.active_scope_controls),
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

/// The project Scope authority the static reader below composes with, loaded
/// once per caller snapshot. A storage failure is an error; anything else
/// (no Scope authority yet, an invalid tree) is `None`, which the static
/// reader reports as `MaterialAuthorityUnavailable`.
pub(in crate::narrative_extraction) fn read_static_scope_authority(
    conn: &Connection,
    project_id: &str,
) -> Result<
    Option<grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1>,
> {
    ensure!(
        !conn.is_autocommit(),
        "retrieval admission requires a read transaction"
    );
    match super::project_scope_authority::load_live_project_scope_authority(
        conn,
        project_id,
        &format!("project:scope-authority:{project_id}"),
    ) {
        Ok(authority) => Ok(Some(authority)),
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            Err(error)
        }
        Err(_) => Ok(None),
    }
}

/// What the canonical Freshness reader says about a revision's sources.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::narrative_extraction) enum RevisionSourceState {
    Fresh,
    /// A source changed after the revision was read (or an edge is not fresh).
    Stale,
    /// Freshness could not be established (missing row, invalid binding, ...).
    Unknown,
}

fn classify_freshness_reason(reason: RevisionFreshnessReason) -> RevisionSourceState {
    match reason {
        RevisionFreshnessReason::StoredStateNotFresh
        | RevisionFreshnessReason::CurrentSourceNotFresh
        | RevisionFreshnessReason::PendingRelevantChange
        | RevisionFreshnessReason::PendingGlobalChange => RevisionSourceState::Stale,
        _ => RevisionSourceState::Unknown,
    }
}

/// The persisted bytes of one current revision, as the Proposal read already
/// holds them (the static reader does not read them again).
pub(in crate::narrative_extraction) struct StaticEligibilityInput<'a> {
    pub revision_id: &'a str,
    pub proposal_id: &'a str,
    pub envelope_json: &'a str,
    pub envelope_digest: Option<&'a str>,
    pub payload_json: &'a str,
}

/// The reasons that keep a revision out of Related Scenes whatever Scene the
/// author is writing: everything `read_revision_retrieval_eligibility` decides
/// from the revision's own record. It composes the same parts (current Human
/// approval, verified membership, `disclosure::prepare`, the evidence Scenes'
/// Scope rows through `scene_scope::check_material_scope_static`, canonical
/// Freshness, the statement binding) and never reads a query Scene, so the reasons that depend on the Scene being
/// written (`SourceNotBeforeQuery`, the query's axis identities) are not
/// among them. Unlike the query-bound reader it does not stop at the first
/// reason: an unapproved revision still reports its Secret flag and Scope.
pub(in crate::narrative_extraction) struct RevisionStaticEligibility {
    pub reasons: Vec<RevisionEligibilityReason>,
    pub source: RevisionSourceState,
}

pub(in crate::narrative_extraction) fn read_revision_static_eligibility(
    conn: &mut Connection,
    project_id: &str,
    input: &StaticEligibilityInput<'_>,
    authority: Option<
        &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    >,
) -> Result<RevisionStaticEligibility> {
    ensure!(
        !conn.is_autocommit(),
        "retrieval admission requires a read transaction"
    );
    ensure!(
        !project_id.trim().is_empty() && !input.revision_id.trim().is_empty(),
        "nonempty identity required"
    );
    let mut reasons = Vec::new();
    if current::read(conn, project_id, input.revision_id)?.is_none() {
        reasons.push(RevisionEligibilityReason::RevisionNotCurrentHumanApproved);
    }
    let membership = match read_revision_material_membership(conn, project_id, input.revision_id)? {
        MaterialMembershipRead::Complete(membership) => membership,
        MaterialMembershipRead::Unavailable { .. } => {
            reasons.push(RevisionEligibilityReason::MembershipUnavailable);
            return Ok(RevisionStaticEligibility {
                reasons,
                source: RevisionSourceState::Unknown,
            });
        }
    };
    // The Proposal read holds these bytes from the same snapshot, and membership
    // has just verified them; bytes that still do not parse are an unavailable
    // record of this one revision, not a failure of the page.
    let (Ok(envelope), Ok(payload)) = (
        serde_json::from_str::<Value>(input.envelope_json),
        serde_json::from_str::<Value>(input.payload_json),
    ) else {
        reasons.push(RevisionEligibilityReason::MembershipUnavailable);
        return Ok(RevisionStaticEligibility {
            reasons,
            source: RevisionSourceState::Unknown,
        });
    };
    if membership.proposal_id != input.proposal_id
        || membership
            .lineage
            .last()
            .is_none_or(|r| Some(r.envelope_digest.as_str()) != input.envelope_digest)
    {
        reasons.push(RevisionEligibilityReason::BindingInvalid);
        return Ok(RevisionStaticEligibility {
            reasons,
            source: RevisionSourceState::Unknown,
        });
    }
    match authority {
        None => push_reason(
            &mut reasons,
            RevisionEligibilityReason::MaterialAuthorityUnavailable,
        ),
        Some(authority) => {
            if let Err(reason) = disclosure::prepare(&membership, authority, &envelope, &payload)? {
                push_reason(&mut reasons, reason);
            }
            // The Scope rows of the evidence Scenes, exactly as the query-bound
            // reader reads them; only the part that needs the query Scene is left
            // out (see `check_material_scope_static`).
            if let Some(reason) = static_material_scope(conn, project_id, &membership, authority)? {
                push_reason(&mut reasons, reason);
            }
        }
    }
    let source = match freshness::read(conn, project_id, &membership) {
        Ok(RevisionFreshnessRead::Fresh(_)) => RevisionSourceState::Fresh,
        Ok(RevisionFreshnessRead::Unavailable { reason }) => {
            reasons.push(RevisionEligibilityReason::CanonicalFreshness(reason));
            classify_freshness_reason(reason)
        }
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        // A caller-owned stop or a context this reader cannot supply: the
        // sources could not be checked, which is not an answer.
        Err(_) => {
            reasons.push(RevisionEligibilityReason::CanonicalFreshness(
                RevisionFreshnessReason::CurrentSourceUnavailable,
            ));
            RevisionSourceState::Unknown
        }
    };
    if statement(
        input.revision_id,
        input.envelope_digest.unwrap_or_default(),
        &envelope,
    )?
    .is_none()
    {
        push_reason(&mut reasons, RevisionEligibilityReason::BindingInvalid);
    }
    Ok(RevisionStaticEligibility { reasons, source })
}

fn push_reason(reasons: &mut Vec<RevisionEligibilityReason>, reason: RevisionEligibilityReason) {
    if !reasons.contains(&reason) {
        reasons.push(reason);
    }
}

/// The Scope-row decisions of `read_revision_retrieval_eligibility` that do not
/// depend on the Scene being written: the same preload and selection of the
/// evidence Scenes' Scope rows, then `check_material_scope_static`. A storage
/// failure is an error; a missing or unreadable row is
/// `MaterialAuthorityUnavailable`, as in the query-bound reader.
fn static_material_scope(
    conn: &Connection,
    project_id: &str,
    membership: &super::material_membership::RevisionMaterialMembership,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
) -> Result<Option<RevisionEligibilityReason>> {
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
            return Ok(Some(
                RevisionEligibilityReason::MaterialAuthorityUnavailable,
            ))
        }
    };
    let Ok(material_scopes) = super::scene_scope::select_material_scene_scopes(
        &material_scope_cache,
        &material_source_keys,
    ) else {
        return Ok(Some(
            RevisionEligibilityReason::MaterialAuthorityUnavailable,
        ));
    };
    Ok(super::scene_scope::check_material_scope_static(
        &material_scopes,
        project_id,
        authority,
        &super::scene_scope::ParsedScopeControl::parse_all(&membership.active_scope_controls),
        &membership.run_id,
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
