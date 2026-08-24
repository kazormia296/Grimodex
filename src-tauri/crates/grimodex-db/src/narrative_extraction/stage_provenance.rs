//! Typed, atomic Chronicle stage-provenance persistence (NIR-0 C2A).
//!
//! The C1 closure is an ephemeral proof supplied inside the typed dormant
//! bundle.  Native validates the complete graph and recomputes every digest,
//! then retains only the verified receipt/model-binding rows.  Generic V1
//! task completion never enters this module.

use anyhow::anyhow;
use grimodex_core::{canonical_json_digest, canonical_json_string};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::Value;
use std::{cmp::Ordering, collections::HashSet};
use uuid::Uuid;

use super::models::{
    ArtifactInput, ChronicleStageC1ExecutionBinding, ChronicleStageExecution,
    ChronicleStageGenerationMode, ChronicleStageId, ChronicleStageModelBinding,
    ChronicleStageParseStatus, ChronicleStageProvenanceClosure, ChronicleStageResolutionStatus,
    ChronicleStageTerminalReceipt, ChronicleStageTerminalStatus,
};

const CLOSURE_ARTIFACT_KIND: &str = "chronicle.stage-provenance-closure@1";
const CLOSURE_KIND: &str = "chronicle-stage-provenance-closure";
const MODEL_BINDING_KIND: &str = "chronicle-stage-model-binding";
const TERMINAL_RECEIPT_KIND: &str = "chronicle-stage-terminal-receipt";
const MODEL_BINDING_DOMAIN: &str = "chronicle-stage-model-binding/1";
const TERMINAL_RECEIPT_DOMAIN: &str = "chronicle-stage-terminal-receipt/1";
const CLOSURE_DOMAIN: &str = "chronicle-stage-provenance-closure/1";
const OBSERVATION_STAGE_ID: &str = "narrative_observation_extract";
const SYNTHESIS_STAGE_ID: &str = "narrative_event_synthesize";
const REPAIR_STAGE_ID: &str = "narrative_structured_repair";
const CHRONICLE_EVENT_SYNTHESIS_OUTPUT_KIND: &str = "chronicle.event-synthesis-output@1";
const CHRONICLE_RAW_OBSERVATIONS_KIND: &str = "chronicle.raw-observations@1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleEventSynthesisOutputShape {
    kind: String,
    observation_count: u64,
    event_count: u64,
    observation_refs: Vec<String>,
    stage_provenance_closure_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleRawObservationsShape {
    kind: String,
    version: u64,
    observations: Vec<ChronicleRawObservationShape>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleRawObservationShape {
    local_id: String,
    evidence: Vec<ChronicleRawEvidenceShape>,
    assertion: ChronicleRawAssertionShape,
    payload: ChronicleRawPayloadShape,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleRawEvidenceShape {
    source_ref: String,
    quote: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleRawAssertionShape {
    attribution: String,
    narrative_frame: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleRawPayloadShape {
    predicate: String,
    #[serde(default)]
    semantic_type: Option<String>,
    actuality: String,
    participants: Vec<ChronicleRawParticipantShape>,
    #[serde(default)]
    location_surface: Option<String>,
    temporal_expressions: Vec<String>,
    duration_kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleRawParticipantShape {
    surface: String,
    role: String,
}

/// Generic/V1 finish remains available, but cannot persist reserved C2A
/// output/artifact kinds without the explicit typed companion.
pub(crate) fn reject_reserved_chronicle_stage_bundle(
    output_json: &Value,
    artifacts: &[ArtifactInput],
) -> anyhow::Result<()> {
    let output_reserved = output_json
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == CHRONICLE_EVENT_SYNTHESIS_OUTPUT_KIND);
    let artifact_reserved = artifacts.iter().any(|artifact| {
        matches!(
            artifact.artifact_kind.as_str(),
            CLOSURE_ARTIFACT_KIND | CHRONICLE_RAW_OBSERVATIONS_KIND
        )
    });
    anyhow::ensure!(
        !output_reserved && !artifact_reserved,
        "NEX_CHRONICLE_STAGE_BUNDLE_REQUIRED: reserved Chronicle stage output/artifacts require chronicleStageBundle"
    );
    Ok(())
}

/// Validate output + durable raw-observation companion.  The closure is a
/// typed ephemeral field, never an ArtifactInput, so no closure JSON can be
/// accidentally retained by the generic artifact writer.
pub(crate) fn validate_chronicle_synthesis_companion(
    output_json: &Value,
    artifacts: &[ArtifactInput],
    closure: &ChronicleStageProvenanceClosure,
) -> anyhow::Result<()> {
    let output: ChronicleEventSynthesisOutputShape = serde_json::from_value(output_json.clone())
        .map_err(|error| {
            anyhow!("NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: typed output shape: {error}")
        })?;
    anyhow::ensure!(
        output.kind == CHRONICLE_EVENT_SYNTHESIS_OUTPUT_KIND
            && output.observation_count > 0
            && output.event_count > 0
            && !output.observation_refs.is_empty(),
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: kind/count contract is invalid"
    );
    ensure_digest(
        &output.stage_provenance_closure_digest,
        "stageProvenanceClosureDigest",
    )?;
    let mut raw_observations: Option<&ArtifactInput> = None;
    for artifact in artifacts {
        anyhow::ensure!(
            artifact.artifact_kind != CLOSURE_ARTIFACT_KIND,
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: closure is an ephemeral typed bundle field, not a durable artifact"
        );
        anyhow::ensure!(
            artifact.artifact_kind == CHRONICLE_RAW_OBSERVATIONS_KIND,
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: exactly one durable artifact of kind chronicle.raw-observations@1 is required"
        );
        if artifact.artifact_kind == CHRONICLE_RAW_OBSERVATIONS_KIND {
            anyhow::ensure!(
                raw_observations.replace(artifact).is_none(),
                "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: more than one raw observation artifact"
            );
        }
    }
    let raw_observations = raw_observations.ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_MISSING: raw observation artifact is required")
    })?;
    anyhow::ensure!(
        closure.stage_provenance_closure_digest == output.stage_provenance_closure_digest,
        "NEX_CHRONICLE_SYNTHESIS_CLOSURE_DIGEST_MISMATCH: output closure digest does not match typed closure"
    );
    let raw_value = raw_observations.payload_json.as_ref().ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: raw observation payload is missing")
    })?;
    let raw_digest = raw_observations.payload_digest.as_deref().ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: raw observation payloadDigest is required")
    })?;
    ensure_digest(raw_digest, "raw observation payloadDigest")?;
    anyhow::ensure!(
        raw_digest == canonical_json_digest(raw_value)?,
        "NEX_CHRONICLE_RAW_OBSERVATIONS_DIGEST_MISMATCH: raw observation payload digest differs from Native recomputation"
    );
    let raw: ChronicleRawObservationsShape =
        serde_json::from_value(raw_value.clone()).map_err(|error| {
            anyhow!("NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: typed artifact shape: {error}")
        })?;
    anyhow::ensure!(
        raw.kind == CHRONICLE_RAW_OBSERVATIONS_KIND && raw.version == 1,
        "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: unsupported artifact kind/version"
    );
    anyhow::ensure!(
        !raw.observations.is_empty(),
        "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: observations must not be empty"
    );
    anyhow::ensure!(
        output.observation_count == raw.observations.len() as u64,
        "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: observationCount does not match raw observations"
    );
    let mut observation_ids = HashSet::new();
    for observation in &raw.observations {
        anyhow::ensure!(
            !observation.local_id.trim().is_empty()
                && observation_ids.insert(&observation.local_id),
            "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: localId must be non-empty and unique"
        );
        anyhow::ensure!(
            !observation.evidence.is_empty()
                && observation.evidence.iter().all(|evidence| {
                    !evidence.source_ref.trim().is_empty() && !evidence.quote.trim().is_empty()
                }),
            "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: evidence must contain sourceRef and quote"
        );
        anyhow::ensure!(
            (!observation.assertion.attribution.trim().is_empty()
                && (observation.assertion.attribution == "narrator"
                    || observation.assertion.attribution == "unknown"
                    || observation.assertion.attribution.starts_with("character:")
                        && observation.assertion.attribution.len() > "character:".len()))
                && matches!(
                    observation.assertion.narrative_frame.as_str(),
                    "story-world" | "flashback" | "dream" | "reported" | "hypothetical" | "unknown"
                ),
            "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: assertion attribution/frame are required"
        );
        anyhow::ensure!(
            !observation.payload.predicate.trim().is_empty()
                && matches!(
                    observation.payload.actuality.as_str(),
                    "actual" | "attempted" | "prevented"
                )
                && matches!(
                    observation.payload.duration_kind.as_str(),
                    "instant" | "bounded-interval" | "ongoing-process" | "unknown"
                )
                && observation.payload.participants.iter().all(|participant| {
                    !participant.surface.trim().is_empty() && !participant.role.trim().is_empty()
                })
                && observation
                    .payload
                    .temporal_expressions
                    .iter()
                    .all(|expression| !expression.trim().is_empty())
                && observation
                    .payload
                    .semantic_type
                    .as_deref()
                    .is_none_or(|value| !value.trim().is_empty())
                && observation
                    .payload
                    .location_surface
                    .as_deref()
                    .is_none_or(|value| !value.trim().is_empty()),
            "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: payload fields are malformed"
        );
    }
    let mut output_refs = HashSet::new();
    anyhow::ensure!(
        output.observation_refs.len() == observation_ids.len(),
        "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: observationRefs must have the same cardinality as raw localIds"
    );
    anyhow::ensure!(
        output.observation_refs.iter().all(|reference| {
            !reference.trim().is_empty()
                && observation_ids.contains(reference)
                && output_refs.insert(reference)
        }),
        "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: synthesis observationRefs must resolve to raw localIds"
    );
    Ok(())
}

