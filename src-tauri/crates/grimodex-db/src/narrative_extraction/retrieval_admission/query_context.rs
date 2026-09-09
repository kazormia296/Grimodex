// Share the exact scene-anchor ADR002 source with the diagnostic adapter.
#[path = "../disclosure_precheck/scene_axis.rs"]
mod scene_axis;

use anyhow::{ensure, Result};
use rusqlite::Connection;

use super::super::project_scope_authority::load_live_project_scope_authority;
use super::{
    read_retrieval_scene_source, QueryIdentityState, RetrievalQueryContext,
    RetrievalQueryContextRead, RetrievalSceneSourceRead, RevisionEligibilityReason,
};

fn unavailable(reason: RevisionEligibilityReason) -> RetrievalQueryContextRead {
    RetrievalQueryContextRead::Unavailable { reason }
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
    Ok(RetrievalQueryContextRead::Available(
        RetrievalQueryContext {
            project_id: project.into(),
            query_scene_id: scene.into(),
            query_scene_ref: target.scene_ref.clone(),
            query_reading_rank: target.reading_rank,
            phase_resolution_mode: source.phase_resolution_mode,
            effective_axis: "reading",
            axis_fallback_reason: axis.fallback_reason,
            audience: QueryIdentityState::Resolved("reader".into()),
            viewpoint: QueryIdentityState::NotApplicable {
                reason: "reader-reference-purpose",
            },
            knowledge_holder: QueryIdentityState::NotApplicable {
                reason: "reader-reference-purpose",
            },
            timeline: QueryIdentityState::Unavailable {
                reason: "query-scene-has-no-timeline-authority",
            },
            worldline: QueryIdentityState::Unavailable {
                reason: "query-scene-has-no-worldline-authority",
            },
            narrative_layer: QueryIdentityState::Unavailable {
                reason: "query-scene-has-no-layer-authority",
            },
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
