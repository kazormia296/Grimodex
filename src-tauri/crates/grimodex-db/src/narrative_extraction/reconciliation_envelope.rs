//! Native validation and canonicalization for the Proposal Revision Envelope.
//!
//! The renderer may propose the envelope, but Native owns the identity,
//! read-set, and digest checks before a revision is persisted.  This module
//! intentionally stores no foreign keys to source rows: source deletion must
//! not cascade into proposal history.

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, Context};
use grimodex_core::narrative_ir::validate_chronicle_scene_event_v2;
use grimodex_core::{
    canonical_json_digest as core_canonical_json_digest,
    canonical_json_string as core_canonical_json_string,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::source_revision::resolve_source_revision;

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

pub(crate) fn load_read_set_rows(envelope: &Value) -> anyhow::Result<Vec<SourceBasisRow>> {
    let object = envelope
        .as_object()
        .ok_or_else(|| anyhow!("NEX_READ_SET_DRIFT: envelope is not an object"))?;
    let read_set = required_array(object, "readSet")?;
    let mut rows = Vec::with_capacity(read_set.len());
    for (ordinal, value) in read_set.iter().enumerate() {
        let entry = value.as_object().ok_or_else(|| {
            anyhow!("NEX_READ_SET_DRIFT: read-set entry {ordinal} is not an object")
        })?;
        let source_key = required_string(entry, "inputRef")?;
        let kind = required_string(entry, "kind")?;
        let source_kind = optional_string(entry, "sourceKind")?
            .map(str::to_owned)
            .unwrap_or(source_kind_for_read_set(kind)?.to_string());
        let revision_token = required_string(entry, "revisionToken")?;
        rows.push(SourceBasisRow {
            ordinal: i64::try_from(ordinal).context("read-set ordinal overflow")?,
            source_kind,
            source_key: source_key.to_owned(),
            revision_token: revision_token.to_owned(),
            observed_at: None,
        });
    }
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

    if envelope_schema_version(envelope) == Some(2) {
        return validate_v2_reconciliation_envelope(conn, project_id, run_id, envelope);
    }

    anyhow::ensure!(
        envelope_schema_version(envelope) == Some(1),
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
    anyhow::ensure!(
        !source_basis_values.is_empty(),
        "NEX_ENVELOPE_SOURCE_BASIS_EMPTY: sourceBasis must contain at least one source"
    );
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
    anyhow::ensure!(
        !read_set_values.is_empty(),
        "NEX_ENVELOPE_READ_SET_EMPTY: readSet must contain at least one input"
    );
    let mut read_refs = HashSet::new();
    let mut read_kinds = BTreeMap::new();
    let mut read_revision_tokens = BTreeMap::new();
    let mut has_revision_tokens = false;
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
        read_kinds.insert(input_ref.to_owned(), kind.to_owned());
        if let Some(source_kind) = optional_string(entry, "sourceKind")? {
            anyhow::ensure!(
                !source_kind.is_empty(),
                "NEX_ENVELOPE_READ_SET_INVALID: sourceKind must not be empty"
            );
        }
        if let Some(revision_token) = optional_string(entry, "revisionToken")? {
            anyhow::ensure!(
                !revision_token.is_empty(),
                "NEX_ENVELOPE_READ_SET_INVALID: revisionToken must not be empty"
            );
            has_revision_tokens = true;
            read_revision_tokens.insert(input_ref.to_owned(), revision_token.to_owned());
        }
    }
    if has_revision_tokens {
        anyhow::ensure!(
            read_revision_tokens.len() == read_set_values.len(),
            "NEX_ENVELOPE_READ_SET_TOKEN_MISSING: every read-set entry must carry revisionToken"
        );
    }

    for source in &source_basis {
        anyhow::ensure!(
            read_refs.contains(source.source_key.as_str()),
            "NEX_ENVELOPE_SOURCE_BASIS_NOT_READ: sourceKey '{}' is absent from readSet",
            source.source_key
        );
        let expected_kind = read_set_kind_for_source_kind(&source.source_kind)?;
        anyhow::ensure!(
            read_kinds.get(&source.source_key).map(String::as_str) == Some(expected_kind),
            "NEX_ENVELOPE_SOURCE_BASIS_KIND_MISMATCH: sourceKey '{}' requires read-set kind '{}'",
            source.source_key,
            expected_kind
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
        let document_ref = required_string(evidence, "documentRef")?;
        let evidence_source_key = required_string(evidence, "sourceKey")?;
        let evidence_revision_token = required_string(evidence, "revisionToken")?;
        anyhow::ensure!(
            read_refs.contains(evidence_ref)
                || read_refs.contains(document_ref)
                || read_refs.contains(evidence_source_key),
            "NEX_ENVELOPE_EVIDENCE_NOT_READ: evidenceRef '{evidence_ref}' has no read source"
        );
        anyhow::ensure!(
            read_refs.contains(evidence_source_key),
            "NEX_ENVELOPE_EVIDENCE_NOT_READ: evidence sourceKey '{evidence_source_key}' is absent from readSet"
        );
        anyhow::ensure!(
            read_revision_tokens
                .get(evidence_source_key)
                .map(String::as_str)
                == Some(evidence_revision_token),
            "NEX_ENVELOPE_EVIDENCE_TOKEN_MISMATCH: evidence revisionToken differs from readSet"
        );
        let quote = required_string(evidence, "quote")?;
        let quote_digest = required_string(evidence, "quoteDigest")?;
        ensure_sha256_digest(quote_digest, "quoteDigest")?;
        anyhow::ensure!(
            quote_digest == digest_bytes(quote.as_bytes()),
            "NEX_ENVELOPE_EVIDENCE_QUOTE_DIGEST_MISMATCH: quoteDigest does not match quote"
        );
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

    // Schema v1 predates the mandatory read-set binding.  Keep those rows
    // readable for migration/review, but never promote them to the
    // `enveloped` origin: without a complete token vector Native cannot prove
    // what the reconciler actually read, and a live token lookup at save time
    // would leave a TOCTOU gap.  The caller therefore persists this as an
    // explicit legacy-unbound revision, which the prepare/apply path rejects.
    if !has_revision_tokens {
        return Ok(None);
    }

    let canonical_json = core_canonical_json_string(envelope)?;
    let digest = digest_bytes(canonical_json.as_bytes());
    Ok(Some(ValidatedReconciliationEnvelope {
        canonical_json,
        digest,
        source_basis,
    }))
}

/// Validate and canonicalise the C1 Chronicle Envelope V2 persistence shape.
/// The pure Core validator owns the structural vocabulary; this persistence
/// boundary additionally binds the run/task identity, recomputes every
/// durable nested digest, and extracts the immutable source basis rows.
fn validate_v2_reconciliation_envelope(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    envelope: &Value,
) -> anyhow::Result<Option<ValidatedReconciliationEnvelope>> {
    validate_chronicle_scene_event_v2(envelope)
        .map_err(|error| anyhow!("NEX_ENVELOPE_V2_INVALID: {error}"))?;
    let object = envelope
        .as_object()
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_INVALID: envelope must be a JSON object"))?;

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

    let basis = object
        .get("revisionBasis")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: revisionBasis must be an object"))?;
    if basis.get("kind").and_then(Value::as_str) == Some("interpretation") {
        let envelope_run_id = required_string(basis, "runId")?;
        anyhow::ensure!(
            envelope_run_id == run_id,
            "NEX_ENVELOPE_RUN_MISMATCH: envelope runId does not match payload runId"
        );
        let task_id = required_string(basis, "taskId")?;
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
    }

    validate_v2_nested_digest_fields(object)?;
    let source_basis_values = object
        .get("effectiveMaterialBasis")
        .and_then(Value::as_object)
        .and_then(|material| material.get("sourceBasis"))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_SOURCE_BASIS_INVALID: sourceBasis is missing"))?;
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
        source_basis.push(SourceBasisRow {
            ordinal: i64::try_from(ordinal).context("source basis ordinal overflow")?,
            source_kind: source_kind.to_owned(),
            source_key: source_key.to_owned(),
            revision_token: revision_token.to_owned(),
            observed_at: source
                .get("revisionObservedAt")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }

    let canonical_json = core_canonical_json_string(envelope)?;
    let digest = digest_bytes(canonical_json.as_bytes());
    Ok(Some(ValidatedReconciliationEnvelope {
        canonical_json,
        digest,
        source_basis,
    }))
}

/// Recompute the seven C2A durable Envelope V2 digest fields. A caller may
/// supply a syntactically valid forged digest, but it can never become a
/// persisted authority: the stable mismatch code is intentionally shared by
/// every nested field.
pub(crate) fn validate_v2_nested_digest_fields(object: &Map<String, Value>) -> anyhow::Result<()> {
    let assertion = object
        .get("assertion")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: assertion is missing"))?;
    let assertion_digests = object
        .get("assertionDigests")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: assertionDigests is missing"))?;
    let mut assertion_core_input = serde_json::json!({
        "assertionKind": assertion.get("assertionKind"),
        "payloadSchemaRef": assertion.get("payloadSchemaRef"),
        "typedSemanticPayload": assertion.get("payload"),
        "modality": assertion.get("modality"),
        "polarity": assertion.get("polarity"),
        "supportClass": assertion.get("supportClass"),
        "producer": assertion.get("producer")
    });
    // `producerConfidence` is optional in the C1 assertion shape. Match the
    // canonical object domain exactly: absent means the key is omitted, while
    // an explicitly supplied confidence participates in the digest.
    if let Some(producer_confidence) = assertion.get("producerConfidence") {
        assertion_core_input["producerConfidence"] = producer_confidence.clone();
    }
    let assertion_core = digest_json(&assertion_core_input)?;
    ensure_nested_digest(assertion_digests, "assertionCoreDigest", &assertion_core)?;
    let scope_digest = digest_json(
        assertion
            .get("scope")
            .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: assertion.scope is missing"))?,
    )?;
    ensure_nested_digest(assertion_digests, "scopeDigest", &scope_digest)?;
    let assertion_digest = digest_json(&serde_json::json!({
        "assertionCoreDigest": assertion_core,
        "scopeDigest": scope_digest
    }))?;
    ensure_nested_digest(assertion_digests, "assertionDigest", &assertion_digest)?;

    let material = object
        .get("effectiveMaterialBasis")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: effectiveMaterialBasis is missing"))?;
    let dependency_set = material
        .get("dependencySet")
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: dependencySet is missing"))?;
    let evidence_set = material
        .get("evidenceSet")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: evidenceSet is missing"))?;
    for (index, evidence) in evidence_set.iter().enumerate() {
        let evidence = evidence.as_object().ok_or_else(|| {
            anyhow!("NEX_ENVELOPE_V2_INVALID: evidenceSet entry {index} is not an object")
        })?;
        let quote = required_string(evidence, "quote")?;
        let supplied_quote_digest = required_string(evidence, "quoteDigest")?;
        ensure_sha256_digest(supplied_quote_digest, "quoteDigest")?;
        anyhow::ensure!(
            supplied_quote_digest == digest_bytes(quote.as_bytes()),
            "NEX_ENVELOPE_DIGEST_MISMATCH: quoteDigest does not match raw UTF-8 quote bytes"
        );
    }
    let dependency_digest = digest_json(dependency_set)?;
    ensure_nested_digest(material, "dependencySetDigest", &dependency_digest)?;
    let material_digest = digest_json(&serde_json::json!({
        "sourceBasis": material.get("sourceBasis"),
        "evidenceSet": material.get("evidenceSet"),
        "dependencySet": dependency_set
    }))?;
    ensure_nested_digest(material, "materialBasisDigest", &material_digest)?;

    let basis = object
        .get("revisionBasis")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: revisionBasis is missing"))?;
    let context_key = match basis.get("kind").and_then(Value::as_str) {
        Some("interpretation") => "contextSet",
        Some("human-derived") => "derivationContextSet",
        _ => "contextSet",
    };
    let context = basis
        .get(context_key)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_V2_INVALID: {context_key} is missing"))?;
    let context_digest = digest_json(&serde_json::json!({
        "version": "chronicle.context-set/1",
        "entries": context
    }))?;
    let context_digest_key = if context_key == "contextSet" {
        "contextSetDigest"
    } else {
        "derivationContextSetDigest"
    };
    ensure_nested_digest(basis, context_digest_key, &context_digest)?;
    Ok(())
}

fn ensure_nested_digest(
    object: &Map<String, Value>,
    field: &str,
    expected: &str,
) -> anyhow::Result<()> {
    let supplied = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_DIGEST_MISMATCH: {field} is missing"))?;
    ensure_sha256_digest(supplied, field)?;
    anyhow::ensure!(
        supplied == expected,
        "NEX_ENVELOPE_DIGEST_MISMATCH: {field} does not match Native recomputation"
    );
    Ok(())
}

pub(crate) fn ensure_v2_proposal_payload_digest(
    envelope: &Value,
    proposal_payload: &Value,
) -> anyhow::Result<()> {
    if envelope_schema_version(envelope) != Some(2) {
        return Ok(());
    }
    let supplied = envelope
        .pointer("/projectionBinding/proposalPayloadDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("NEX_ENVELOPE_DIGEST_MISMATCH: proposalPayloadDigest is missing"))?;
    let expected = digest_json(proposal_payload)?;
    ensure_sha256_digest(supplied, "proposalPayloadDigest")?;
    anyhow::ensure!(
        supplied == expected,
        "NEX_ENVELOPE_DIGEST_MISMATCH: proposalPayloadDigest does not match Native recomputation"
    );
    Ok(())
}

/// Validate the live revision vector at proposal/revision save time. Legacy
/// envelopes without read-set tokens remain readable for migration, while all
/// new product envelopes carry tokens and are checked before persistence.
pub(crate) fn validate_envelope_source_tokens(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    envelope: &Value,
) -> anyhow::Result<()> {
    if envelope_schema_version(envelope) == Some(2) {
        let source_basis = envelope
            .pointer("/effectiveMaterialBasis/sourceBasis")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("NEX_ENVELOPE_SOURCE_BASIS_INVALID: sourceBasis is missing"))?;
        for (index, entry) in source_basis.iter().enumerate() {
            let object = entry.as_object().ok_or_else(|| {
                anyhow!("NEX_ENVELOPE_SOURCE_BASIS_INVALID: entry {index} is not an object")
            })?;
            let source_kind = required_string(object, "sourceKind")?;
            let source_key = required_string(object, "sourceKey")?;
            let expected = required_string(object, "revisionToken")?;
            let current =
                resolve_source_revision(conn, project_id, run_id, source_kind, source_key)?;
            anyhow::ensure!(
                current.revision_token == expected,
                "NEX_READ_SET_STALE: input '{}' expected '{}' but found '{}'",
                source_key,
                expected,
                current.revision_token
            );
        }
        return Ok(());
    }
    let read_set = required_array(
        envelope
            .as_object()
            .ok_or_else(|| anyhow!("NEX_ENVELOPE_INVALID: envelope must be an object"))?,
        "readSet",
    )?;
    if read_set.is_empty() {
        return Ok(());
    }
    let strict = read_set.iter().any(|entry| {
        entry
            .as_object()
            .and_then(|object| object.get("revisionToken"))
            .is_some()
    });
    if !strict {
        return Ok(());
    }
    for (index, entry) in read_set.iter().enumerate() {
        let object = entry.as_object().ok_or_else(|| {
            anyhow!("NEX_ENVELOPE_READ_SET_INVALID: entry {index} is not an object")
        })?;
        let input_ref = required_string(object, "inputRef")?;
        let kind = required_string(object, "kind")?;
        let source_kind = optional_string(object, "sourceKind")?.unwrap_or(match kind {
            "snapshot-document" => "snapshot-document",
            "projection" => "projection",
            "evidence" => "evidence-anchor",
            "signal" => "signal",
            _ => kind,
        });
        let expected = required_string(object, "revisionToken")?;
        let current = resolve_source_revision(conn, project_id, run_id, source_kind, input_ref)?;
        anyhow::ensure!(
            current.revision_token == expected,
            "NEX_READ_SET_STALE: input '{}' expected '{}' but found '{}'",
            input_ref,
            expected,
            current.revision_token
        );
    }
    Ok(())
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

/// Match the Core validator's integer-valued JSON contract. JavaScript parses
/// `2.0` and `2e0` as the same Number as `2`; the V2 ingress must classify
/// those spellings as schema version 2 before choosing the V1/V2 path.
pub(crate) fn envelope_schema_version(value: &Value) -> Option<u64> {
    let number = value.get("schemaVersion")?.as_number()?;
    if let Some(integer) = number.as_u64() {
        return Some(integer);
    }
    let float = number.as_f64()?;
    if !float.is_finite() || float < 0.0 || float.fract() != 0.0 || float >= u64::MAX as f64 {
        return None;
    }
    Some(float as u64)
}

fn read_set_kind_for_source_kind(source_kind: &str) -> anyhow::Result<&'static str> {
    match source_kind {
        "snapshot-document" | "scene-body" => Ok("snapshot-document"),
        "projection" | "domain-projection" | "codex-catalog" => Ok("projection"),
        "evidence" | "evidence-anchor" | "narrative-artifact" | "import-capture" => Ok("evidence"),
        "signal" => Ok("signal"),
        other => Err(anyhow!(
            "NEX_ENVELOPE_SOURCE_KIND_INVALID: unsupported source kind '{other}'"
        )),
    }
}

fn source_kind_for_read_set(kind: &str) -> anyhow::Result<&'static str> {
    match kind {
        "snapshot-document" => Ok("snapshot-document"),
        "projection" => Ok("domain-projection"),
        "evidence" => Ok("evidence-anchor"),
        "signal" => anyhow::bail!(
            "NEX_SOURCE_KIND_UNSUPPORTED: signal read-set entries have no registered resolver"
        ),
        other => anyhow::bail!(
            "NEX_SOURCE_KIND_UNSUPPORTED: read-set kind '{other}' has no registered resolver"
        ),
    }
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

fn digest_json(value: &Value) -> anyhow::Result<String> {
    core_canonical_json_digest(value).context("digest canonical envelope")
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::{
        core_canonical_json_string as canonical_json_string, digest_bytes, digest_json,
        ensure_v2_proposal_payload_digest, validate_v2_nested_digest_fields,
    };
    use serde_json::{json, Value};

    const FORGED_DIGEST: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";

    fn nested_digest_fixture() -> Value {
        let producer = json!({
            "kind": "reconciler-proposal",
            "id": "chronicle.reconciler",
            "version": "1"
        });
        let semantic_payload = json!({"eventId": "event:arrival"});
        let assertion_core = digest_json(&json!({
            "assertionKind": "scene-event@1",
            "payloadSchemaRef": {"id": "narrative.chronicle.scene-event", "version": "1"},
            "typedSemanticPayload": semantic_payload.clone(),
            "modality": "modality-inference",
            "polarity": "affirmative",
            "supportClass": "direct-source",
            "producer": producer.clone()
        }))
        .expect("assertion core digest");
        let scope = json!({
            "schemaVersion": 2,
            "registryVersion": "narrative-scope/2",
            "scene": {"kind": "any"}
        });
        let scope_digest = digest_json(&scope).expect("scope digest");
        let assertion_digest = digest_json(&json!({
            "assertionCoreDigest": assertion_core.clone(),
            "scopeDigest": scope_digest.clone()
        }))
        .expect("assertion digest");
        let source_basis = json!([{
            "sourceKind": "scene",
            "sourceKey": "scene:arrival",
            "revisionToken": "rev:1"
        }]);
        let evidence_set = json!([{
            "evidenceRef": "anchor:arrival",
            "quote": "Arrival.",
            "quoteDigest": digest_bytes(b"Arrival.")
        }]);
        assert_eq!(
            digest_bytes(b"Arrival."),
            "sha256:61b3366c3dc326b93fb56073b11453dea0d2db2fe6f79588ce266188edd24c67"
        );
        let dependency_set = json!([{
            "dependencyId": "dependency:arrival",
            "inputRef": "anchor:arrival",
            "contextIds": [],
            "role": "direct-evidence",
            "selector": {"kind": "whole-source"}
        }]);
        let dependency_set_digest = digest_json(&dependency_set).expect("dependency digest");
        let material_basis_digest = digest_json(&json!({
            "sourceBasis": source_basis.clone(),
            "evidenceSet": evidence_set.clone(),
            "dependencySet": dependency_set.clone()
        }))
        .expect("material digest");
        let context_set = json!([{
            "contextId": "context:arrival",
            "inputRef": "scene:arrival",
            "stageId": "narrative_event_synthesize",
            "exposure": "model-visible",
            "selector": {"kind": "whole-source"}
        }]);
        let context_set_digest = digest_json(&json!({
            "version": "chronicle.context-set/1",
            "entries": context_set.clone()
        }))
        .expect("context digest");
        json!({
            "schemaVersion": 2,
            "assertion": {
                "assertionKind": "scene-event@1",
                "payloadSchemaRef": {"id": "narrative.chronicle.scene-event", "version": "1"},
                "payload": semantic_payload,
                "scope": scope,
                "modality": "modality-inference",
                "polarity": "affirmative",
                "supportClass": "direct-source",
                "producer": producer
            },
            "assertionDigests": {
                "assertionCoreDigest": assertion_core,
                "scopeDigest": scope_digest,
                "assertionDigest": assertion_digest
            },
            "effectiveMaterialBasis": {
                "sourceBasis": source_basis,
                "evidenceSet": evidence_set,
                "dependencySet": dependency_set,
                "dependencySetDigest": dependency_set_digest,
                "materialBasisDigest": material_basis_digest
            },
            "revisionBasis": {
                "kind": "interpretation",
                "contextSet": context_set,
                "contextSetDigest": context_set_digest
            }
        })
    }

    fn forge_digest_field(envelope: &mut Value, field: &str) {
        let slot = match field {
            "assertionCoreDigest" | "scopeDigest" | "assertionDigest" => {
                &mut envelope["assertionDigests"][field]
            }
            "dependencySetDigest" | "materialBasisDigest" => {
                &mut envelope["effectiveMaterialBasis"][field]
            }
            "quoteDigest" => &mut envelope["effectiveMaterialBasis"]["evidenceSet"][0][field],
            "contextSetDigest" => &mut envelope["revisionBasis"][field],
            other => panic!("unknown nested digest field {other}"),
        };
        *slot = Value::String(FORGED_DIGEST.to_owned());
    }

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

    #[test]
    fn native_recomputes_each_nested_envelope_digest_field() {
        for field in [
            "assertionCoreDigest",
            "scopeDigest",
            "assertionDigest",
            "dependencySetDigest",
            "materialBasisDigest",
            "quoteDigest",
            "contextSetDigest",
        ] {
            let valid = nested_digest_fixture();
            validate_v2_nested_digest_fields(valid.as_object().expect("envelope object"))
                .expect("valid nested digests");
            let mut forged = valid;
            forge_digest_field(&mut forged, field);
            let error = validate_v2_nested_digest_fields(
                forged.as_object().expect("forged envelope object"),
            )
            .expect_err("forged nested digest must fail closed");
            assert!(
                error.to_string().contains("NEX_ENVELOPE_DIGEST_MISMATCH"),
                "forged {field} returned unrelated error: {error:#}"
            );
        }
    }

    #[test]
    fn native_recomputes_proposal_payload_digest_at_private_boundary() {
        let payload = json!({"title": "Arrival"});
        let mut envelope = json!({
            "schemaVersion": 2,
            "projectionBinding": {
                "proposalPayloadDigest": digest_json(&payload).expect("payload digest")
            }
        });
        ensure_v2_proposal_payload_digest(&envelope, &payload)
            .expect("valid proposal payload digest");
        envelope["projectionBinding"]["proposalPayloadDigest"] =
            Value::String(FORGED_DIGEST.to_owned());
        let error = ensure_v2_proposal_payload_digest(&envelope, &payload)
            .expect_err("forged proposal payload digest must fail closed");
        assert!(
            error.to_string().contains("NEX_ENVELOPE_DIGEST_MISMATCH"),
            "forged proposal payload digest returned unrelated error: {error:#}"
        );
    }
}