/// Typed dormant C2A stage persistence.  The task kind check is intentionally
/// narrow; no production V2 activation path calls this function.
#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_chronicle_stage_bundle(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    binding: &ChronicleStageC1ExecutionBinding,
    output_json: &Value,
    artifacts: &[ArtifactInput],
) -> anyhow::Result<()> {
    let task_kind: String = conn.query_row(
        "SELECT task_kind
           FROM narrative_extraction_tasks
          WHERE id = ?1 AND run_id = ?2",
        params![task_id, run_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        task_kind == "chronicle.plan-proposals@1",
        "NEX_CHRONICLE_STAGE_BUNDLE_TASK_KIND: typed C2A stage bundle requires chronicle.plan-proposals@1"
    );
    for (field, actual, expected) in [
        ("projectId", binding.project_id.as_str(), project_id),
        ("runId", binding.run_id.as_str(), run_id),
        ("taskId", binding.task_id.as_str(), task_id),
        ("attemptId", binding.attempt_id.as_str(), attempt_id),
    ] {
        anyhow::ensure!(
            actual == expected,
            "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_MISMATCH: {field} does not match finish owner"
        );
    }
    for (field, digest) in [
        ("contextSetDigest", binding.context_set_digest.as_str()),
        (
            "componentContractDigest",
            binding.component_contract_digest.as_str(),
        ),
        ("finalRequestDigest", binding.final_request_digest.as_str()),
        (
            "stageProvenanceClosureDigest",
            binding.stage_provenance_closure_digest.as_str(),
        ),
    ] {
        ensure_digest(digest, field)?;
    }
    // The reserved raw-observation artifact has a Chronicle-specific digest
    // contract. Validate that domain companion first so malformed Chronicle
    // input cannot be reclassified as a generic artifact failure.
    validate_chronicle_synthesis_companion(output_json, artifacts, &binding.closure)?;
    for artifact in artifacts {
        validate_artifact_digest(artifact)?;
    }
    anyhow::ensure!(
        binding.closure.stage_provenance_closure_digest
            == binding.stage_provenance_closure_digest,
        "NEX_CHRONICLE_SYNTHESIS_CLOSURE_DIGEST_MISMATCH: trusted binding does not match typed closure"
    );
    validate_owner_execution_digests(&binding.closure, binding)?;
    persist_stage_bundle_if_present(
        conn,
        project_id,
        run_id,
        task_id,
        attempt_id,
        &binding.closure,
    )
}

fn validate_owner_execution_digests(
    closure: &ChronicleStageProvenanceClosure,
    binding: &ChronicleStageC1ExecutionBinding,
) -> anyhow::Result<()> {
    let owner_roots = closure
        .receipts
        .iter()
        .filter(|receipt| {
            let execution = &receipt.stage_execution;
            matches!(
                &execution.stage_id,
                ChronicleStageId::NarrativeEventSynthesize
            ) && execution.parent_stage_execution_id.is_none()
                && execution.project_id == binding.project_id
                && execution.run_id == binding.run_id
                && execution.task_id == binding.task_id
                && execution.attempt_id == binding.attempt_id
        })
        .collect::<Vec<_>>();
    anyhow::ensure!(
        !owner_roots.is_empty(),
        "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_MISSING: closure lacks the bound owner synthesis receipt"
    );
    let digest_matched_roots = owner_roots
        .iter()
        .filter(|receipt| {
            receipt.context_set_digest == binding.context_set_digest
                && receipt.component_contract_digest == binding.component_contract_digest
                && receipt.final_request_digest == binding.final_request_digest
        })
        .copied()
        .collect::<Vec<_>>();
    anyhow::ensure!(
        !digest_matched_roots.is_empty(),
        "NEX_CHRONICLE_STAGE_BUNDLE_DIGEST_MISMATCH: owner synthesis C1 digests do not match trusted execution binding"
    );
    let owner_synthesis =
        digest_matched_roots
            .iter()
            .any(|root| match (&root.parse_status, &root.terminal_status) {
                (ChronicleStageParseStatus::Parsed, ChronicleStageTerminalStatus::Succeeded) => {
                    true
                }
                (ChronicleStageParseStatus::Invalid, ChronicleStageTerminalStatus::Failed) => {
                    closure.receipts.iter().any(|child| {
                        child.stage_execution.stage_id
                            == ChronicleStageId::NarrativeStructuredRepair
                            && child.stage_execution.parent_stage_execution_id.as_deref()
                                == Some(root.stage_execution.stage_execution_id.as_str())
                            && child.stage_execution.project_id == root.stage_execution.project_id
                            && child.stage_execution.run_id == root.stage_execution.run_id
                            && child.stage_execution.task_id == root.stage_execution.task_id
                            && child.stage_execution.attempt_id == root.stage_execution.attempt_id
                            && matches!(
                                (&child.parse_status, &child.terminal_status),
                                (
                                    ChronicleStageParseStatus::Parsed,
                                    ChronicleStageTerminalStatus::Succeeded
                                )
                            )
                    })
                }
                _ => false,
            });
    anyhow::ensure!(
        owner_synthesis,
        "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_PATH_MISMATCH: bound owner synthesis receipt has no successful terminal path"
    );
    Ok(())
}

pub(crate) fn persist_stage_bundle_if_present(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    closure: &ChronicleStageProvenanceClosure,
) -> anyhow::Result<()> {
    validate_closure_shape(project_id, run_id, task_id, attempt_id, closure)?;
    let created_at = grimodex_core::now_rfc3339_millis();
    for receipt in &closure.receipts {
        persist_receipt(conn, project_id, run_id, receipt, &created_at)?;
    }
    // Closure JSON is an ephemeral proof.  Only verified receipt/model
    // binding rows survive this transaction.
    Ok(())
}

fn validate_artifact_digest(artifact: &ArtifactInput) -> anyhow::Result<()> {
    let Some(payload) = artifact.payload_json.as_ref() else {
        return Ok(());
    };
    if let Some(supplied) = artifact.payload_digest.as_deref() {
        let expected = canonical_json_digest(payload)?;
        anyhow::ensure!(
            supplied == expected,
            "NEX_STAGE_ARTIFACT_DIGEST_MISMATCH: artifact '{}' payload digest differs from Native recomputation",
            artifact.artifact_kind
        );
    }
    Ok(())
}

fn validate_closure_shape(
    project_id: &str,
    run_id: &str,
    owner_task_id: &str,
    owner_attempt_id: &str,
    closure: &ChronicleStageProvenanceClosure,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        closure.kind == CLOSURE_KIND && closure.version == 1,
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: unsupported closure kind/version"
    );
    for (field, actual, expected) in [
        ("projectId", closure.project_id.as_str(), project_id),
        ("runId", closure.run_id.as_str(), run_id),
        ("ownerTaskId", closure.owner_task_id.as_str(), owner_task_id),
        (
            "ownerAttemptId",
            closure.owner_attempt_id.as_str(),
            owner_attempt_id,
        ),
    ] {
        anyhow::ensure!(
            !actual.trim().is_empty() && actual == expected,
            "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: {field} does not match task owner"
        );
    }
    anyhow::ensure!(
        !closure.receipts.is_empty(),
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: closure must contain terminal receipts"
    );
    anyhow::ensure!(
        closure.receipt_refs.len() == closure.receipts.len(),
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: receiptRefs length differs from receipts"
    );

    let mut validated_receipts = Vec::with_capacity(closure.receipts.len());
    let mut seen_execution_ids = HashSet::new();
    let mut seen_receipt_digests = HashSet::new();
    for receipt in &closure.receipts {
        let validated = validate_receipt(project_id, run_id, receipt)?;
        anyhow::ensure!(
            seen_execution_ids.insert(validated.stage_execution_id.clone()),
            "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: duplicate stage execution ID"
        );
        anyhow::ensure!(
            seen_receipt_digests.insert(validated.receipt_digest.clone()),
            "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: duplicate receipt digest"
        );
        validated_receipts.push(validated);
    }
    anyhow::ensure!(
        validated_receipts.windows(2).all(|window| {
            compare_code_units(&window[0].stage_execution_id, &window[1].stage_execution_id)
                != Ordering::Greater
        }),
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: receipts must use canonical stageExecutionId order"
    );
    let mut expected_refs = validated_receipts
        .iter()
        .map(|receipt| {
            (
                receipt.stage_execution_id.clone(),
                receipt.receipt_digest.clone(),
            )
        })
        .collect::<Vec<_>>();
    expected_refs.sort_by(|left, right| {
        compare_code_units(&left.0, &right.0).then_with(|| compare_code_units(&left.1, &right.1))
    });
    let actual_refs = closure
        .receipt_refs
        .iter()
        .map(|reference| {
            ensure_digest(
                &reference.stage_execution_receipt_digest,
                "stageExecutionReceiptDigest",
            )?;
            Ok((
                reference.stage_execution_id.clone(),
                reference.stage_execution_receipt_digest.clone(),
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        actual_refs.windows(2).all(|window| {
            compare_code_units(&window[0].0, &window[1].0)
                .then_with(|| compare_code_units(&window[0].1, &window[1].1))
                != Ordering::Greater
        }),
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: receipt refs are noncanonical"
    );
    anyhow::ensure!(
        actual_refs == expected_refs,
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: receiptRefs do not match receipts"
    );

    for receipt in &validated_receipts {
        let Some(parent_id) = receipt.parent_stage_execution_id.as_deref() else {
            anyhow::ensure!(
                receipt.stage_id != REPAIR_STAGE_ID,
                "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: structured repair requires a parent receipt"
            );
            continue;
        };
        anyhow::ensure!(
            receipt.stage_id == REPAIR_STAGE_ID && parent_id != receipt.stage_execution_id,
            "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: only structured repair may declare a distinct parent"
        );
        let parent = validated_receipts
            .iter()
            .find(|candidate| candidate.stage_execution_id == parent_id)
            .ok_or_else(|| {
                anyhow!("NEX_STAGE_PROVENANCE_CLOSURE_INVALID: repair parent receipt is missing")
            })?;
        anyhow::ensure!(
            parent.task_id == receipt.task_id && parent.attempt_id == receipt.attempt_id,
            "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: repair parent must share task and attempt"
        );
        anyhow::ensure!(
            (parent.stage_id == OBSERVATION_STAGE_ID || parent.stage_id == SYNTHESIS_STAGE_ID)
                && parent.parse_status == "invalid"
                && parent.terminal_status == "failed",
            "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: repair parent must be a failed invalid root"
        );
    }
    let has_observation =
        has_successful_stage_path(&validated_receipts, OBSERVATION_STAGE_ID, None, None);
    let has_synthesis = has_successful_stage_path(
        &validated_receipts,
        SYNTHESIS_STAGE_ID,
        Some(owner_task_id),
        Some(owner_attempt_id),
    );
    anyhow::ensure!(
        has_observation && has_synthesis,
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: observation and synthesis require a successful root or repair child"
    );

    ensure_digest(
        &closure.stage_provenance_closure_digest,
        "stageProvenanceClosureDigest",
    )?;
    let encoded = serde_json::to_value(closure)?;
    let expected = canonical_json_digest(&serde_json::json!({
        "domain": CLOSURE_DOMAIN,
        "projectId": encoded["projectId"],
        "runId": encoded["runId"],
        "ownerTaskId": encoded["ownerTaskId"],
        "ownerAttemptId": encoded["ownerAttemptId"],
        "receipts": encoded["receipts"],
        "receiptRefs": encoded["receiptRefs"]
    }))?;
    anyhow::ensure!(
        closure.stage_provenance_closure_digest == expected,
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: stage provenance closure digest mismatch"
    );
    Ok(())
}

fn compare_code_units(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn has_successful_stage_path(
    receipts: &[ValidatedReceipt],
    stage_id: &str,
    owner_task_id: Option<&str>,
    owner_attempt_id: Option<&str>,
) -> bool {
    receipts.iter().any(|root| {
        root.stage_id == stage_id
            && root.parent_stage_execution_id.is_none()
            && owner_task_id.is_none_or(|task_id| root.task_id == task_id)
            && owner_attempt_id.is_none_or(|attempt_id| root.attempt_id == attempt_id)
            && ((root.parse_status == "parsed" && root.terminal_status == "succeeded")
                || (root.parse_status == "invalid"
                    && root.terminal_status == "failed"
                    && receipts.iter().any(|child| {
                        child.stage_id == REPAIR_STAGE_ID
                            && child.parent_stage_execution_id.as_deref()
                                == Some(root.stage_execution_id.as_str())
                            && child.parse_status == "parsed"
                            && child.terminal_status == "succeeded"
                    })))
    })
}

#[derive(Debug)]
struct ValidatedReceipt {
    stage_id: String,
    task_id: String,
    attempt_id: String,
    stage_execution_id: String,
    parent_stage_execution_id: Option<String>,
    parse_status: String,
    terminal_status: String,
    receipt_digest: String,
}

fn validate_receipt(
    project_id: &str,
    run_id: &str,
    receipt: &ChronicleStageTerminalReceipt,
) -> anyhow::Result<ValidatedReceipt> {
    anyhow::ensure!(
        receipt.kind == TERMINAL_RECEIPT_KIND && receipt.version == 1,
        "NEX_STAGE_TERMINAL_RECEIPT_INVALID: unsupported terminal receipt kind/version"
    );
    validate_stage_execution(&receipt.stage_execution)?;
    anyhow::ensure!(
        receipt.stage_execution.project_id == project_id
            && receipt.stage_execution.run_id == run_id,
        "NEX_STAGE_TERMINAL_RECEIPT_INVALID: stage execution owner mismatch"
    );
    anyhow::ensure!(
        !receipt.context_set_version.trim().is_empty()
            && receipt.context_set_version == receipt.context_set_version.trim(),
        "NEX_STAGE_TERMINAL_RECEIPT_INVALID: contextSetVersion must be trimmed"
    );
    for (field, digest) in [
        ("contextSetDigest", receipt.context_set_digest.as_str()),
        (
            "componentContractDigest",
            receipt.component_contract_digest.as_str(),
        ),
        ("finalRequestDigest", receipt.final_request_digest.as_str()),
        ("modelBindingDigest", receipt.model_binding_digest.as_str()),
        (
            "stageExecutionReceiptDigest",
            receipt.stage_execution_receipt_digest.as_str(),
        ),
    ] {
        ensure_digest(digest, field)?;
    }
    if let Some(response_digest) = receipt.response_digest.as_deref() {
        ensure_digest(response_digest, "responseDigest")?;
    }
    validate_status_pair(receipt)?;
    validate_model_binding(&receipt.model_execution_binding)?;
    let binding_value = serde_json::to_value(&receipt.model_execution_binding)?;
    let expected_binding_digest = canonical_json_digest(&serde_json::json!({
        "domain": MODEL_BINDING_DOMAIN,
        "binding": binding_value
    }))?;
    anyhow::ensure!(
        receipt.model_binding_digest == expected_binding_digest,
        "NEX_STAGE_MODEL_BINDING_DIGEST_MISMATCH: model binding digest mismatch"
    );
    let execution_value = serde_json::to_value(&receipt.stage_execution)?;
    let expected_receipt_digest = canonical_json_digest(&serde_json::json!({
        "domain": TERMINAL_RECEIPT_DOMAIN,
        "stageExecution": execution_value,
        "contextSetVersion": receipt.context_set_version,
        "contextSetDigest": receipt.context_set_digest,
        "componentContractDigest": receipt.component_contract_digest,
        "finalRequestDigest": receipt.final_request_digest,
        "modelBindingDigest": receipt.model_binding_digest,
        "responseDigest": receipt.response_digest,
        "parseStatus": parse_status_name(&receipt.parse_status),
        "terminalStatus": terminal_status_name(&receipt.terminal_status)
    }))?;
    anyhow::ensure!(
        receipt.stage_execution_receipt_digest == expected_receipt_digest,
        "NEX_STAGE_TERMINAL_RECEIPT_DIGEST_MISMATCH: terminal receipt digest mismatch"
    );
    Ok(ValidatedReceipt {
        stage_id: stage_id_name(&receipt.stage_execution.stage_id).to_owned(),
        task_id: receipt.stage_execution.task_id.clone(),
        attempt_id: receipt.stage_execution.attempt_id.clone(),
        stage_execution_id: receipt.stage_execution.stage_execution_id.clone(),
        parent_stage_execution_id: receipt.stage_execution.parent_stage_execution_id.clone(),
        parse_status: parse_status_name(&receipt.parse_status).to_owned(),
        terminal_status: terminal_status_name(&receipt.terminal_status).to_owned(),
        receipt_digest: receipt.stage_execution_receipt_digest.clone(),
    })
}

fn validate_status_pair(receipt: &ChronicleStageTerminalReceipt) -> anyhow::Result<()> {
    let valid = matches!(
        (
            &receipt.parse_status,
            &receipt.terminal_status,
            receipt.response_digest.is_some(),
        ),
        (
            ChronicleStageParseStatus::Parsed,
            ChronicleStageTerminalStatus::Succeeded,
            true
        ) | (
            ChronicleStageParseStatus::Invalid,
            ChronicleStageTerminalStatus::Failed,
            true
        ) | (
            ChronicleStageParseStatus::NotAttempted,
            ChronicleStageTerminalStatus::Failed,
            false
        ) | (
            ChronicleStageParseStatus::NotAttempted,
            ChronicleStageTerminalStatus::Cancelled,
            false
        ) | (
            ChronicleStageParseStatus::NotAttempted,
            ChronicleStageTerminalStatus::Skipped,
            false
        )
    );
    anyhow::ensure!(
        valid,
        "NEX_STAGE_TERMINAL_RECEIPT_INVALID: parseStatus and terminalStatus are inconsistent"
    );
    Ok(())
}

fn persist_receipt(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    receipt: &ChronicleStageTerminalReceipt,
    created_at: &str,
) -> anyhow::Result<()> {
    let binding_json =
        canonical_json_string(&serde_json::to_value(&receipt.model_execution_binding)?)?;
    let receipt_json = canonical_json_string(&serde_json::to_value(receipt)?)?;
    let execution = &receipt.stage_execution;
    conn.execute(
        "INSERT INTO narrative_extraction_stage_model_bindings
            (id, project_id, run_id, task_id, attempt_id, stage_execution_id,
             binding_json, binding_digest, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            Uuid::new_v4().to_string(),
            project_id,
            run_id,
            execution.task_id,
            execution.attempt_id,
            execution.stage_execution_id,
            binding_json,
            receipt.model_binding_digest,
            created_at,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_stage_receipts
            (id, project_id, run_id, task_id, attempt_id, stage_execution_id,
             receipt_json, receipt_digest, model_binding_digest, terminal_status,
             created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            Uuid::new_v4().to_string(),
            project_id,
            run_id,
            execution.task_id,
            execution.attempt_id,
            execution.stage_execution_id,
            receipt_json,
            receipt.stage_execution_receipt_digest,
            receipt.model_binding_digest,
            terminal_status_name(&receipt.terminal_status),
            created_at,
        ],
    )?;
    Ok(())
}

fn ensure_digest(value: &str, field: &str) -> anyhow::Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        anyhow::bail!("NEX_STAGE_DIGEST_INVALID: {field} must use sha256:<hex>");
    };
    anyhow::ensure!(
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
        "NEX_STAGE_DIGEST_INVALID: {field} must contain 64 lowercase hexadecimal characters"
    );
    Ok(())
}

fn validate_stage_execution(execution: &ChronicleStageExecution) -> anyhow::Result<()> {
    for (field, value) in [
        ("projectId", execution.project_id.as_str()),
        ("runId", execution.run_id.as_str()),
        ("taskId", execution.task_id.as_str()),
        ("attemptId", execution.attempt_id.as_str()),
        ("stageExecutionId", execution.stage_execution_id.as_str()),
    ] {
        anyhow::ensure!(
            !value.trim().is_empty() && value == value.trim(),
            "NEX_STAGE_TERMINAL_RECEIPT_INVALID: {field} must be non-empty and trimmed"
        );
    }
    if let Some(parent) = execution.parent_stage_execution_id.as_deref() {
        anyhow::ensure!(
            !parent.trim().is_empty() && parent == parent.trim(),
            "NEX_STAGE_TERMINAL_RECEIPT_INVALID: parentStageExecutionId must be non-empty and trimmed"
        );
    }
    anyhow::ensure!(
        match &execution.stage_id {
            ChronicleStageId::NarrativeStructuredRepair => {
                execution.parent_stage_execution_id.is_some()
            }
            ChronicleStageId::NarrativeObservationExtract
            | ChronicleStageId::NarrativeEventSynthesize => {
                execution.parent_stage_execution_id.is_none()
            }
        },
        "NEX_STAGE_TERMINAL_RECEIPT_INVALID: repair parent field does not match stage ID"
    );
    Ok(())
}

fn validate_model_binding(binding: &ChronicleStageModelBinding) -> anyhow::Result<()> {
    anyhow::ensure!(
        binding.kind == MODEL_BINDING_KIND && binding.version == 1,
        "NEX_STAGE_MODEL_BINDING_INVALID: unsupported model binding kind/version"
    );
    for (field, value, endpoint) in [
        ("provider", binding.provider.as_deref(), false),
        (
            "endpointBindingId",
            binding.endpoint_binding_id.as_deref(),
            true,
        ),
        ("requestedModel", binding.requested_model.as_deref(), false),
        ("effectiveModel", binding.effective_model.as_deref(), false),
        (
            "modelFingerprint",
            binding.model_fingerprint.as_deref(),
            false,
        ),
        ("apiVariant", binding.api_variant.as_deref(), false),
        ("reasoningMode", binding.reasoning_mode.as_deref(), false),
    ] {
        if let Some(value) = value {
            ensure_safe_model_identity(value, field, endpoint)?;
            if endpoint {
                anyhow::ensure!(
                    is_sha256_digest(value)
                        || (!value.contains('/')
                            && !value.contains('\\')
                            && !value.contains('@')),
                    "NEX_STAGE_MODEL_BINDING_INVALID: endpointBindingId must be a stable identifier"
                );
            }
        }
    }
    match &binding.resolution_status {
        ChronicleStageResolutionStatus::Fingerprinted => anyhow::ensure!(
            binding.provider.is_some()
                && binding.model_fingerprint.is_some()
                && (binding.requested_model.is_some() || binding.effective_model.is_some()),
            "NEX_STAGE_MODEL_BINDING_INVALID: fingerprinted binding lacks provider/model/fingerprint"
        ),
        ChronicleStageResolutionStatus::ProviderReported => anyhow::ensure!(
            binding.provider.is_some()
                && binding.effective_model.is_some()
                && binding.model_fingerprint.is_none(),
            "NEX_STAGE_MODEL_BINDING_INVALID: provider-reported binding is inconsistent"
        ),
        ChronicleStageResolutionStatus::RequestedOnly => anyhow::ensure!(
            binding.provider.is_some()
                && binding.requested_model.is_some()
                && binding.effective_model.is_none()
                && binding.model_fingerprint.is_none(),
            "NEX_STAGE_MODEL_BINDING_INVALID: requested-only binding is inconsistent"
        ),
        ChronicleStageResolutionStatus::Unresolved => anyhow::ensure!(
            binding.provider.is_none()
                && binding.endpoint_binding_id.is_none()
                && binding.requested_model.is_none()
                && binding.effective_model.is_none()
                && binding.model_fingerprint.is_none()
                && binding.api_variant.is_none()
                && binding.reasoning_mode.is_none()
                && matches!(
                    &binding.generation_mode,
                    ChronicleStageGenerationMode::ProviderDefault
                ),
            "NEX_STAGE_MODEL_BINDING_INVALID: unresolved binding is inconsistent"
        ),
    }
    Ok(())
}

fn stage_id_name(value: &ChronicleStageId) -> &'static str {
    match value {
        ChronicleStageId::NarrativeObservationExtract => OBSERVATION_STAGE_ID,
        ChronicleStageId::NarrativeEventSynthesize => SYNTHESIS_STAGE_ID,
        ChronicleStageId::NarrativeStructuredRepair => REPAIR_STAGE_ID,
    }
}

fn parse_status_name(value: &ChronicleStageParseStatus) -> &'static str {
    match value {
        ChronicleStageParseStatus::Parsed => "parsed",
        ChronicleStageParseStatus::Invalid => "invalid",
        ChronicleStageParseStatus::NotAttempted => "not-attempted",
    }
}

fn terminal_status_name(value: &ChronicleStageTerminalStatus) -> &'static str {
    match value {
        ChronicleStageTerminalStatus::Succeeded => "succeeded",
        ChronicleStageTerminalStatus::Failed => "failed",
        ChronicleStageTerminalStatus::Cancelled => "cancelled",
        ChronicleStageTerminalStatus::Skipped => "skipped",
    }
}

