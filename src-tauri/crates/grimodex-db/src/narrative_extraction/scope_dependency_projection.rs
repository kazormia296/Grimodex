//! Native binding of a versioned Scope dependency to sealed Run documents
//! and the current project authority in a single SQLite snapshot.

use anyhow::{ensure, Context};
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use grimodex_core::narrative_scope_dependency_projection::{
    projection_revision, ScopeDependencyIdentity,
};
use rusqlite::Connection;

use super::project_scope_authority::load_live_project_scope_authority;
use super::scope_authority_runtime::load_sealed_snapshot_document_bindings_in_tx;

pub(crate) fn bind_identity_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    anchor_scene_ref: &str,
    reveal_document_ref: &str,
    secret: bool,
) -> anyhow::Result<ScopeDependencyIdentity> {
    let documents = load_sealed_snapshot_document_bindings_in_tx(conn, project_id, run_id)?;
    let anchors = documents
        .iter()
        .filter(|d| format!("scene:{}", d.node_id) == anchor_scene_ref)
        .collect::<Vec<_>>();
    let reveals = documents
        .iter()
        .filter(|d| d.document_ref == reveal_document_ref)
        .collect::<Vec<_>>();
    ensure!(anchors.len() == 1 && reveals.len() == 1,
        "NEX_SCOPE_DEPENDENCY_BINDING_UNAVAILABLE: anchor and reveal must each identify one sealed Run document");
    Ok(ScopeDependencyIdentity {
        project_id: project_id.into(),
        run_id: run_id.into(),
        anchor_document_ref: anchors[0].document_ref.clone(),
        anchor_scene_ref: anchor_scene_ref.into(),
        reveal_document_ref: reveal_document_ref.into(),
        reveal_scene_ref: format!("scene:{}", reveals[0].node_id),
        secret,
    })
}

pub(crate) fn validate_binding_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    identity: &ScopeDependencyIdentity,
) -> anyhow::Result<()> {
    ensure!(
        identity.project_id == project_id && identity.run_id == run_id,
        "NEX_SOURCE_PROJECT_MISMATCH: Scope dependency project or Run mismatch"
    );
    let sealed = bind_identity_in_tx(
        conn,
        project_id,
        run_id,
        &identity.anchor_scene_ref,
        &identity.reveal_document_ref,
        identity.secret,
    )?;
    ensure!(
        &sealed == identity,
        "NEX_SCOPE_DEPENDENCY_BINDING_UNAVAILABLE: persisted identity differs from sealed Run"
    );
    Ok(())
}

pub(crate) fn resolve_with_authority_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_key: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
) -> anyhow::Result<String> {
    let identity = ScopeDependencyIdentity::from_source_key(source_key)?;
    validate_binding_in_tx(conn, project_id, run_id, &identity)?;
    projection_revision(&identity, authority).map_err(|error| {
        anyhow::anyhow!("NEX_SOURCE_STALE: Scope dependency is unavailable: {error}")
    })
}

pub(crate) fn resolve(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_key: &str,
) -> anyhow::Result<String> {
    // A savepoint also establishes a read snapshot when entered from an
    // autocommit Source reader. No token escapes an incomplete validation.
    conn.execute_batch("SAVEPOINT scope_dependency_snapshot")?;
    let result = (|| {
        let authority = load_live_project_scope_authority(
            conn,
            project_id,
            &format!("project:scope-authority:{project_id}"),
        )?;
        resolve_with_authority_in_tx(conn, project_id, run_id, source_key, &authority)
    })();
    match result {
        Ok(token) => {
            conn.execute_batch("RELEASE scope_dependency_snapshot")?;
            Ok(token)
        }
        Err(error) => {
            conn.execute_batch(
                "ROLLBACK TO scope_dependency_snapshot; RELEASE scope_dependency_snapshot",
            )
            .context("Scope dependency snapshot rollback")?;
            Err(error)
        }
    }
}
