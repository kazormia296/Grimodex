use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::change_feed::{scene_canonical_text, CANONICAL_TEXT_NORMALIZER_VERSION};
use super::{
    digest, RetrievalSceneSource, RetrievalSceneSourceBinding, RetrievalSceneSourceRead,
    RevisionEligibilityReason,
};

pub fn read_retrieval_scene_source(
    conn: &Connection,
    project: &str,
    scene: &str,
) -> Result<RetrievalSceneSourceRead> {
    ensure!(
        !conn.is_autocommit(),
        "Scene query source requires a read transaction"
    );
    let unavailable = || RetrievalSceneSourceRead::Unavailable {
        reason: RevisionEligibilityReason::QueryContextUnavailable,
    };
    if project.trim().is_empty() || scene.trim().is_empty() {
        return Ok(unavailable());
    }
    let row = conn.query_row(
        "SELECT p.phase_resolution_mode,t.version,t.updated_at,t.content,t.archived_at FROM projects p
         JOIN tree_nodes t ON t.project_id=p.id WHERE p.id=?1 AND t.id=?2
         AND t.node_type='scene'",
        params![project, scene], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,
            r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?)),
    ).optional()?;
    let Some((mode, version, updated_at, content, archived_at)) = row else {
        return Ok(unavailable());
    };
    if version < 0 || updated_at.trim().is_empty() {
        return Ok(unavailable());
    }
    let canonical = scene_canonical_text(&content);
    Ok(RetrievalSceneSourceRead::Available(RetrievalSceneSource {
        project_id: project.into(),
        scene_id: scene.into(),
        phase_resolution_mode: mode,
        archived: archived_at.is_some(),
        query_source: RetrievalSceneSourceBinding {
            source_key: format!("project:scene:{scene}"),
            revision_token: format!("v{version}@{updated_at}"),
            source_version: version,
            normalizer_version: CANONICAL_TEXT_NORMALIZER_VERSION,
            canonical_text_digest: digest(canonical.as_bytes()),
            storage_digest: digest(content.as_bytes()),
            canonical_utf16_length: canonical.encode_utf16().count(),
        },
        saved_content_json: content,
        canonical_source_text: canonical,
        _verified: (),
    }))
}