fn ensure_safe_model_identity(value: &str, field: &str, endpoint: bool) -> anyhow::Result<()> {
    anyhow::ensure!(
        value == value.trim()
            && !value.is_empty()
            && value.len() <= 512
            && !value.bytes().any(|byte| byte.is_ascii_control()),
        "NEX_STAGE_MODEL_BINDING_INVALID: {field} must be a safe identity token"
    );
    anyhow::ensure!(
        !has_uri_or_origin_shape(value) && !has_credential_shape(value),
        "NEX_STAGE_MODEL_BINDING_INVALID: {field} must not contain a URL, origin, or credential-shaped value"
    );
    if endpoint {
        anyhow::ensure!(
            is_sha256_digest(value) || is_uuid(value) || is_named_endpoint_id(value),
            "NEX_STAGE_MODEL_BINDING_INVALID: endpointBindingId must be a stable identifier or digest"
        );
    }
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .filter(|(index, _)| ![8, 13, 18, 23].contains(index))
            .all(|(_, byte)| byte.is_ascii_hexdigit())
        && matches!(bytes[14], b'1'..=b'5')
        && matches!(bytes[19], b'8'..=b'9' | b'a'..=b'b' | b'A'..=b'B')
}

fn is_named_endpoint_id(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
        && value.len() <= 128
        && chars
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn has_uri_or_origin_shape(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let known_schemes = [
        "http",
        "https",
        "ws",
        "wss",
        "ftp",
        "file",
        "data",
        "urn",
        "javascript",
        "ssh",
        "mailto",
        "blob",
        "about",
    ];
    for scheme in known_schemes {
        let needle = format!("{scheme}:");
        if lower
            .match_indices(&needle)
            .any(|(index, _)| index == 0 || !lower.as_bytes()[index - 1].is_ascii_alphanumeric())
        {
            return true;
        }
    }
    has_unsafe_identity_host(value)
}

fn has_unsafe_identity_host(value: &str) -> bool {
    let normalized = value
        .replace("%2e", ".")
        .replace("%2E", ".")
        .replace(['\u{3002}', '\u{FF0E}', '\u{FF61}'], ".");
    let candidates = [
        normalized.as_str(),
        normalized.rsplit_once('@').map_or("", |(_, host)| host),
    ];
    candidates.iter().any(|candidate| {
        if candidate.is_empty() {
            return false;
        }
        let authority = candidate.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.is_empty() {
            return false;
        }
        if authority.starts_with('[') {
            return authority.contains(']');
        }
        if authority.matches(':').count() >= 2 {
            return true;
        }
        let host = authority
            .rsplit_once(':')
            .filter(|(_, port)| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
            .map_or(authority, |(host, _)| host);
        if host.ends_with('.') || host.eq_ignore_ascii_case("localhost") || is_numeric_host(host) {
            return true;
        }
        let labels = host.split('.').collect::<Vec<_>>();
        labels.len() >= 2
            && labels.iter().all(|label| !label.is_empty())
            && labels.last().is_some_and(|label| {
                label.chars().next().is_some_and(|character| {
                    character.is_ascii_alphabetic() || !character.is_ascii()
                })
            })
    })
}

fn is_numeric_host(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        return true;
    }
    if value.len() > 2
        && value.as_bytes()[..2].eq_ignore_ascii_case(b"0x")
        && value.as_bytes()[2..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return true;
    }
    let labels = value.split('.').collect::<Vec<_>>();
    labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && (label.bytes().all(|byte| byte.is_ascii_digit())
                    || (label.len() > 2
                        && label.as_bytes()[..2].eq_ignore_ascii_case(b"0x")
                        && label.as_bytes()[2..]
                            .iter()
                            .all(|byte| byte.is_ascii_hexdigit())))
        })
}

