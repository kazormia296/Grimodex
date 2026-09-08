//! Typed historical Scope-authority artifact persistence and loading.
//!
//! The producer is owned by the typed task-finish path. It re-derives the
//! submitted basis from the durable Run and its sealed `source.snapshot@1`
//! companion while the caller's `BEGIN IMMEDIATE` transaction is open. The
//! reader validates only sealed historical artifacts and durable owner
//! bindings; it never consults the mutable project tree.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use grimodex_core::narrative_scope_authority_basis::{
    build_narrative_scope_authority_basis_v2, NarrativeScopeAuthorityBasisV2,
    NarrativeScopeAuthorityDocumentInputV2,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};

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
struct StoredHistoricalArtifact {
    task_id: Option<String>,
    attempt_id: Option<String>,
    payload_storage: String,
    payload_json: Option<String>,
    payload_ref: Option<String>,
    payload_digest: Option<String>,
}

/// Immutable document-to-project-node evidence carried by a completed parent
/// `source.snapshot@1` artifact.  Human ScopeOverride deliberately resolves
/// the edited document through this sealed evidence before consulting the
/// current tree, so a client cannot substitute the event Scene for its reveal
/// target.
#[derive(Debug)]
pub(crate) struct SealedSnapshotDocumentBinding {
    pub(crate) document_ref: String,
    pub(crate) source_key: String,
    pub(crate) node_id: String,
}

#[derive(Debug)]
struct SnapshotDocumentDraft {
    document_ref: String,
    source_key: String,
    parent_ref: Option<String>,
    title: String,
    order_index: u64,
    canonical_text: String,
    canonical_blocks: Value,
    canonical_projection: Value,
    content_digest: String,
    document_digest: String,
    artifact_digest: String,
    origin: Value,
    node_id: String,
}

#[derive(Debug)]
struct SnapshotDocumentSeal {
    document_ref: String,
    source_key: String,
    document_digest: String,
    artifact_digest: String,
    canonical_text: String,
    node_id: String,
}

struct ValidatedSnapshotCorpus {
    documents: Vec<SnapshotDocumentSeal>,
    scope_authority_documents: Vec<NarrativeScopeAuthorityDocumentInputV2>,
}

/// Native facts derived from one normalized `source.snapshot@1` payload.
/// Task finish uses this narrow result to CAS the coordinator's output JSON
/// without duplicating snapshot parsing or trusting renderer-supplied digests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SnapshotAuthorityFinishValidation {
    pub(crate) document_count: usize,
    pub(crate) corpus_payload_digest: String,
    pub(crate) scope_authority_composite_digest: Option<String>,
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
        !scope.folder_id.trim().is_empty() && scope.folder_id.trim() == scope.folder_id,
        "NEX_SCOPE_AUTHORITY_SCOPE_MISMATCH: Run folderId is invalid"
    );
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

fn invalid_corpus_artifact(reason: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {reason}")
}

const SNAPSHOT_NORMALIZER_VERSION: &str = "gdx-canonical-text/1";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

fn required_object<'a>(value: &'a Value, path: &str) -> anyhow::Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid_corpus_artifact(format!("{path} must be an object")))
}

fn required_array<'a>(value: &'a Value, path: &str) -> anyhow::Result<&'a Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| invalid_corpus_artifact(format!("{path} must be an array")))
}

fn required_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> anyhow::Result<&'a Value> {
    object
        .get(field)
        .ok_or_else(|| invalid_corpus_artifact(format!("{path}.{field} is missing")))
}

fn required_string(object: &Map<String, Value>, field: &str, path: &str) -> anyhow::Result<String> {
    required_field(object, field, path)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid_corpus_artifact(format!("{path}.{field} must be a string")))
}

fn required_safe_nonnegative_integer(
    object: &Map<String, Value>,
    field: &str,
    path: &str,
) -> anyhow::Result<u64> {
    let value = required_field(object, field, path)?
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_JSON_INTEGER)
        .ok_or_else(|| {
            invalid_corpus_artifact(format!(
                "{path}.{field} must be a non-negative safe integer"
            ))
        })?;
    Ok(value)
}

