//! Typed historical Scope-authority artifact persistence and loading.
//!
//! The producer is owned by the typed task-finish path. It re-derives the
//! submitted basis from the durable Run and the project tree while the
//! caller's `BEGIN IMMEDIATE` transaction is open. The reader validates only
//! the sealed historical artifact and its durable owner bindings; it never
//! consults the mutable project tree.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use grimodex_core::narrative_scope_authority_basis::{
    build_narrative_scope_authority_basis_v2, NarrativeScopeAuthorityBasisV2,
    NarrativeScopeAuthorityDocumentInputV2,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::models::ArtifactInput;
use crate::Database;

pub const HISTORICAL_SCOPE_AUTHORITY_ARTIFACT_KIND: &str = "source.snapshot@2";

const HISTORICAL_SCOPE_AUTHORITY_TASK_KIND: &str = "source.snapshot@1";
const HISTORICAL_SCOPE_AUTHORITY_CORPUS_ARTIFACT_KIND: &str = "source.snapshot@1";
const HISTORICAL_SCOPE_AUTHORITY_SURFACE_PATH: &str = "chronicle.extract";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoricalRunScope {
    folder_id: String,
    scene_ids: Vec<String>,
}

#[derive(Debug)]
struct PersistedTreeNode {
    id: String,
    parent_id: Option<String>,
    node_type: String,
    sort_order: String,
    story_time_order: Option<String>,
}

#[derive(Debug)]
struct StoredHistoricalArtifact {
    task_id: Option<String>,
    attempt_id: Option<String>,
    payload_storage: String,
    payload_json: Option<String>,
    payload_ref: Option<String>,
    payload_digest: Option<String>,
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn invalid_durable_scope(reason: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_INVALID: {reason}")
}

fn validate_basis_scope_binding(
    basis: &NarrativeScopeAuthorityBasisV2,
    scope: &HistoricalRunScope,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        basis.mappings.len() == scope.scene_ids.len(),
        "NEX_SCOPE_AUTHORITY_SCOPE_MISMATCH: artifact mapping count differs from Run scope"
    );
    for (index, (mapping, scene_id)) in basis
        .mappings
        .iter()
        .zip(scope.scene_ids.iter())
        .enumerate()
    {
        anyhow::ensure!(
            mapping.document_ref == format!("D{:06}", index + 1)
                && mapping.source_key == format!("project:scene:{scene_id}"),
            "NEX_SCOPE_AUTHORITY_SCOPE_MISMATCH: artifact mapping order differs from Run scope"
        );
    }
    Ok(())
}

