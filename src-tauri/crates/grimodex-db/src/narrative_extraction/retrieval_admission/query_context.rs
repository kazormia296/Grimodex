// Share the exact scene-anchor ADR002 source with the diagnostic adapter.
#[cfg_attr(feature = "nir1-material-diagnostics", allow(clippy::duplicate_mod))]
#[path = "../disclosure_precheck/scene_axis.rs"]
pub(in crate::narrative_extraction) mod scene_axis;

use anyhow::{ensure, Result};
use rusqlite::Connection;

use super::super::project_scope_authority::load_live_project_scope_authority;
use super::{
    read_retrieval_scene_source, QueryIdentityState, RetrievalQueryContext,
    RetrievalQueryContextRead, RetrievalSceneSourceRead, RevisionEligibilityReason,
};
use grimodex_core::narrative_scene_scope::{
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
};

fn unavailable(reason: RevisionEligibilityReason) -> RetrievalQueryContextRead {
    RetrievalQueryContextRead::Unavailable { reason }
}

fn query_identity_state(constraint: &NarrativeScopeConstraintV1) -> QueryIdentityState {
    match constraint {
        NarrativeScopeConstraintV1::Exact { reference } => {
            QueryIdentityState::Resolved(reference.clone())
        }
        NarrativeScopeConstraintV1::Unresolved { .. } => QueryIdentityState::Unavailable {
            reason: "scene-scope-axis-unresolved",
        },
        NarrativeScopeConstraintV1::Any => QueryIdentityState::Unavailable {
            reason: "scene-scope-query-any-forbidden",
        },
    }
}

fn principal_state(principal: &NarrativeScopePrincipalV1) -> QueryIdentityState {
    match principal {
        NarrativeScopePrincipalV1::Reader {} => QueryIdentityState::Resolved("reader".into()),
        NarrativeScopePrincipalV1::Character { reference } => {
            QueryIdentityState::Resolved(format!("character:{reference}"))
        }
    }
}

pub fn read_retrieval_query_context(
    conn: &Connection,
    project: &str,
    scene: &str,
) -> Result<RetrievalQueryContextRead> {
    ensure!(
        !conn.is_autocommit(),
        "query context requires a read transaction"
    );
    if project.trim().is_empty() || scene.trim().is_empty() {
        return Ok(unavailable(
            RevisionEligibilityReason::QueryContextUnavailable,
        ));
    }
    let source = match read_retrieval_scene_source(conn, project, scene)? {
        RetrievalSceneSourceRead::Available(source) => source,
        RetrievalSceneSourceRead::Unavailable { reason } => return Ok(unavailable(reason)),
    };
    if source.archived {
        return Ok(unavailable(
            RevisionEligibilityReason::QueryContextUnavailable,
        ));
    }
    let authority = match load_live_project_scope_authority(
        conn,
        project,
        &format!("project:scope-authority:{project}"),
    ) {
        Ok(authority) => authority,
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => {
            return Ok(unavailable(
                RevisionEligibilityReason::QueryContextUnavailable,
            ))
        }
    };
    let axis = match scene_axis::resolve(&authority, &source.phase_resolution_mode, scene) {
        Ok(axis) => axis,
        Err(_) => {
            return Ok(unavailable(
                RevisionEligibilityReason::QueryContextUnavailable,
            ))
        }
    };
    if axis.axis_used.as_deref() != Some("reading") {
        return Ok(unavailable(RevisionEligibilityReason::UnsupportedQueryAxis));
    }
    let Some(target) = authority
        .mappings
        .iter()
        .find(|m| m.scene_ref == format!("scene:{scene}"))
    else {
        return Ok(unavailable(
            RevisionEligibilityReason::QueryContextUnavailable,
        ));
    };
    let scope = match super::super::scene_scope::read_narrative_scene_scope(conn, project, scene) {
        Ok(scope) => scope.binding,
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => {
            return Ok(unavailable(
                RevisionEligibilityReason::QueryContextUnavailable,
            ))
        }
    };
    let scope_is_unavailable = match scope.compatibility_marker {
        NarrativeScopeCompatibilityMarkerV1::Unknown => true,
        NarrativeScopeCompatibilityMarkerV1::Explicit => [
            &scope.query_identity.timeline,
            &scope.query_identity.worldline,
            &scope.query_identity.narrative_layer,
        ]
        .into_iter()
        .any(|axis| matches!(axis, NarrativeScopeConstraintV1::Unresolved { .. })),
        NarrativeScopeCompatibilityMarkerV1::LegacyAbsent => false,
    };
    if scope_is_unavailable {
        return Ok(unavailable(RevisionEligibilityReason::ScopeUnsupported));
    }
    let (audience, knowledge_holder, timeline, worldline, narrative_layer) =
        match scope.compatibility_marker {
            NarrativeScopeCompatibilityMarkerV1::LegacyAbsent => (
                QueryIdentityState::Resolved("reader".into()),
                QueryIdentityState::NotApplicable {
                    reason: "reader-reference-purpose",
                },
                QueryIdentityState::Unavailable {
                    reason: "query-scene-has-no-timeline-authority",
                },
                QueryIdentityState::Unavailable {
                    reason: "query-scene-has-no-worldline-authority",
                },
                QueryIdentityState::Unavailable {
                    reason: "query-scene-has-no-layer-authority",
                },
            ),
            NarrativeScopeCompatibilityMarkerV1::Explicit => (
                principal_state(&scope.audience),
                principal_state(&scope.knowledge_holder),
                query_identity_state(&scope.query_identity.timeline),
                query_identity_state(&scope.query_identity.worldline),
                query_identity_state(&scope.query_identity.narrative_layer),
            ),
            NarrativeScopeCompatibilityMarkerV1::Unknown => (
                QueryIdentityState::Unavailable {
                    reason: "scene-scope-unknown",
                },
                QueryIdentityState::Unavailable {
                    reason: "scene-scope-unknown",
                },
                QueryIdentityState::Unavailable {
                    reason: "scene-scope-unknown",
                },
                QueryIdentityState::Unavailable {
                    reason: "scene-scope-unknown",
                },
                QueryIdentityState::Unavailable {
                    reason: "scene-scope-unknown",
                },
            ),
        };
    Ok(RetrievalQueryContextRead::Available(
        RetrievalQueryContext {
            project_id: project.into(),
            query_scene_id: scene.into(),
            query_scene_ref: target.scene_ref.clone(),
            query_reading_rank: target.reading_rank,
            phase_resolution_mode: source.phase_resolution_mode,
            effective_axis: "reading",
            axis_fallback_reason: axis.fallback_reason,
            audience,
            viewpoint: QueryIdentityState::NotApplicable {
                reason: "reader-reference-purpose",
            },
            knowledge_holder,
            timeline,
            worldline,
            narrative_layer,
            reading_order: QueryIdentityState::Resolved(target.reading_order_ref.clone()),
            story_time: QueryIdentityState::Unavailable {
                reason: "initial-reading-profile",
            },
            allow_secrets: false,
            scope_authority_source_key: authority.source.source_key.clone(),
            scope_authority_revision_token: authority.source.revision_token.clone(),
            query_source: source.query_source,
            saved_content_json: source.saved_content_json,
            canonical_source_text: source.canonical_source_text,
            authority,
            _verified: (),
        },
    ))
}