fn require_utf16_slice(text: &str, start: u64, end: u64, path: &str) -> anyhow::Result<String> {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let start = usize::try_from(start)
        .map_err(|_| invalid_corpus_artifact(format!("{path}.start is out of range")))?;
    let end = usize::try_from(end)
        .map_err(|_| invalid_corpus_artifact(format!("{path}.end is out of range")))?;
    anyhow::ensure!(
        start <= end && end <= units.len(),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path} is outside the canonical UTF-16 text"
    );
    let is_boundary = |offset: usize| {
        if offset == 0 || offset == units.len() {
            return true;
        }
        !(matches!(units[offset - 1], 0xD800..=0xDBFF) && matches!(units[offset], 0xDC00..=0xDFFF))
    };
    anyhow::ensure!(
        is_boundary(start) && is_boundary(end),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path} splits a UTF-16 surrogate pair"
    );
    String::from_utf16(&units[start..end]).map_err(|error| {
        invalid_corpus_artifact(format!("{path} cannot decode canonical UTF-16: {error}"))
    })
}

fn parse_snapshot_document_draft(
    value: &Value,
    index: usize,
    project_id: &str,
) -> anyhow::Result<SnapshotDocumentDraft> {
    let path = format!("snapshot.documents[{index}]");
    let document = required_object(value, &path)?;
    let document_ref = required_string(document, "ref", &path)?;
    anyhow::ensure!(
        document_ref == format!("D{:06}", index + 1),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.ref is not the deterministic snapshot document reference"
    );
    let source_key = required_string(document, "sourceKey", &path)?;
    let parent_ref = match required_field(document, "parentRef", &path)? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => {
            return Err(invalid_corpus_artifact(format!(
                "{path}.parentRef must be a string or null"
            )));
        }
    };
    let title = required_string(document, "title", &path)?;
    let order_index = required_safe_nonnegative_integer(document, "orderIndex", &path)?;
    let canonical = required_object(
        required_field(document, "canonical", &path)?,
        &format!("{path}.canonical"),
    )?;
    anyhow::ensure!(
        required_string(canonical, "unit", &format!("{path}.canonical"))? == "utf16",
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.canonical.unit must be utf16"
    );
    let canonical_text = required_string(canonical, "text", &format!("{path}.canonical"))?;
    let canonical_blocks =
        required_field(canonical, "blocks", &format!("{path}.canonical"))?.clone();
    let _ = required_array(&canonical_blocks, &format!("{path}.canonical.blocks"))?;
    let canonical_projection =
        required_field(canonical, "projection", &format!("{path}.canonical"))?.clone();
    let _ = required_object(
        &canonical_projection,
        &format!("{path}.canonical.projection"),
    )?;
    let canonical_projection_map =
        required_field(canonical, "projectionMap", &format!("{path}.canonical"))?.clone();
    anyhow::ensure!(
        canonical_projection_map == canonical_projection,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.canonical.projectionMap must equal projection"
    );
    let _ = required_array(
        required_field(canonical, "diagnostics", &format!("{path}.canonical"))?,
        &format!("{path}.canonical.diagnostics"),
    )?;
    let content_digest = required_string(document, "contentDigest", &path)?;
    let document_digest = required_string(document, "documentDigest", &path)?;
    let artifact_digest = required_string(document, "artifactDigest", &path)?;
    let origin = required_field(document, "origin", &path)?.clone();
    let origin_object = required_object(&origin, &format!("{path}.origin"))?;
    anyhow::ensure!(
        required_string(origin_object, "kind", &format!("{path}.origin"))? == "project-node"
            && required_string(origin_object, "projectId", &format!("{path}.origin"))?
                == project_id,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.origin is not a project node of the Run project"
    );
    let node_id = required_string(origin_object, "nodeId", &format!("{path}.origin"))?;
    let _ = required_safe_nonnegative_integer(
        origin_object,
        "sourceVersion",
        &format!("{path}.origin"),
    )?;
    let _ = required_string(origin_object, "sourceUpdatedAt", &format!("{path}.origin"))?;
    anyhow::ensure!(
        matches!(required_field(origin_object, "sourceUri", &format!("{path}.origin"))?, Value::Null | Value::String(_)),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.origin.sourceUri must be a string or null"
    );
    anyhow::ensure!(
        source_key == format!("project:scene:{node_id}"),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.sourceKey does not bind origin.nodeId"
    );
    Ok(SnapshotDocumentDraft {
        document_ref,
        source_key,
        parent_ref,
        title,
        order_index,
        canonical_text,
        canonical_blocks,
        canonical_projection,
        content_digest,
        document_digest,
        artifact_digest,
        origin,
        node_id,
    })
}

