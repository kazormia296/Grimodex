//! Native validation and canonicalization for the Proposal Revision Envelope.
//!
//! The renderer may propose the envelope, but Native owns the identity,
//! read-set, and digest checks before a revision is persisted.  This module
//! intentionally stores no foreign keys to source rows: source deletion must
//! not cascade into proposal history.

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, Context};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub(crate) const ORIGIN_ENVELOPED: &str = "enveloped";
pub(crate) const ORIGIN_LEGACY_UNBOUND: &str = "legacy-unbound";

#[derive(Debug, Clone)]
pub(crate) struct SourceBasisRow {
    pub ordinal: i64,
    pub source_kind: String,
    pub source_key: String,
    pub revision_token: String,
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedReconciliationEnvelope {
    pub canonical_json: String,
    pub digest: String,
    pub source_basis: Vec<SourceBasisRow>,
}

pub(crate) fn load_source_basis_rows(
    conn: &Connection,
    revision_id: &str,
) -> anyhow::Result<Vec<SourceBasisRow>> {
    let mut statement = conn.prepare(
        "SELECT ordinal, source_kind, source_key, revision_token, observed_at
           FROM narrative_revision_source_basis
          WHERE revision_id = ?1
          ORDER BY ordinal ASC",
    )?;
    let rows = statement
        .query_map(params![revision_id], |row| {
            Ok(SourceBasisRow {
                ordinal: row.get(0)?,
                source_kind: row.get(1)?,
                source_key: row.get(2)?,
                revision_token: row.get(3)?,
                observed_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Validate a client envelope and return the canonical bytes/digests Native
/// will persist. `None` is an intentional legacy-unbound revision.
pub(crate) fn validate_reconciliation_envelope(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    envelope: Option<&Value>,
) -> anyhow::Result<Option<ValidatedReconciliationEnvelope>> {
    let Some(envelope) = envelope else {
        return Ok(None);
    };
    let object = envelope
        .as_object()
        .context("NEX_ENVELOPE_INVALID: envelope must be a JSON object")?;

    anyhow::ensure!(
        object.get("schemaVersion").and_then(Value::as_u64) == Some(1),
        "NEX_ENVELOPE_SCHEMA_UNSUPPORTED: schemaVersion must be 1"
    );
    let envelope_run_id = required_string(object, "runId")?;
    anyhow::ensure!(
        envelope_run_id == run_id,
        "NEX_ENVELOPE_RUN_MISMATCH: envelope runId does not match payload runId"
    );
    for field in [
        "taskId",
        "reconcilerId",
        "reconcilerVersion",
        "proposalSchemaId",
        "proposalSchemaVersion",
    ] {
        required_string(object, field)?;
    }

    let run_project: Option<String> = conn
        .query_row(
            "SELECT project_id FROM narrative_extraction_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        run_project.as_deref() == Some(project_id),
        "NEX_ENVELOPE_PROJECT_MISMATCH: run does not belong to project"
    );

    let task_id = required_string(object, "taskId")?;
    let task_run: Option<String> = conn
        .query_row(
            "SELECT run_id FROM narrative_extraction_tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        task_run.as_deref() == Some(run_id),
        "NEX_ENVELOPE_TASK_MISMATCH: task does not belong to run"
    );

    let source_basis_values = required_array(object, "sourceBasis")?;
    let mut source_keys = HashSet::new();
    let mut source_basis = Vec::with_capacity(source_basis_values.len());
    for (ordinal, value) in source_basis_values.iter().enumerate() {
        let source = value.as_object().ok_or_else(|| {
            anyhow!("NEX_ENVELOPE_SOURCE_BASIS_INVALID: entry {ordinal} is not an object")
        })?;
        let source_kind = required_string(source, "sourceKind")?;
        let source_key = required_string(source, "sourceKey")?;
        let revision_token = required_string(source, "revisionToken")?;
        anyhow::ensure!(
            source_keys.insert(source_key),
            "NEX_ENVELOPE_SOURCE_BASIS_DUPLICATE: sourceKey '{source_key}' is duplicated"
        );
        let observed_at = optional_string(source, "revisionObservedAt")?.map(str::to_owned);
        source_basis.push(SourceBasisRow {
            ordinal: i64::try_from(ordinal).context("source basis ordinal overflow")?,
            source_kind: source_kind.to_owned(),
            source_key: source_key.to_owned(),
            revision_token: revision_token.to_owned(),
            observed_at,
        });
    }

    let read_set_values = required_array(object, "readSet")?;
    let mut read_refs = HashSet::new();
    for (index, value) in read_set_values.iter().enumerate() {
        let entry = value.as_object().ok_or_else(|| {
            anyhow!("NEX_ENVELOPE_READ_SET_INVALID: entry {index} is not an object")
        })?;
        let input_ref = required_string(entry, "inputRef")?;
        anyhow::ensure!(
            read_refs.insert(input_ref),
            "NEX_ENVELOPE_READ_SET_DUPLICATE: inputRef '{input_ref}' is duplicated"
        );
        let kind = required_string(entry, "kind")?;
        anyhow::ensure!(
            matches!(
                kind,
                "snapshot-document" | "projection" | "evidence" | "signal"
            ),
            "NEX_ENVELOPE_READ_SET_KIND_INVALID: unsupported read-set kind '{kind}'"
        );
    }

    for source in &source_basis {
        anyhow::ensure!(
            read_refs.contains(source.source_key.as_str()),
            "NEX_ENVELOPE_SOURCE_BASIS_NOT_READ: sourceKey '{}' is absent from readSet",
            source.source_key
        );
    }

    let evidence_values = required_array(object, "evidenceSet")?;
    let mut evidence_refs = HashSet::new();
    for (index, value) in evidence_values.iter().enumerate() {
        let evidence = value.as_object().ok_or_else(|| {
            anyhow!("NEX_ENVELOPE_EVIDENCE_INVALID: entry {index} is not an object")
        })?;
        let evidence_ref = required_string(evidence, "evidenceRef")?;
        anyhow::ensure!(
            evidence_refs.insert(evidence_ref),
            "NEX_ENVELOPE_EVIDENCE_DUPLICATE: evidenceRef '{evidence_ref}' is duplicated"
        );
        let document_ref = optional_string(evidence, "documentRef")?;
        anyhow::ensure!(
            read_refs.contains(evidence_ref)
                || document_ref.is_some_and(|reference| read_refs.contains(reference)),
            "NEX_ENVELOPE_EVIDENCE_NOT_READ: evidenceRef '{evidence_ref}' is absent from readSet"
        );
        if let Some(quote_digest) = optional_string(evidence, "quoteDigest")? {
            ensure_sha256_digest(quote_digest, "quoteDigest")?;
        }
    }

    let supplied_read_set_digest = required_string(object, "readSetDigest")?;
    ensure_sha256_digest(supplied_read_set_digest, "readSetDigest")?;
    let read_set_digest = digest_json(&Value::Array(read_set_values.clone()))?;
    anyhow::ensure!(
        supplied_read_set_digest == read_set_digest,
        "NEX_ENVELOPE_READ_SET_DIGEST_MISMATCH: Native read-set digest differs from supplied digest"
    );

    let change_kind = required_string(object, "changeKind")?;
    anyhow::ensure!(
        matches!(
            change_kind,
            "add" | "revise" | "retract" | "merge" | "split"
        ),
        "NEX_ENVELOPE_CHANGE_KIND_INVALID: unsupported changeKind '{change_kind}'"
    );
    let target_projection_ref = optional_string(object, "targetProjectionRef")?;
    if let Some(target) = target_projection_ref {
        anyhow::ensure!(
            !target.is_empty(),
            "NEX_ENVELOPE_TARGET_INVALID: targetProjectionRef must not be empty"
        );
    }
    anyhow::ensure!(
        change_kind != "retract" || target_projection_ref.is_some(),
        "NEX_ENVELOPE_TARGET_REQUIRED: retract requires targetProjectionRef"
    );
    anyhow::ensure!(
        change_kind != "add" || target_projection_ref.is_none(),
        "NEX_ENVELOPE_TARGET_FORBIDDEN: add cannot specify targetProjectionRef"
    );

    let canonical_json = canonical_json_string(envelope)?;
    let digest = digest_bytes(canonical_json.as_bytes());
    Ok(Some(ValidatedReconciliationEnvelope {
        canonical_json,
        digest,
        source_basis,
    }))
}

fn required_string<'a>(object: &'a Map<String, Value>, field: &str) -> anyhow::Result<&'a str> {
    let value = object
        .get(field)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_FIELD_MISSING: {field}"))?;
    let value = value
        .as_str()
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_FIELD_INVALID: {field} must be a string"))?;
    anyhow::ensure!(
        !value.is_empty(),
        "NEX_ENVELOPE_FIELD_INVALID: {field} must not be empty"
    );
    Ok(value)
}

fn optional_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> anyhow::Result<Option<&'a str>> {
    let Some(value) = object.get(field) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_FIELD_INVALID: {field} must be a string"))?;
    Ok(Some(value))
}

fn required_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> anyhow::Result<&'a Vec<Value>> {
    object
        .get(field)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_FIELD_MISSING: {field}"))?
        .as_array()
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_FIELD_INVALID: {field} must be an array"))
}

fn ensure_sha256_digest(value: &str, field: &str) -> anyhow::Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        anyhow::bail!("NEX_ENVELOPE_DIGEST_INVALID: {field} must use sha256:<hex>");
    };
    anyhow::ensure!(
        hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "NEX_ENVELOPE_DIGEST_INVALID: {field} must contain 64 hexadecimal characters"
    );
    Ok(())
}

fn canonical_json_string(value: &Value) -> anyhow::Result<String> {
    serde_json::to_string(&canonical_json_value(value)).context("serialize canonical envelope")
}

fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_json_value).collect()),
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json_value(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        _ => value.clone(),
    }
}

fn digest_json(value: &Value) -> anyhow::Result<String> {
    let canonical = canonical_json_string(value)?;
    Ok(digest_bytes(canonical.as_bytes()))
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::{canonical_json_string, digest_json};
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_objects_but_preserves_arrays() {
        let value = json!({"z": 1, "a": {"y": true, "b": [3, 2, 1]}});
        assert_eq!(
            canonical_json_string(&value).expect("canonical JSON"),
            r#"{"a":{"b":[3,2,1],"y":true},"z":1}"#
        );
    }

    #[test]
    fn read_set_digest_is_prefixed_sha256() {
        let value = json!([{"kind": "projection", "inputRef": "p1"}]);
        assert_eq!(
            digest_json(&value).expect("read-set digest"),
            "sha256:e5ea4ae7027922fd5e2548e2391a588ccdb0e4887ef2496b3df9eec896cabf6e"
        );
    }
}
