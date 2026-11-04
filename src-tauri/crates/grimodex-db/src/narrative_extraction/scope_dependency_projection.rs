//! Native binding of a versioned Scope dependency to sealed Run documents
//! and the current project authority in a single SQLite snapshot.

use anyhow::{ensure, Context};
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use grimodex_core::narrative_scope_dependency_projection::{
    projection_revision, ScopeDependencyIdentity,
};
use rusqlite::Connection;
use std::collections::HashMap;

use super::project_scope_authority::load_live_project_scope_authority;
use super::scope_authority_runtime::{
    load_sealed_snapshot_document_bindings_in_tx, SealedSnapshotDocumentBinding,
};

/// Sealed Run document bindings read once per (project, Run) inside one
/// bounded, read-only edge batch (DR-CP4-V-5 (a)). It lives exactly as long as
/// the batch's Scope read: the caller creates it empty for the batch and drops
/// it with the batch, so it never crosses a transaction, a write, a proof or
/// another batch. Only successful reads are kept; a failing Run is read again
/// for every edge, so errors and their order stay unchanged. Every edge still
/// filters its own anchor/reveal and compares its persisted identity.
#[derive(Default)]
pub(crate) struct SealedDocumentsMemo {
    by_run: HashMap<(String, String), Vec<SealedSnapshotDocumentBinding>>,
}

impl SealedDocumentsMemo {
    pub(crate) fn documents_in_tx(
        &mut self,
        conn: &Connection,
        project_id: &str,
        run_id: &str,
    ) -> anyhow::Result<&[SealedSnapshotDocumentBinding]> {
        let key = (project_id.to_owned(), run_id.to_owned());
        if !self.by_run.contains_key(&key) {
            let documents = load_sealed_snapshot_document_bindings_in_tx(conn, project_id, run_id)?;
            self.by_run.insert(key.clone(), documents);
        }
        self.by_run
            .get(&key)
            .map(Vec::as_slice)
            .ok_or_else(|| anyhow::anyhow!("sealed Run document memo unavailable"))
    }
}

pub(crate) fn bind_identity_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    anchor_scene_ref: &str,
    reveal_document_ref: &str,
    secret: bool,
) -> anyhow::Result<ScopeDependencyIdentity> {
    let documents = load_sealed_snapshot_document_bindings_in_tx(conn, project_id, run_id)?;
    bind_identity_from_documents(
        &documents,
        project_id,
        run_id,
        anchor_scene_ref,
        reveal_document_ref,
        secret,
    )
}

fn bind_identity_from_documents(
    documents: &[SealedSnapshotDocumentBinding],
    project_id: &str,
    run_id: &str,
    anchor_scene_ref: &str,
    reveal_document_ref: &str,
    secret: bool,
) -> anyhow::Result<ScopeDependencyIdentity> {
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
    validate_binding_with_memo_in_tx(
        conn,
        project_id,
        run_id,
        identity,
        &mut SealedDocumentsMemo::default(),
    )
}

fn validate_binding_with_memo_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    identity: &ScopeDependencyIdentity,
    sealed_documents: &mut SealedDocumentsMemo,
) -> anyhow::Result<()> {
    ensure!(
        identity.project_id == project_id && identity.run_id == run_id,
        "NEX_SOURCE_PROJECT_MISMATCH: Scope dependency project or Run mismatch"
    );
    let sealed = bind_identity_from_documents(
        sealed_documents.documents_in_tx(conn, project_id, run_id)?,
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
    resolve_with_authority_and_memo_in_tx(
        conn,
        project_id,
        run_id,
        source_key,
        authority,
        &mut SealedDocumentsMemo::default(),
    )
}

/// [`resolve_with_authority_in_tx`] for the bounded edge batch, sharing the
/// batch's [`SealedDocumentsMemo`] (DR-CP4-V-5 (a)).
pub(crate) fn resolve_with_authority_and_memo_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_key: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
    sealed_documents: &mut SealedDocumentsMemo,
) -> anyhow::Result<String> {
    let identity = ScopeDependencyIdentity::from_source_key(source_key)?;
    validate_binding_with_memo_in_tx(conn, project_id, run_id, &identity, sealed_documents)?;
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