fn validate_sealed_snapshot_payload(
    payload: &Value,
    project_id: &str,
    run_snapshot_digest: &str,
) -> anyhow::Result<ValidatedSnapshotCorpus> {
    let payload_object = required_object(payload, "corpus payload")?;
    let snapshot = required_object(
        required_field(payload_object, "snapshot", "corpus payload")?,
        "corpus payload.snapshot",
    )?;
    anyhow::ensure!(
        required_safe_nonnegative_integer(snapshot, "schemaVersion", "corpus payload.snapshot")? == 1,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus payload.snapshot.schemaVersion must be 1"
    );
    anyhow::ensure!(
        required_string(snapshot, "id", "corpus payload.snapshot")?
            == required_string(snapshot, "snapshotId", "corpus payload.snapshot")?,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus payload.snapshot id and snapshotId differ"
    );
    let _ = required_string(snapshot, "createdAt", "corpus payload.snapshot")?;
    let _ = required_string(snapshot, "language", "corpus payload.snapshot")?;
    anyhow::ensure!(
        required_string(snapshot, "normalizerVersion", "corpus payload.snapshot")?
            == SNAPSHOT_NORMALIZER_VERSION,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus payload.snapshot normalizerVersion is unsupported"
    );
    let snapshot_origin = required_object(
        required_field(snapshot, "origin", "corpus payload.snapshot")?,
        "corpus payload.snapshot.origin",
    )?;
    anyhow::ensure!(
        required_string(snapshot_origin, "kind", "corpus payload.snapshot.origin")?
            == "grimodex-project"
            && required_string(snapshot_origin, "projectId", "corpus payload.snapshot.origin")?
                == project_id,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus payload.snapshot origin does not bind the Run project"
    );
    let document_values = required_array(
        required_field(snapshot, "documents", "corpus payload.snapshot")?,
        "corpus payload.snapshot.documents",
    )?;
    let drafts = document_values
        .iter()
        .enumerate()
        .map(|(index, document)| parse_snapshot_document_draft(document, index, project_id))
        .collect::<anyhow::Result<Vec<_>>>()?;

    let mut document_refs = HashSet::new();
    let mut source_keys = HashSet::new();
    let documents_by_ref = drafts
        .iter()
        .map(|document| {
            anyhow::ensure!(
                document_refs.insert(document.document_ref.as_str()),
                "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: snapshot documents contain duplicate refs"
            );
            anyhow::ensure!(
                source_keys.insert(document.source_key.as_str()),
                "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: snapshot documents contain duplicate sourceKeys"
            );
            Ok((document.document_ref.as_str(), document.source_key.as_str()))
        })
        .collect::<anyhow::Result<HashMap<_, _>>>()?;
    for pair in drafts.windows(2) {
        anyhow::ensure!(
            pair[0].order_index < pair[1].order_index
                || (pair[0].order_index == pair[1].order_index
                    && compare_utf16(&pair[0].source_key, &pair[1].source_key) != Ordering::Greater),
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: snapshot documents are not in deterministic order"
        );
    }
    let mut documents = Vec::with_capacity(drafts.len());
    for document in &drafts {
        let parent_source_key = match document.parent_ref.as_deref() {
            Some(parent_ref) => {
                Some(documents_by_ref.get(parent_ref).copied().ok_or_else(|| {
                    invalid_corpus_artifact(format!(
                        "snapshot document '{}' has an unknown parentRef '{parent_ref}'",
                        document.document_ref
                    ))
                })?)
            }
            None => None,
        };
        let expected_content_digest = grimodex_core::canonical_json_digest(&json!({
            "normalizerVersion": SNAPSHOT_NORMALIZER_VERSION,
            "text": &document.canonical_text,
        }))?;
        anyhow::ensure!(
            document.content_digest == expected_content_digest,
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: snapshot document '{}' contentDigest does not match canonical text",
            document.document_ref
        );
        let expected_document_digest = grimodex_core::canonical_json_digest(&json!({
            "normalizerVersion": SNAPSHOT_NORMALIZER_VERSION,
            "parentSourceKey": parent_source_key,
            "title": &document.title,
            "orderIndex": document.order_index,
            "canonical": {
                "text": &document.canonical_text,
                "blocks": &document.canonical_blocks,
            },
        }))?;
        anyhow::ensure!(
            document.document_digest == expected_document_digest,
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: snapshot document '{}' documentDigest does not match its canonical closure",
            document.document_ref
        );
        let expected_artifact_digest = grimodex_core::canonical_json_digest(&json!({
            "schemaVersion": 1,
            "normalizerVersion": SNAPSHOT_NORMALIZER_VERSION,
            "sourceKey": &document.source_key,
            "parentSourceKey": parent_source_key,
            "semanticDigest": &document.document_digest,
            "contentDigest": &document.content_digest,
            "projection": &document.canonical_projection,
            "origin": &document.origin,
        }))?;
        anyhow::ensure!(
            document.artifact_digest == expected_artifact_digest,
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: snapshot document '{}' artifactDigest does not match its sealed identity",
            document.document_ref
        );
        documents.push(SnapshotDocumentSeal {
            document_ref: document.document_ref.clone(),
            source_key: document.source_key.clone(),
            document_digest: document.document_digest.clone(),
            artifact_digest: document.artifact_digest.clone(),
            canonical_text: document.canonical_text.clone(),
            node_id: document.node_id.clone(),
        });
    }

    let omissions = required_array(
        required_field(snapshot, "omissions", "corpus payload.snapshot")?,
        "corpus payload.snapshot.omissions",
    )?;
    let mut previous_omission: Option<(String, String)> = None;
    for (index, omission) in omissions.iter().enumerate() {
        let path = format!("corpus payload.snapshot.omissions[{index}]");
        let omission = required_object(omission, &path)?;
        let current = (
            required_string(omission, "sourceKey", &path)?,
            required_string(omission, "reason", &path)?,
        );
        if let Some(previous) = previous_omission.as_ref() {
            anyhow::ensure!(
                compare_utf16(&previous.0, &current.0) != Ordering::Greater
                    && !(previous.0 == current.0
                        && compare_utf16(&previous.1, &current.1) == Ordering::Greater),
                "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: snapshot omissions are not in deterministic order"
            );
        }
        previous_omission = Some(current);
    }
    let snapshot_digest = required_string(snapshot, "digest", "corpus payload.snapshot")?;
    let expected_snapshot_digest = grimodex_core::canonical_json_digest(&json!({
        "schemaVersion": 1,
        "language": required_string(snapshot, "language", "corpus payload.snapshot")?,
        "normalizerVersion": SNAPSHOT_NORMALIZER_VERSION,
        "documentDigests": documents
            .iter()
            .map(|document| Value::String(document.document_digest.clone()))
            .collect::<Vec<_>>(),
        "omissions": omissions,
    }))?;
    anyhow::ensure!(
        snapshot_digest == expected_snapshot_digest && snapshot_digest == run_snapshot_digest,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus snapshot digest does not match its sealed document closure and Run snapshotDigest"
    );
    let expected_snapshot_artifact_digest = grimodex_core::canonical_json_digest(&json!({
        "schemaVersion": 1,
        "normalizerVersion": SNAPSHOT_NORMALIZER_VERSION,
        "semanticDigest": snapshot_digest,
        "originProjectId": project_id,
        "documents": documents.iter().map(|document| json!({
            "sourceKey": &document.source_key,
            "artifactDigest": &document.artifact_digest,
        })).collect::<Vec<_>>(),
        "omissions": omissions,
    }))?;
    anyhow::ensure!(
        required_string(snapshot, "artifactDigest", "corpus payload.snapshot")?
            == expected_snapshot_artifact_digest,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus snapshot artifactDigest does not match its sealed document artifacts"
    );

    let source_views = required_array(
        required_field(payload_object, "sourceViews", "corpus payload")?,
        "corpus payload.sourceViews",
    )?;
    let documents_by_ref = documents
        .iter()
        .map(|document| (document.document_ref.as_str(), document))
        .collect::<HashMap<_, _>>();
    let mut source_view_refs = HashSet::<String>::new();
    for (index, source_view) in source_views.iter().enumerate() {
        let path = format!("corpus payload.sourceViews[{index}]");
        let source_view = required_object(source_view, &path)?;
        let source_view_ref = required_string(source_view, "ref", &path)?;
        anyhow::ensure!(
            !source_view_ref.is_empty() && source_view_refs.insert(source_view_ref.clone()),
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: sourceViews contains an empty or duplicate ref"
        );
        let document_ref = required_string(source_view, "documentRef", &path)?;
        let document = documents_by_ref
            .get(document_ref.as_str())
            .copied()
            .ok_or_else(|| {
                invalid_corpus_artifact(format!(
                    "{path}.documentRef is not a sealed snapshot document"
                ))
            })?;
        let range = required_object(
            required_field(source_view, "documentRange", &path)?,
            &format!("{path}.documentRange"),
        )?;
        let start =
            required_safe_nonnegative_integer(range, "start", &format!("{path}.documentRange"))?;
        let end =
            required_safe_nonnegative_integer(range, "end", &format!("{path}.documentRange"))?;
        let text = required_string(source_view, "text", &path)?;
        anyhow::ensure!(
            text == require_utf16_slice(&document.canonical_text, start, end, &format!("{path}.documentRange"))?,
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.text does not match the sealed document range"
        );
        let expected_digest = grimodex_core::canonical_json_digest(&json!({
            "schemaVersion": 1,
            "ref": source_view_ref,
            "documentRef": document_ref,
            "documentArtifactDigest": document.artifact_digest,
            "documentRange": {"start": start, "end": end},
            "text": text,
        }))?;
        anyhow::ensure!(
            required_string(source_view, "digest", &path)? == expected_digest,
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path}.digest does not match its sealed source view"
        );
    }

    let scope_authority_values = required_array(
        required_field(payload_object, "scopeAuthorityDocuments", "corpus payload")?,
        "corpus payload.scopeAuthorityDocuments",
    )?;
    anyhow::ensure!(
        scope_authority_values.len() == documents.len(),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: scopeAuthorityDocuments must cover every sealed snapshot document"
    );
    let scope_authority_documents = scope_authority_values
        .iter()
        .zip(documents.iter())
        .enumerate()
        .map(|(index, (value, document))| {
            let path = format!("corpus payload.scopeAuthorityDocuments[{index}]");
            let value = required_object(value, &path)?;
            let document_ref = required_string(value, "documentRef", &path)?;
            let source_key = required_string(value, "sourceKey", &path)?;
            anyhow::ensure!(
                document_ref == document.document_ref && source_key == document.source_key,
                "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: {path} does not match the sealed snapshot document order/ref/sourceKey"
            );
            let raw_story_key = match required_field(value, "rawStoryKey", &path)? {
                Value::Null => None,
                Value::String(value) => Some(value.clone()),
                _ => {
                    return Err(invalid_corpus_artifact(format!(
                        "{path}.rawStoryKey must be a string or null"
                    )));
                }
            };
            Ok(NarrativeScopeAuthorityDocumentInputV2 {
                document_ref,
                source_key,
                raw_story_key,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(ValidatedSnapshotCorpus {
        documents,
        scope_authority_documents,
    })
}

/// Verify a normalized snapshot artifact and, when supplied, its typed
/// historical Scope-authority sidecar.  This is intentionally usable by the
/// task-finish wire CAS before artifacts are inserted: it validates the full
/// document/internal-artifact seal and returns only Native recomputations.
pub(crate) fn validate_snapshot_authority_finish(
    payload: &Value,
    project_id: &str,
    run_id: &str,
    run_snapshot_digest: &str,
    historical_scope_authority_basis: Option<&NarrativeScopeAuthorityBasisV2>,
) -> anyhow::Result<SnapshotAuthorityFinishValidation> {
    let corpus_payload_digest = grimodex_core::canonical_json_digest(payload)?;
    let corpus = validate_sealed_snapshot_payload(payload, project_id, run_snapshot_digest)?;
    let scope_authority_composite_digest = historical_scope_authority_basis
        .map(|basis| {
            basis.validate()?;
            let expected = build_narrative_scope_authority_basis_v2(
                project_id,
                run_id,
                run_snapshot_digest,
                &corpus.scope_authority_documents,
            )?;
            anyhow::ensure!(
                basis == &expected,
                "NEX_SCOPE_AUTHORITY_BINDING_MISMATCH: submitted basis differs from the sealed source.snapshot@1 authority companion"
            );
            Ok(basis.digests.composite_digest.clone())
        })
        .transpose()?;
    Ok(SnapshotAuthorityFinishValidation {
        document_count: corpus.documents.len(),
        corpus_payload_digest,
        scope_authority_composite_digest,
    })
}

/// Resolve one document reference through the parent Run's completed sealed
/// corpus.  This is intentionally narrower than historical-basis loading:
/// C2B may use it before a `source.snapshot@2` authority artifact exists, but
/// it still requires the exact completed snapshot Task/Attempt and verifies
/// the artifact's canonical payload digest and Run snapshot binding.
pub(crate) fn load_sealed_snapshot_document_binding_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    document_ref: &str,
) -> anyhow::Result<SealedSnapshotDocumentBinding> {
    anyhow::ensure!(
        !document_ref.trim().is_empty() && document_ref.trim() == document_ref,
        "NEX_SCOPE_AUTHORITY_REVEAL_DOCUMENT_INVALID: edited revealDocumentRef must be trimmed and non-empty"
    );
    let mut matches = load_sealed_snapshot_document_bindings_in_tx(conn, project_id, run_id)?
        .into_iter().filter(|d| d.document_ref == document_ref);
    let document = matches.next().ok_or_else(|| anyhow::anyhow!(
        "NEX_SCOPE_AUTHORITY_REVEAL_DOCUMENT_MISSING: parent corpus has no document '{}'", document_ref))?;
    anyhow::ensure!(matches.next().is_none(),
        "NEX_SCOPE_AUTHORITY_REVEAL_DOCUMENT_AMBIGUOUS: parent corpus has multiple documents '{}'", document_ref);
    Ok(document)
}

pub(crate) fn load_sealed_snapshot_document_bindings_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Vec<SealedSnapshotDocumentBinding>> {
    anyhow::ensure!(!conn.is_autocommit(),
        "NEX_SCOPE_AUTHORITY_TRANSACTION_REQUIRED: sealed snapshot lookup requires a caller-owned transaction");
    let (durable_project_id, snapshot_digest): (String, Option<String>) = conn.query_row(
        "SELECT project_id, snapshot_digest
           FROM narrative_extraction_runs
          WHERE id = ?1",
        params![run_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    anyhow::ensure!(
        durable_project_id == project_id,
        "NEX_SCOPE_AUTHORITY_OWNER_MISMATCH: parent Run project differs from ScopeOverride project"
    );
    let snapshot_digest = snapshot_digest.ok_or_else(|| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_CORPUS_MISSING: parent Run has no snapshotDigest")
    })?;

    let mut statement = conn.prepare(
        "SELECT task_id, attempt_id, payload_storage, payload_json, payload_ref, payload_digest
           FROM narrative_extraction_artifacts
          WHERE run_id = ?1 AND artifact_kind = ?2
          ORDER BY id",
    )?;
    let artifacts = statement
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
        artifacts.len() == 1,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_REQUIRED: parent Run must own exactly one source.snapshot@1 corpus artifact"
    );
    let artifact = &artifacts[0];
    let task_id = artifact.task_id.as_deref().ok_or_else(|| {
        anyhow::anyhow!("NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus task owner is missing")
    })?;
    let attempt_id = artifact.attempt_id.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus attempt owner is missing"
        )
    })?;
    require_unique_completed_snapshot_task(conn, run_id, task_id, attempt_id)?;
    anyhow::ensure!(
        artifact.payload_storage == "inline-json" && artifact.payload_ref.is_none(),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus artifact must be inline-json without payloadRef"
    );
    let payload_json = artifact
        .payload_json
        .as_deref()
        .ok_or_else(|| invalid_corpus_artifact("parent corpus payloadJson is missing"))?;
    let payload: Value = serde_json::from_str(payload_json)
        .map_err(|error| invalid_corpus_artifact(format!("parent corpus payload JSON: {error}")))?;
    let payload_digest = grimodex_core::canonical_json_digest(&payload)?;
    anyhow::ensure!(
        artifact.payload_digest.as_deref() == Some(payload_digest.as_str()),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: parent corpus payloadDigest differs from Native canonical payload"
    );
    let corpus = validate_sealed_snapshot_payload(&payload, project_id, &snapshot_digest)?;
    Ok(corpus.documents.iter().map(|document| SealedSnapshotDocumentBinding {
        document_ref: document.document_ref.clone(),
        source_key: document.source_key.clone(),
        node_id: document.node_id.clone(),
    }).collect())
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
) -> anyhow::Result<ValidatedSnapshotCorpus> {
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
    let corpus = validate_sealed_snapshot_payload(payload, &basis.project_id, run_snapshot_digest)?;
    anyhow::ensure!(
        basis.digests.corpus_digest == run_snapshot_digest,
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: basis corpusDigest differs from Run snapshotDigest"
    );
    anyhow::ensure!(
        corpus.scope_authority_documents.len() == basis.mappings.len(),
        "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: corpus document closure differs from the basis mappings"
    );
    for (document, mapping) in corpus
        .scope_authority_documents
        .iter()
        .zip(basis.mappings.iter())
    {
        anyhow::ensure!(
            document.document_ref == mapping.document_ref
                && document.source_key == mapping.source_key,
            "NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID: sealed scopeAuthorityDocuments differ from the basis mappings"
        );
    }
    Ok(corpus)
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
/// The Scope/Story source is the completed `source.snapshot@1` companion, not
/// the mutable project tree at task finish.  Re-reading the tree here could
/// combine a T1 corpus with T2 story authority and seal a basis that never
/// existed at either instant.
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

    let corpus =
        validate_snapshot_corpus_closure(finish_artifacts, submitted_basis, &snapshot_digest)?;
    let expected_basis = build_narrative_scope_authority_basis_v2(
        project_id,
        run_id,
        &snapshot_digest,
        &corpus.scope_authority_documents,
    )?;
    validate_basis_scope_binding(&expected_basis, &scope)?;
    anyhow::ensure!(
        submitted_basis == &expected_basis,
        "NEX_SCOPE_AUTHORITY_BINDING_MISMATCH: submitted basis differs from Native re-derivation"
    );

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
    let corpus_payload_json = corpus
        .payload_json
        .as_deref()
        .ok_or_else(|| invalid_corpus_artifact("corpus payloadJson is missing at readback"))?;
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
    let corpus = validate_snapshot_corpus_closure(
        std::slice::from_ref(&corpus_input),
        &basis,
        &snapshot_digest,
    )?;
    let expected_basis = build_narrative_scope_authority_basis_v2(
        project_id,
        run_id,
        &snapshot_digest,
        &corpus.scope_authority_documents,
    )?;
    anyhow::ensure!(
        basis == expected_basis,
        "NEX_SCOPE_AUTHORITY_BINDING_MISMATCH: sealed basis differs from the source.snapshot@1 authority companion"
    );

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