fn require_unique_completed_snapshot_task(
    conn: &Connection,
    run_id: &str,
    expected_task_id: &str,
    expected_attempt_id: &str,
) -> anyhow::Result<()> {
    let (task_count, owner_count): (i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN id = ?2 THEN 1 ELSE 0 END), 0)
           FROM narrative_extraction_tasks
          WHERE run_id = ?1 AND task_kind = ?3",
        params![
            run_id,
            expected_task_id,
            HISTORICAL_SCOPE_AUTHORITY_TASK_KIND
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    anyhow::ensure!(
        task_count == 1 && owner_count == 1,
        "NEX_SCOPE_AUTHORITY_TASK_INVALID: Run must own exactly one source.snapshot@1 task and it must own the artifact"
    );
    let (task_status, task_attempt_count): (String, i64) = conn.query_row(
        "SELECT status, attempt_count
           FROM narrative_extraction_tasks
          WHERE id = ?1 AND run_id = ?2",
        params![expected_task_id, run_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    anyhow::ensure!(
        task_status == "completed",
        "NEX_SCOPE_AUTHORITY_TASK_INVALID: snapshot task must be completed"
    );
    let (completed_attempt_count, owner_attempt_count, owner_attempt_number): (
        i64,
        i64,
        Option<i64>,
    ) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN id = ?2 THEN 1 ELSE 0 END), 0),
                MAX(CASE WHEN id = ?2 THEN attempt_number ELSE NULL END)
           FROM narrative_extraction_attempts
          WHERE task_id = ?1 AND status = 'completed'",
        params![expected_task_id, expected_attempt_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    anyhow::ensure!(
        completed_attempt_count == 1
            && owner_attempt_count == 1
            && owner_attempt_number == Some(task_attempt_count),
        "NEX_SCOPE_AUTHORITY_ATTEMPT_INVALID: snapshot task must own exactly one completed latest attempt and it must own the artifact"
    );
    Ok(())
}

fn derive_ordered_scene_ids(
    nodes: &[PersistedTreeNode],
    folder_id: &str,
) -> anyhow::Result<Vec<String>> {
    let nodes_by_id = nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let requested_folder = nodes_by_id
        .get(folder_id)
        .copied()
        .ok_or_else(|| invalid_durable_scope("requested folder is unavailable"))?;
    anyhow::ensure!(
        requested_folder.node_type == "folder",
        "NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_INVALID: requested node is not a folder"
    );

    // A requested subtree is valid only when its complete ancestor chain is
    // present and folder-only. This also catches cycles above the requested
    // folder before the DFS begins.
    let mut ancestor_ids = HashSet::new();
    let mut ancestor = requested_folder;
    loop {
        anyhow::ensure!(
            ancestor_ids.insert(ancestor.id.as_str()),
            "NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_INVALID: cyclic ancestor chain"
        );
        let Some(parent_id) = ancestor.parent_id.as_deref() else {
            break;
        };
        ancestor = nodes_by_id
            .get(parent_id)
            .copied()
            .ok_or_else(|| invalid_durable_scope("ancestor folder is unavailable"))?;
        anyhow::ensure!(
            ancestor.node_type == "folder",
            "NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_INVALID: ancestor is not a folder"
        );
    }

    let mut children_by_parent = HashMap::<&str, Vec<&PersistedTreeNode>>::new();
    for node in nodes {
        if let Some(parent_id) = node.parent_id.as_deref() {
            children_by_parent.entry(parent_id).or_default().push(node);
        }
    }
    for children in children_by_parent.values_mut() {
        children.sort_by(|left, right| compare_utf16(&left.sort_order, &right.sort_order));
    }

    enum Traversal<'a> {
        Enter(&'a str),
        Exit(&'a str),
        Scene(&'a str),
    }
    let mut ordered_scene_ids = Vec::new();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut traversal = vec![Traversal::Enter(requested_folder.id.as_str())];
    while let Some(frame) = traversal.pop() {
        match frame {
            Traversal::Scene(scene_id) => ordered_scene_ids.push(scene_id.to_owned()),
            Traversal::Exit(folder_id) => {
                visiting.remove(folder_id);
                visited.insert(folder_id);
            }
            Traversal::Enter(folder_id) => {
                anyhow::ensure!(
                    !visiting.contains(folder_id),
                    "NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_INVALID: cyclic subtree"
                );
                if visited.contains(folder_id) {
                    continue;
                }
                visiting.insert(folder_id);

                let children = children_by_parent
                    .get(folder_id)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                for pair in children.windows(2) {
                    anyhow::ensure!(
                        compare_utf16(&pair[0].sort_order, &pair[1].sort_order) != Ordering::Equal,
                        "NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_INVALID: duplicate sibling sort order"
                    );
                }

                traversal.push(Traversal::Exit(folder_id));
                for child in children.iter().rev() {
                    if child.node_type != "folder" {
                        anyhow::ensure!(
                            children_by_parent
                                .get(child.id.as_str())
                                .is_none_or(Vec::is_empty),
                            "NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_INVALID: non-folder node owns descendants"
                        );
                    }
                    match child.node_type.as_str() {
                        "scene" => traversal.push(Traversal::Scene(child.id.as_str())),
                        "folder" => traversal.push(Traversal::Enter(child.id.as_str())),
                        "note" => {}
                        _ => {
                            return Err(invalid_durable_scope(format!(
                                "unsupported node type '{}'",
                                child.node_type
                            )))
                        }
                    }
                }
            }
        }
    }
    Ok(ordered_scene_ids)
}

fn invalid_corpus_artifact(reason: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {reason}")
}

/// The sealed historical basis must stay durably linked to the snapshot
/// corpus it digests. The typed snapshot finish therefore carries exactly one
/// `source.snapshot@1` corpus artifact whose snapshot digest matches the
/// durable Run authority (and thus the basis `corpusDigest`), whose supplied
/// payload digest matches the Native canonical recomputation, and whose
/// ordered document closure matches the basis mappings — all in the same
/// transaction. Without this link, a restart leaves only a `corpusDigest`
/// that Native can never re-verify against actual bytes.
fn validate_snapshot_corpus_closure(
    finish_artifacts: &[ArtifactInput],
    basis: &NarrativeScopeAuthorityBasisV2,
    run_snapshot_digest: &str,
) -> anyhow::Result<()> {
    let mut corpora = finish_artifacts.iter().filter(|artifact| {
        artifact.artifact_kind == HISTORICAL_SCOPE_AUTHORITY_CORPUS_ARTIFACT_KIND
    });
    let corpus = corpora.next().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_REQUIRED: typed historical basis requires exactly one source.snapshot@1 corpus artifact in the same finish"
        )
    })?;
    anyhow::ensure!(
        corpora.next().is_none(),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_REQUIRED: typed historical basis requires exactly one source.snapshot@1 corpus artifact in the same finish"
    );
    anyhow::ensure!(
        corpus.payload_storage.as_deref().unwrap_or("inline-json") == "inline-json"
            && corpus.payload_ref.is_none(),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus artifact must be inline-json"
    );
    let payload = corpus
        .payload_json
        .as_ref()
        .ok_or_else(|| invalid_corpus_artifact("corpus payload is missing"))?;
    let canonical_digest = grimodex_core::canonical_json_digest(payload)?;
    // The payload digest is mandatory: an omitted digest would leave the
    // corpus artifact without the durable identity the readback CAS needs.
    let claimed = corpus.payload_digest.as_deref().ok_or_else(|| {
        invalid_corpus_artifact("corpus payloadDigest is required for the durable closure")
    })?;
    anyhow::ensure!(
        claimed == canonical_digest,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus payload digest differs from the Native canonical recomputation"
    );
    let snapshot = payload
        .get("snapshot")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_corpus_artifact("corpus payload has no snapshot"))?;
    let snapshot_digest = snapshot
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_corpus_artifact("corpus snapshot digest is missing"))?;
    anyhow::ensure!(
        snapshot_digest == run_snapshot_digest,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus snapshot digest differs from Run snapshotDigest"
    );
    anyhow::ensure!(
        basis.digests.corpus_digest == run_snapshot_digest,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: basis corpusDigest differs from Run snapshotDigest"
    );
    let documents = snapshot
        .get("documents")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_corpus_artifact("corpus snapshot documents are missing"))?;
    anyhow::ensure!(
        documents.len() == basis.mappings.len(),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus document closure differs from the basis mappings"
    );
    for (document, mapping) in documents.iter().zip(basis.mappings.iter()) {
        let document_ref = document.get("ref").and_then(Value::as_str);
        let source_key = document.get("sourceKey").and_then(Value::as_str);
        anyhow::ensure!(
            document_ref == Some(mapping.document_ref.as_str())
                && source_key == Some(mapping.source_key.as_str()),
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus document order/ref/sourceKey differs from the basis mappings"
        );
    }
    Ok(())
}