fn has_credential_shape(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    for prefix in [
        "sk-",
        "ghp_",
        "github_pat_",
        "glpat-",
        "hf_",
        "xox",
        "akia",
        "aiza",
    ] {
        let mut search_from = 0;
        while let Some(relative) = lower[search_from..].find(prefix) {
            let index = search_from + relative;
            let boundary = index == 0 || !lower.as_bytes()[index - 1].is_ascii_alphanumeric();
            let minimum = if matches!(prefix, "akia") {
                12
            } else if matches!(prefix, "aiza") {
                16
            } else {
                8
            };
            let suffix = &lower[index + prefix.len()..];
            let token_len = suffix
                .bytes()
                .take_while(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'_' | b'-' | b'.' | b'~' | b'+' | b'/')
                })
                .count();
            if boundary && token_len >= minimum {
                return true;
            }
            search_from = index + prefix.len();
            if search_from >= lower.len() {
                break;
            }
        }
    }
    if lower
        .match_indices("bearer ")
        .any(|(index, _)| index == 0 || !lower.as_bytes()[index - 1].is_ascii_alphanumeric())
    {
        return true;
    }
    [
        "api_key",
        "api-key",
        "api_secret",
        "api-secret",
        "authorization",
        "access_token",
        "access-token",
        "auth_token",
        "auth-token",
        "token",
        "credential",
        "secret",
        "password",
        "passwd",
        "private_key",
        "private-key",
        "client_secret",
        "client-secret",
    ]
    .iter()
    .any(|marker| {
        lower.find(marker).is_some_and(|index| {
            lower[index + marker.len()..].trim_start().starts_with('=')
                || lower[index + marker.len()..].trim_start().starts_with(':')
        })
    })
}
