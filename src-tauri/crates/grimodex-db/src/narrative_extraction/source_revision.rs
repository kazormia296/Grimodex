//! Source revision resolution for Prepared Commit source-basis OCC.
//!
//! Source references are deliberately logical.  This registry resolves the
//! small set of source kinds that Gate B2 can bind to a current revision token
//! without adding foreign keys from provenance history into source/domain
//! tables.  Unknown kinds and malformed keys fail closed.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::Digest;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CurrentSourceRevision {
    pub revision_token: String,
}

pub(crate) fn resolve_source_revision(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_kind: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    match source_kind {
        "snapshot-document" => resolve_snapshot_document(conn, project_id, run_id, source_key),
        "scene-body" => resolve_scene_body(conn, project_id, source_key),
        "domain-projection" | "projection" => {
            resolve_domain_projection(conn, project_id, source_key)
        }
        "narrative-artifact" => resolve_narrative_artifact(conn, project_id, source_key),
        "import-capture" => resolve_import_capture(conn, source_key),
        "evidence-anchor" | "evidence" => {
            resolve_evidence_anchor(conn, project_id, source_key)
        }
        other => anyhow::bail!(
            "NEX_SOURCE_KIND_UNSUPPORTED: no source revision resolver is registered for '{other}'"
        ),
    }
}

fn resolve_snapshot_document(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let snapshot_run_id = source_key
        .strip_prefix("snapshot:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: snapshot-document sourceKey must be snapshot:<runId>"
            )
        })?;
    anyhow::ensure!(
        snapshot_run_id == run_id,
        "NEX_SOURCE_PROJECT_MISMATCH: snapshot source does not belong to prepared run"
    );
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT project_id, snapshot_digest
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![snapshot_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((source_project_id, snapshot_digest)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: snapshot run '{snapshot_run_id}' was not found");
    };
    anyhow::ensure!(
        source_project_id == project_id,
        "NEX_SOURCE_PROJECT_MISMATCH: snapshot run does not belong to project"
    );
    let revision_token = snapshot_digest.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SOURCE_MISSING: snapshot run '{snapshot_run_id}' has no sealed snapshot digest"
        )
    })?;
    ensure_non_empty_token(revision_token)
}

fn resolve_scene_body(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let scene_id = source_key
        .strip_prefix("project:scene:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: scene-body sourceKey must be project:scene:<id>"
            )
        })?;
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT version, updated_at
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((version, updated_at)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: scene '{scene_id}' was not found");
    };
    ensure_non_empty_token(format!("v{version}@{updated_at}"))
}

fn resolve_domain_projection(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let projection_id = source_key
        .strip_prefix("projection:")
        .filter(|value| !value.is_empty())
        .unwrap_or(source_key);
    let row: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT version, updated_at, status
               FROM narrative_temporal_projections
              WHERE id = ?1 AND project_id = ?2",
            params![projection_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((version, updated_at, status)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: projection '{projection_id}' was not found");
    };
    anyhow::ensure!(
        status == "current",
        "NEX_SOURCE_STALE: projection '{projection_id}' is not current"
    );
    ensure_non_empty_token(format!("v{version}@{updated_at}"))
}

fn resolve_narrative_artifact(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let artifact_id = source_key
        .strip_prefix("artifact:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: narrative-artifact sourceKey must be artifact:<id>"
            )
        })?;
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT a.payload_digest, a.payload_json
               FROM narrative_extraction_artifacts a
               INNER JOIN narrative_extraction_runs r ON r.id = a.run_id
              WHERE a.id = ?1 AND r.project_id = ?2",
            params![artifact_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((payload_digest, payload_json)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: artifact '{artifact_id}' was not found");
    };
    if let Some(payload_digest) = payload_digest {
        return ensure_non_empty_token(payload_digest);
    }
    let payload_json = payload_json.ok_or_else(|| {
        anyhow::anyhow!("NEX_SOURCE_MISSING: artifact '{artifact_id}' has no payload")
    })?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        anyhow::anyhow!("NEX_SOURCE_INVALID: artifact payload is invalid: {error}")
    })?;
    ensure_non_empty_token(format!("sha256:{}", digest_json(&payload)?))
}

fn resolve_import_capture(
    conn: &Connection,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let capture_id = source_key
        .strip_prefix("capture:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_SOURCE_KEY_INVALID: import-capture sourceKey must be capture:<id>")
        })?;
    let row: Option<(String, Option<String>, i64)> = conn
        .query_row(
            "SELECT state, sealed_digest, version
               FROM import_captures
              WHERE id = ?1",
            params![capture_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((state, sealed_digest, version)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: import capture '{capture_id}' was not found");
    };
    anyhow::ensure!(
        state == "sealed",
        "NEX_SOURCE_STALE: import capture '{capture_id}' is not sealed"
    );
    let sealed_digest = sealed_digest.ok_or_else(|| {
        anyhow::anyhow!("NEX_SOURCE_MISSING: import capture '{capture_id}' has no sealed digest")
    })?;
    ensure_non_empty_token(format!("v{version}@{sealed_digest}"))
}

fn resolve_evidence_anchor(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let anchor_id = source_key
        .strip_prefix("evidence:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: evidence-anchor sourceKey must be evidence:<id>"
            )
        })?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT b.source_document_digest, b.committed_storage_digest
               FROM import_evidence_bindings b
               INNER JOIN tree_nodes n
                       ON n.id = b.target_scene_id
                      AND n.project_id = ?1
              WHERE b.evidence_anchor_id = ?2
              ORDER BY b.committed_at DESC, b.rowid DESC
              LIMIT 1",
            params![project_id, anchor_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((source_document_digest, committed_storage_digest)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: evidence anchor '{anchor_id}' was not found");
    };
    ensure_non_empty_token(format!(
        "{source_document_digest}@{committed_storage_digest}"
    ))
}

fn ensure_non_empty_token<T>(token: T) -> anyhow::Result<CurrentSourceRevision>
where
    T: Into<String>,
{
    let revision_token = token.into();
    anyhow::ensure!(
        !revision_token.is_empty(),
        "NEX_SOURCE_MISSING: resolved source revision token is empty"
    );
    Ok(CurrentSourceRevision { revision_token })
}

fn digest_json(value: &Value) -> anyhow::Result<String> {
    let canonical = canonical_json_string(value)?;
    Ok(hex::encode(sha2::Sha256::digest(canonical.as_bytes())))
}

fn canonical_json_string(value: &Value) -> anyhow::Result<String> {
    serde_json::to_string(&canonical_json_value(value))
        .map_err(|error| anyhow::anyhow!("canonical source digest failed: {error}"))
}

fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_json_value).collect()),
        Value::Object(map) => {
            let mut entries: Vec<_> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json_value(value)))
                .collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            Value::Object(entries.into_iter().collect())
        }
        _ => value.clone(),
    }
}