pub(crate) fn reject_reserved_historical_scope_authority_artifacts(
    artifacts: &[ArtifactInput],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !artifacts.iter().any(|artifact| {
            artifact.artifact_kind == HISTORICAL_SCOPE_AUTHORITY_ARTIFACT_KIND
        }),
        "NEX_SCOPE_AUTHORITY_TYPED_BINDING_REQUIRED: source.snapshot@2 is owned by the typed historical Scope-authority producer"
    );
    Ok(())
}

/// Re-derive and seal the historical basis under the caller-owned transaction.
///
/// The returned `ArtifactInput` is deliberately inserted by
/// `repository::insert_artifacts_for_attempt`, preserving the artifact table's
/// single Native writer while keeping validation and insertion atomic.
pub(crate) fn persist_historical_scope_authority_basis_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    submitted_basis: &NarrativeScopeAuthorityBasisV2,
    finish_artifacts: &[ArtifactInput],
) -> anyhow::Result<ArtifactInput> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "NEX_SCOPE_AUTHORITY_TRANSACTION_REQUIRED: producer requires a caller-owned transaction"
    );
    submitted_basis.validate()?;

    let (durable_project_id, surface_path_id, scope_json, snapshot_digest): (
        String,
        String,
        String,
        Option<String>,
    ) = conn.query_row(
        "SELECT project_id, surface_path_id, scope_json, snapshot_digest
           FROM narrative_extraction_runs
          WHERE id = ?1",
        params![run_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    anyhow::ensure!(
        durable_project_id == project_id,
        "NEX_SCOPE_AUTHORITY_OWNER_MISMATCH: Run project differs from finish owner"
    );
    anyhow::ensure!(
        surface_path_id == HISTORICAL_SCOPE_AUTHORITY_SURFACE_PATH,
        "NEX_SCOPE_AUTHORITY_RUN_KIND_INVALID: typed historical basis requires chronicle.extract"
    );
    let snapshot_digest = snapshot_digest.ok_or_else(|| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_CORPUS_MISSING: Run snapshotDigest is required")
    })?;
    let scope: HistoricalRunScope = serde_json::from_str(&scope_json)
        .map_err(|error| invalid_durable_scope(format!("typed Run scope: {error}")))?;

    require_unique_completed_snapshot_task(conn, run_id, task_id, attempt_id)?;

    let mut statement = conn.prepare(
        "SELECT id, parent_id, node_type, sort_order, story_time_order
           FROM tree_nodes
          WHERE project_id = ?1 AND archived_at IS NULL",
    )?;
    let nodes = statement
        .query_map(params![project_id], |row| {
            Ok(PersistedTreeNode {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                node_type: row.get(2)?,
                sort_order: row.get(3)?,
                story_time_order: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let ordered_scene_ids = derive_ordered_scene_ids(&nodes, &scope.folder_id)?;
    anyhow::ensure!(
        ordered_scene_ids == scope.scene_ids,
        "NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_MISMATCH: Run sceneIds differ from the current persisted DFS scope"
    );

    let nodes_by_id = nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let documents = ordered_scene_ids
        .iter()
        .enumerate()
        .map(|(index, scene_id)| {
            let node = nodes_by_id.get(scene_id.as_str()).copied().ok_or_else(|| {
                invalid_durable_scope(format!("derived Scene '{scene_id}' is unavailable"))
            })?;
            Ok(NarrativeScopeAuthorityDocumentInputV2 {
                document_ref: format!("D{:06}", index + 1),
                source_key: format!("project:scene:{scene_id}"),
                raw_story_key: node.story_time_order.clone(),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let expected_basis =
        build_narrative_scope_authority_basis_v2(project_id, run_id, &snapshot_digest, &documents)?;
    validate_basis_scope_binding(&expected_basis, &scope)?;
    anyhow::ensure!(
        submitted_basis == &expected_basis,
        "NEX_SCOPE_AUTHORITY_BINDING_MISMATCH: submitted basis differs from Native re-derivation"
    );
    validate_snapshot_corpus_closure(finish_artifacts, &expected_basis, &snapshot_digest)?;

    let existing_count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_artifacts
          WHERE run_id = ?1 AND artifact_kind = ?2",
        params![run_id, HISTORICAL_SCOPE_AUTHORITY_ARTIFACT_KIND],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        existing_count == 0,
        "NEX_SCOPE_AUTHORITY_DUPLICATE: Run already owns a source.snapshot@2 artifact"
    );

    let payload_json = serde_json::to_value(&expected_basis)?;
    let payload_digest = grimodex_core::canonical_json_digest(&payload_json)?;
    Ok(ArtifactInput {
        artifact_id: Some(format!("scope-authority:{run_id}")),
        artifact_kind: HISTORICAL_SCOPE_AUTHORITY_ARTIFACT_KIND.to_owned(),
        payload_storage: Some("inline-json".to_owned()),
        payload_json: Some(payload_json),
        payload_ref: None,
        payload_digest: Some(payload_digest),
    })
}

/// Load a sealed historical basis from the caller's existing read/write
/// snapshot without consulting mutable project state.
pub(crate) fn load_historical_scope_authority_basis_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Option<NarrativeScopeAuthorityBasisV2>> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "NEX_SCOPE_AUTHORITY_TRANSACTION_REQUIRED: reader requires a caller-owned snapshot"
    );
    let run: Option<(String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT project_id, surface_path_id, scope_json, snapshot_digest
                   FROM narrative_extraction_runs
                  WHERE id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (durable_project_id, surface_path_id, scope_json, snapshot_digest) =
        run.ok_or_else(|| {
            anyhow::anyhow!("NEX_SCOPE_AUTHORITY_RUN_MISSING: historical Run not found")
        })?;
    anyhow::ensure!(
        durable_project_id == project_id,
        "NEX_SCOPE_AUTHORITY_OWNER_MISMATCH: requested project does not own Run"
    );
    anyhow::ensure!(
        surface_path_id == HISTORICAL_SCOPE_AUTHORITY_SURFACE_PATH,
        "NEX_SCOPE_AUTHORITY_RUN_KIND_INVALID: historical basis requires chronicle.extract"
    );
    let mut statement = conn.prepare(
        "SELECT task_id, attempt_id, payload_storage, payload_json, payload_ref, payload_digest
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = ?2
              ORDER BY id",
    )?;
    let artifacts = statement
        .query_map(
            params![run_id, HISTORICAL_SCOPE_AUTHORITY_ARTIFACT_KIND],
            |row| {
                Ok(StoredHistoricalArtifact {
                    task_id: row.get(0)?,
                    attempt_id: row.get(1)?,
                    payload_storage: row.get(2)?,
                    payload_json: row.get(3)?,
                    payload_ref: row.get(4)?,
                    payload_digest: row.get(5)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    if artifacts.is_empty() {
        return Ok(None);
    }
    let snapshot_digest = snapshot_digest.ok_or_else(|| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_CORPUS_MISSING: Run snapshotDigest is required")
    })?;
    let scope: HistoricalRunScope = serde_json::from_str(&scope_json)
        .map_err(|error| invalid_durable_scope(format!("typed Run scope: {error}")))?;
    anyhow::ensure!(
        artifacts.len() == 1,
        "NEX_SCOPE_AUTHORITY_DUPLICATE: Run must own exactly one source.snapshot@2 artifact"
    );
    let artifact = &artifacts[0];
    let task_id = artifact.task_id.as_deref().ok_or_else(|| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID: task owner is missing")
    })?;
    let attempt_id = artifact.attempt_id.as_deref().ok_or_else(|| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID: attempt owner is missing")
    })?;
    require_unique_completed_snapshot_task(conn, run_id, task_id, attempt_id)
        .map_err(|error| anyhow::anyhow!("NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID: {error}"))?;
    anyhow::ensure!(
        artifact.payload_storage == "inline-json" && artifact.payload_ref.is_none(),
        "NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID: payload must be inline-json without payloadRef"
    );
    let payload_json = artifact.payload_json.as_deref().ok_or_else(|| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID: payloadJson is missing")
    })?;
    let payload_value: serde_json::Value = serde_json::from_str(payload_json).map_err(|error| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID: payload JSON: {error}")
    })?;
    let expected_payload_digest = grimodex_core::canonical_json_digest(&payload_value)?;
    anyhow::ensure!(
        artifact.payload_digest.as_deref() == Some(expected_payload_digest.as_str()),
        "NEX_SCOPE_AUTHORITY_ARTIFACT_DIGEST_MISMATCH: payloadDigest differs from canonical payload"
    );
    let basis: NarrativeScopeAuthorityBasisV2 =
        serde_json::from_value(payload_value).map_err(|error| {
            anyhow::anyhow!("NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID: typed payload: {error}")
        })?;
    basis.validate()?;
    validate_basis_scope_binding(&basis, &scope)?;
    anyhow::ensure!(
        basis.project_id == project_id,
        "NEX_SCOPE_AUTHORITY_OWNER_MISMATCH: artifact project differs from Run"
    );
    anyhow::ensure!(
        basis.source.source_key == format!("snapshot:{run_id}"),
        "NEX_SCOPE_AUTHORITY_RUN_MISMATCH: artifact source does not bind the Run"
    );
    anyhow::ensure!(
        basis.digests.corpus_digest == snapshot_digest,
        "NEX_SCOPE_AUTHORITY_CORPUS_MISMATCH: artifact corpus differs from Run snapshotDigest"
    );

    // Re-verify the exact `source.snapshot@1` companion under the same read
    // snapshot: a basis whose corpus bytes were lost or replaced (restore,
    // import, corruption) must not be returned as valid. The corpus must
    // exist, be owned by the same Task/Attempt, carry the mandatory payload
    // digest, and still satisfy the full closure the producer sealed.
    let mut corpus_statement = conn.prepare(
        "SELECT task_id, attempt_id, payload_storage, payload_json, payload_ref, payload_digest
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = ?2
              ORDER BY id",
    )?;
    let corpora = corpus_statement
        .query_map(
            params![run_id, HISTORICAL_SCOPE_AUTHORITY_CORPUS_ARTIFACT_KIND],
            |row| {
                Ok(StoredHistoricalArtifact {
                    task_id: row.get(0)?,
                    attempt_id: row.get(1)?,
                    payload_storage: row.get(2)?,
                    payload_json: row.get(3)?,
                    payload_ref: row.get(4)?,
                    payload_digest: row.get(5)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        corpora.len() == 1,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_REQUIRED: Run must own exactly one \
         source.snapshot@1 corpus companion for its sealed historical basis"
    );
    let corpus = &corpora[0];
    anyhow::ensure!(
        corpus.task_id.as_deref() == Some(task_id)
            && corpus.attempt_id.as_deref() == Some(attempt_id),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus companion belongs to a different \
         Task/Attempt than the sealed basis"
    );
    let corpus_payload_json = corpus.payload_json.as_deref().ok_or_else(|| {
        invalid_corpus_artifact("corpus payloadJson is missing at readback")
    })?;
    let corpus_payload: serde_json::Value =
        serde_json::from_str(corpus_payload_json).map_err(|error| {
            invalid_corpus_artifact(format!("corpus payload JSON at readback: {error}"))
        })?;
    let corpus_input = ArtifactInput {
        artifact_id: None,
        artifact_kind: HISTORICAL_SCOPE_AUTHORITY_CORPUS_ARTIFACT_KIND.to_string(),
        payload_storage: Some(corpus.payload_storage.clone()),
        payload_json: Some(corpus_payload),
        payload_ref: corpus.payload_ref.clone(),
        payload_digest: corpus.payload_digest.clone(),
    };
    validate_snapshot_corpus_closure(
        std::slice::from_ref(&corpus_input),
        &basis,
        &snapshot_digest,
    )?;

    Ok(Some(basis))
}

/// Load a sealed historical basis under one deferred SQLite read snapshot.
pub fn load_historical_scope_authority_basis(
    db: &Database,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Option<NarrativeScopeAuthorityBasisV2>> {
    db.with_conn(|conn| {
        conn.execute_batch("SAVEPOINT load_historical_scope_authority_basis")?;
        match load_historical_scope_authority_basis_in_tx(conn, project_id, run_id) {
            Ok(value) => {
                match conn.execute_batch("RELEASE load_historical_scope_authority_basis") {
                    Ok(()) => Ok(value),
                    Err(error) => {
                        let _ = conn.execute_batch(
                            "ROLLBACK TO load_historical_scope_authority_basis;
                             RELEASE load_historical_scope_authority_basis",
                        );
                        Err(error.into())
                    }
                }
            }
            Err(error) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO load_historical_scope_authority_basis;
                     RELEASE load_historical_scope_authority_basis",
                );
                Err(error)
            }
        }
    })
}
