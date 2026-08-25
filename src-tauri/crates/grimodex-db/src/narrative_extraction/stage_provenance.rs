//! Typed, atomic Chronicle stage-provenance persistence (NIR-0 C2A).
//!
//! The C1 closure is an ephemeral proof supplied inside the typed dormant
//! bundle.  Native validates the complete graph and recomputes every digest,
//! then retains only the verified receipt/model-binding rows.  Generic V1
//! task completion never enters this module.

use anyhow::anyhow;
use grimodex_core::{canonical_json_digest, canonical_json_string};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};
use uuid::Uuid;

use super::models::{
    ArtifactInput, ChronicleStageC1ExecutionBinding, ChronicleStageExecution,
    ChronicleStageGenerationMode, ChronicleStageId, ChronicleStageModelBinding,
    ChronicleStageParseStatus, ChronicleStageProvenanceClosure, ChronicleStageReceiptRef,
    ChronicleStageResolutionStatus, ChronicleStageTerminalReceipt, ChronicleStageTerminalStatus,
    ProposalSeed,
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
const CHRONICLE_STAGE_SYNTHESIS_OUTPUTS_KIND: &str = "chronicle.stage-synthesis-outputs@1";
const CHRONICLE_EVENT_HYPOTHESES_KIND: &str = "chronicle.event-hypotheses@1";
const CHRONICLE_PARSED_OUTPUT_DIGEST_DOMAIN: &str = "chronicle.parsed-output/1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleEventSynthesisOutputShape {
    kind: String,
    observation_count: u64,
    event_count: u64,
    observation_refs: Vec<String>,
    raw_observations_digest: String,
    parsed_output_digest: String,
    event_output_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleStageSynthesisOutputsShape {
    kind: String,
    version: u64,
    outputs: Vec<ChronicleSynthesisTerminalOutputShape>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleSynthesisTerminalOutputShape {
    root_stage_execution_id: String,
    terminal_stage_execution_id: String,
    disposition: String,
    cluster_ref: String,
    raw_observations: Value,
    event_output: Value,
    output: ChronicleEventSynthesisOutputShape,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronicleHypothesesArtifactShape {
    hypotheses: Vec<ChronicleHypothesisShape>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChronicleHypothesisShape {
    cluster_ref: String,
    observation_refs: Vec<String>,
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

/// Generic/V1 finish remains available, but cannot persist C1-only
/// output/closure artifacts without the explicit typed companion.  The
/// ordinary `chronicle.raw-observations@1` artifact intentionally remains a
/// generic V1 coordinator artifact; reserving it would reject the production
/// DAG before it can create its separate typed synthesis companion.
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
            CLOSURE_ARTIFACT_KIND | CHRONICLE_STAGE_SYNTHESIS_OUTPUTS_KIND
        )
    });
    anyhow::ensure!(
        !output_reserved && !artifact_reserved,
        "NEX_CHRONICLE_STAGE_BUNDLE_REQUIRED: reserved Chronicle stage output/artifacts require chronicleStageBundle"
    );
    Ok(())
}

/// Resolve the only output terminal a synthesis root is allowed to have.
/// Root success, a parsed successful structured-repair child, and the
/// deterministic zero-observation skip share this resolver so no caller can
/// substitute a root receipt for a repair child (or vice versa).
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum TerminalOutputDisposition {
    RootSuccess,
    RepairSuccess,
    DeterministicEmpty,
}

impl TerminalOutputDisposition {
    fn wire_name(self) -> &'static str {
        match self {
            Self::RootSuccess => "root-success",
            Self::RepairSuccess => "repair-success",
            Self::DeterministicEmpty => "deterministic-empty",
        }
    }
}

fn resolve_terminal_output_receipt<'a>(
    closure: &'a ChronicleStageProvenanceClosure,
    root: &'a ChronicleStageTerminalReceipt,
) -> anyhow::Result<(&'a ChronicleStageTerminalReceipt, TerminalOutputDisposition)> {
    resolve_terminal_output_receipt_from_receipts(&closure.receipts, root)
}

/// The durable ProposalSet boundary no longer has the transport closure, but
/// it does have the verified receipt roster. Keep the terminal-path resolver
/// independent of the ephemeral wrapper so FinishTask and V2 persistence use
/// the same root/repair/zero semantics.
fn resolve_terminal_output_receipt_from_receipts<'a>(
    receipts: &'a [ChronicleStageTerminalReceipt],
    root: &'a ChronicleStageTerminalReceipt,
) -> anyhow::Result<(&'a ChronicleStageTerminalReceipt, TerminalOutputDisposition)> {
    anyhow::ensure!(
        root.stage_execution.stage_id == ChronicleStageId::NarrativeEventSynthesize
            && root.stage_execution.parent_stage_execution_id.is_none(),
        "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISSING: terminal output root must be a synthesis root"
    );
    match (&root.parse_status, &root.terminal_status) {
        (ChronicleStageParseStatus::Parsed, ChronicleStageTerminalStatus::Succeeded) => {
            Ok((root, TerminalOutputDisposition::RootSuccess))
        }
        (ChronicleStageParseStatus::Invalid, ChronicleStageTerminalStatus::Failed) => {
            let children = receipts
                .iter()
                .filter(|child| {
                    child.stage_execution.stage_id == ChronicleStageId::NarrativeStructuredRepair
                        && child.stage_execution.parent_stage_execution_id.as_deref()
                            == Some(root.stage_execution.stage_execution_id.as_str())
                        && matches!(
                            (&child.parse_status, &child.terminal_status),
                            (
                                ChronicleStageParseStatus::Parsed,
                                ChronicleStageTerminalStatus::Succeeded
                            )
                        )
                })
                .collect::<Vec<_>>();
            anyhow::ensure!(
                children.len() == 1,
                "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISSING: invalid synthesis root requires exactly one parsed successful repair child"
            );
            Ok((children[0], TerminalOutputDisposition::RepairSuccess))
        }
        (ChronicleStageParseStatus::NotAttempted, ChronicleStageTerminalStatus::Skipped) => {
            Ok((root, TerminalOutputDisposition::DeterministicEmpty))
        }
        _ => anyhow::bail!(
            "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISSING: synthesis root has no accepted terminal-output path"
        ),
    }
}

/// Validate a typed per-cluster synthesis companion. The closure is a typed
/// ephemeral field, never an ArtifactInput, so no closure JSON can be
/// accidentally retained by the generic artifact writer. The companion binds
/// actual parser output to the terminal receipt while leaving generic V1 raw
/// observation artifacts free for the coordinator's earlier stage.
pub(crate) fn validate_chronicle_synthesis_companion(
    output_json: &Value,
    artifacts: &[ArtifactInput],
    closure: &ChronicleStageProvenanceClosure,
) -> anyhow::Result<()> {
    let hypothesis_count = output_json
        .get("hypothesisCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: synthesis task output requires hypothesisCount"))?;
    let mut companion: Option<&ArtifactInput> = None;
    let mut hypotheses: Option<&ArtifactInput> = None;
    for artifact in artifacts {
        anyhow::ensure!(
            artifact.artifact_kind != CLOSURE_ARTIFACT_KIND,
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: closure is an ephemeral typed bundle field, not a durable artifact"
        );
        if artifact.artifact_kind == CHRONICLE_STAGE_SYNTHESIS_OUTPUTS_KIND {
            anyhow::ensure!(
                companion.replace(artifact).is_none(),
                "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: more than one typed synthesis companion"
            );
        }
        if artifact.artifact_kind == CHRONICLE_EVENT_HYPOTHESES_KIND {
            anyhow::ensure!(
                hypotheses.replace(artifact).is_none(),
                "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: more than one hypotheses artifact"
            );
        }
    }
    let companion = companion.ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_MISSING: typed synthesis companion is required")
    })?;
    let hypotheses = hypotheses.ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_MISSING: hypotheses artifact is required")
    })?;
    let companion_value = companion.payload_json.as_ref().ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: typed synthesis companion payload is missing")
    })?;
    let companion_digest = companion.payload_digest.as_deref().ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: typed synthesis companion payloadDigest is required")
    })?;
    ensure_digest(companion_digest, "typed synthesis companion payloadDigest")?;
    anyhow::ensure!(
        companion_digest == canonical_json_digest(companion_value)?,
        "NEX_CHRONICLE_SYNTHESIS_COMPANION_DIGEST_MISMATCH: typed synthesis companion payload digest differs from Native recomputation"
    );
    let companion: ChronicleStageSynthesisOutputsShape =
        serde_json::from_value(companion_value.clone()).map_err(|error| {
            anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: typed companion shape: {error}")
        })?;
    anyhow::ensure!(
        companion.kind == CHRONICLE_STAGE_SYNTHESIS_OUTPUTS_KIND && companion.version == 1,
        "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: unsupported companion kind/version"
    );
    anyhow::ensure!(
        !companion.outputs.is_empty(),
        "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: typed companion requires terminal outputs"
    );

    let hypothesis_value = hypotheses.payload_json.as_ref().ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: hypotheses payload is missing")
    })?;
    let hypotheses: ChronicleHypothesesArtifactShape =
        serde_json::from_value(hypothesis_value.clone()).map_err(|error| {
            anyhow!("NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: hypotheses shape: {error}")
        })?;
    anyhow::ensure!(
        hypotheses.hypotheses.len() as u64 == hypothesis_count,
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: hypothesisCount does not match hypotheses artifact"
    );
    let mut hypotheses_by_cluster: HashMap<&str, Vec<&ChronicleHypothesisShape>> = HashMap::new();
    for hypothesis in &hypotheses.hypotheses {
        anyhow::ensure!(
            !hypothesis.cluster_ref.trim().is_empty()
                && !hypothesis.observation_refs.is_empty()
                && hypothesis.observation_refs.iter().all(|reference| !reference.trim().is_empty()),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: hypothesis clusterRef/observationRefs are malformed"
        );
        hypotheses_by_cluster
            .entry(hypothesis.cluster_ref.as_str())
            .or_default()
            .push(hypothesis);
    }

    let roots = closure
        .receipts
        .iter()
        .filter(|receipt| {
            receipt.stage_execution.stage_id == ChronicleStageId::NarrativeEventSynthesize
                && receipt.stage_execution.parent_stage_execution_id.is_none()
        })
        .map(|root| {
            resolve_terminal_output_receipt(closure, root)
                .map(|(terminal, disposition)| (root, terminal, disposition))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        !roots.is_empty(),
        "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISSING: closure has no accepted synthesis terminal output"
    );
    let root_by_id = roots
        .iter()
        .map(|(root, terminal, disposition)| {
            (
                root.stage_execution.stage_execution_id.as_str(),
                (*root, *terminal, *disposition),
            )
        })
        .collect::<HashMap<_, _>>();
    anyhow::ensure!(
        root_by_id.len() == roots.len(),
        "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: duplicate accepted synthesis root"
    );
    let mut represented_roots = HashSet::new();
    let mut represented_terminals = HashSet::new();
    let mut total_events = 0_u64;
    for terminal_output in &companion.outputs {
        anyhow::ensure!(
            !terminal_output.root_stage_execution_id.trim().is_empty()
                && !terminal_output
                    .terminal_stage_execution_id
                    .trim()
                    .is_empty()
                && !terminal_output.cluster_ref.trim().is_empty(),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: terminal output identity is malformed"
        );
        anyhow::ensure!(
            represented_roots.insert(terminal_output.root_stage_execution_id.as_str()),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: duplicate terminal output root"
        );
        anyhow::ensure!(
            represented_terminals.insert(terminal_output.terminal_stage_execution_id.as_str()),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID: duplicate terminal output receipt"
        );
        let (root, terminal, disposition) = root_by_id
            .get(terminal_output.root_stage_execution_id.as_str())
            .ok_or_else(|| anyhow!(
                "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISSING: terminal output root is not an accepted synthesis path"
            ))?;
        anyhow::ensure!(
            terminal_output.terminal_stage_execution_id == terminal.stage_execution.stage_execution_id
                && terminal_output.disposition == disposition.wire_name(),
            "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISMATCH: terminal output does not match the common terminal resolver"
        );
        validate_terminal_output_shape(
            terminal_output,
            root,
            terminal,
            *disposition,
            &hypotheses_by_cluster,
        )?;
        total_events = total_events
            .checked_add(terminal_output.output.event_count)
            .ok_or_else(|| {
                anyhow!("NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventCount overflow")
            })?;
    }
    anyhow::ensure!(
        represented_roots.len() == root_by_id.len()
            && represented_roots.iter().all(|root| root_by_id.contains_key(root)),
        "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISSING: every accepted synthesis terminal path must have exactly one output"
    );
    anyhow::ensure!(
        total_events == hypothesis_count,
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: terminal output eventCount does not match task hypotheses"
    );
    Ok(())
}

fn validate_terminal_output_shape(
    terminal_output: &ChronicleSynthesisTerminalOutputShape,
    _root: &ChronicleStageTerminalReceipt,
    terminal: &ChronicleStageTerminalReceipt,
    disposition: TerminalOutputDisposition,
    hypotheses_by_cluster: &HashMap<&str, Vec<&ChronicleHypothesisShape>>,
) -> anyhow::Result<()> {
    let output = &terminal_output.output;
    anyhow::ensure!(
        output.kind == CHRONICLE_EVENT_SYNTHESIS_OUTPUT_KIND,
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: output kind is invalid"
    );
    ensure_digest(&output.raw_observations_digest, "rawObservationsDigest")?;
    ensure_digest(&output.parsed_output_digest, "parsedOutputDigest")?;
    ensure_digest(&output.event_output_digest, "eventOutputDigest")?;
    let raw: ChronicleRawObservationsShape =
        serde_json::from_value(terminal_output.raw_observations.clone()).map_err(|error| {
            anyhow!(
                "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: typed output raw observations: {error}"
            )
        })?;
    anyhow::ensure!(
        raw.kind == CHRONICLE_RAW_OBSERVATIONS_KIND && raw.version == 1,
        "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: unsupported raw observation kind/version"
    );
    let raw_digest = canonical_json_digest(&terminal_output.raw_observations)?;
    anyhow::ensure!(
        raw_digest == output.raw_observations_digest,
        "NEX_CHRONICLE_RAW_OBSERVATIONS_DIGEST_MISMATCH: terminal output rawObservationsDigest differs from Native recomputation"
    );
    let observation_ids = validate_raw_observations(&raw)?;
    anyhow::ensure!(
        output.observation_count == observation_ids.len() as u64
            && output.observation_refs == observation_ids,
        "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: output observation count/refs must exactly match raw localIds"
    );
    let event_output_digest = canonical_json_digest(&terminal_output.event_output)?;
    anyhow::ensure!(
        output.event_output_digest == event_output_digest,
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_DIGEST_MISMATCH: eventOutputDigest differs from Native recomputation"
    );
    let event_output = terminal_output.event_output.as_object().ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventOutput must be an object")
    })?;
    anyhow::ensure!(
        event_output.get("clusterRef").and_then(Value::as_str)
            == Some(terminal_output.cluster_ref.as_str()),
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventOutput clusterRef does not match terminal output"
    );
    let event_rows = event_output
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow!("NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventOutput events must be an array")
        })?;
    anyhow::ensure!(
        event_rows.len() as u64 == output.event_count,
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventOutput event count mismatch"
    );
    let output_event_refs = event_rows
        .iter()
        .map(|event| {
            event
                .get("observationRefs")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!(
                    "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventOutput event observationRefs are required"
                ))?
                .iter()
                .map(|reference| {
                    let reference = reference.as_str().ok_or_else(|| anyhow!(
                        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventOutput observationRef must be a string"
                    ))?;
                    anyhow::ensure!(
                        observation_ids.iter().any(|known| known == reference),
                        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: eventOutput observationRef is not in raw observations"
                    );
                    Ok(reference.to_owned())
                })
                .collect::<anyhow::Result<Vec<_>>>()
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let hypothesis_rows = hypotheses_by_cluster
        .get(terminal_output.cluster_ref.as_str())
        .cloned()
        .unwrap_or_default();
    anyhow::ensure!(
        hypothesis_rows.len() as u64 == output.event_count,
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: hypotheses do not cover terminal output cluster"
    );
    anyhow::ensure!(
        hypothesis_rows
            .iter()
            .zip(output_event_refs.iter())
            .all(|(hypothesis, event_refs)| hypothesis.observation_refs == *event_refs),
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID: hypotheses are not causally equal to parsed terminal events"
    );
    anyhow::ensure!(
        output.parsed_output_digest
            == canonical_parsed_output_digest(
                &output.kind,
                output.observation_count,
                output.event_count,
                &output.observation_refs,
                &output.raw_observations_digest,
                &output.event_output_digest,
            )?,
        "NEX_CHRONICLE_SYNTHESIS_OUTPUT_DIGEST_MISMATCH: parsedOutputDigest differs from Native recomputation"
    );
    anyhow::ensure!(
        terminal.raw_observations_digest.as_deref() == Some(output.raw_observations_digest.as_str())
            && terminal.parsed_output_digest.as_deref() == Some(output.parsed_output_digest.as_str()),
        "NEX_CHRONICLE_SYNTHESIS_PROVENANCE_DIGEST_MISMATCH: terminal receipt does not bind this exact output"
    );
    if disposition == TerminalOutputDisposition::DeterministicEmpty {
        anyhow::ensure!(
            output.observation_count == 0
                && output.event_count == 0
                && output.observation_refs.is_empty()
                && event_rows.is_empty()
                && hypothesis_rows.is_empty(),
            "NEX_CHRONICLE_SYNTHESIS_NOOP_INVALID: skipped synthesis terminal is only valid for the deterministic zero-observation output"
        );
    }
    Ok(())
}

fn validate_raw_observations(raw: &ChronicleRawObservationsShape) -> anyhow::Result<Vec<String>> {
    let mut observation_ids = HashSet::new();
    let mut ordered_ids = Vec::with_capacity(raw.observations.len());
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
                    "actual"
                        | "planned"
                        | "intended"
                        | "attempted"
                        | "prevented"
                        | "hypothetical"
                        | "counterfactual"
                        | "dreamed"
                        | "unknown"
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
        ordered_ids.push(observation.local_id.clone());
    }
    Ok(ordered_ids)
}

/// Canonical digest of the typed parser projection. The closure digest is
/// deliberately excluded: the closure contains the terminal receipt which
/// carries this digest, so including it would create a circular definition.
fn canonical_parsed_output_digest(
    kind: &str,
    observation_count: u64,
    event_count: u64,
    observation_refs: &[String],
    raw_observations_digest: &str,
    event_output_digest: &str,
) -> anyhow::Result<String> {
    Ok(canonical_json_digest(&serde_json::json!({
        "domain": CHRONICLE_PARSED_OUTPUT_DIGEST_DOMAIN,
        "kind": kind,
        "observationCount": observation_count,
        "eventCount": event_count,
        "observationRefs": observation_refs,
        "rawObservationsDigest": raw_observations_digest,
        "eventOutputDigest": event_output_digest,
    }))?)
}

/// Typed C1 stage persistence. The aggregate owner is the task being
/// finished, while the selected model Stage execution is named separately in
/// the binding so the production DAG cannot pretend its final plan task made
/// the synthesis request.
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
        matches!(
            task_kind.as_str(),
            "chronicle.synthesize-event@1" | "chronicle.plan-proposals@1"
        ),
        "NEX_CHRONICLE_STAGE_BUNDLE_TASK_KIND: typed C1 stage bundle requires chronicle.synthesize-event@1 or chronicle.plan-proposals@1"
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
    for (field, value) in [
        (
            "stageExecutionOwnerTaskId",
            binding.stage_execution_owner_task_id.as_str(),
        ),
        (
            "stageExecutionOwnerAttemptId",
            binding.stage_execution_owner_attempt_id.as_str(),
        ),
        (
            "stageExecutionOwnerStageExecutionId",
            binding.stage_execution_owner_stage_execution_id.as_str(),
        ),
    ] {
        anyhow::ensure!(
            !value.trim().is_empty() && value == value.trim(),
            "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_MISMATCH: {field} must be a non-empty trimmed identity"
        );
    }
    // The production DAG runs AI synthesis under its own
    // `chronicle.synthesize-event@1` task and stamps that task/attempt into
    // the stage execution; the single-task flow stamps the finish owner.
    // Both are honest topologies, so the acceptable root-synthesis owners
    // are the finish owner plus this Run's durable synthesize tasks — read
    // from the ledger, never from the caller's payload.
    let mut synthesis_owner_pairs: Vec<(String, String)> =
        vec![(task_id.to_string(), attempt_id.to_string())];
    {
        let mut statement = conn.prepare(
            "SELECT t.id, a.id
               FROM narrative_extraction_tasks t
               JOIN narrative_extraction_attempts a ON a.task_id = t.id
              WHERE t.run_id = ?1 AND t.task_kind = 'chronicle.synthesize-event@1'",
        )?;
        let rows = statement
            .query_map(params![run_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()?;
        synthesis_owner_pairs.extend(rows);
    }
    // Validate the typed output companion first so malformed Chronicle input
    // cannot be reclassified as a generic artifact failure. The generic raw
    // observation artifact is intentionally not reserved by this lane.
    validate_chronicle_synthesis_companion(output_json, artifacts, &binding.closure)?;
    for artifact in artifacts {
        validate_artifact_digest(artifact)?;
    }
    anyhow::ensure!(
        binding.closure.stage_provenance_closure_digest
            == binding.stage_provenance_closure_digest,
        "NEX_CHRONICLE_SYNTHESIS_CLOSURE_DIGEST_MISMATCH: trusted binding does not match typed closure"
    );
    validate_owner_execution_digests(&binding.closure, binding, &synthesis_owner_pairs)?;
    validate_receipt_lifecycle_bindings(conn, project_id, run_id, &binding.closure)?;
    persist_stage_bundle_if_present(
        conn,
        project_id,
        run_id,
        task_id,
        attempt_id,
        &synthesis_owner_pairs,
        &binding.closure,
    )
}

/// CAS every receipt's lifecycle coordinates and transport evidence against
/// durable Native state: the receipt's Task must belong to this Run, its
/// Attempt must belong to that Task, and a receipt claiming an AI response
/// must be backed by an AI-audit ledger event that recorded this exact
/// receipt's stage execution and response digest. Without this, a caller
/// holding a lease can mint self-consistent fictional receipts.
fn validate_receipt_lifecycle_binding(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    receipt: &ChronicleStageTerminalReceipt,
) -> anyhow::Result<()> {
    let execution = &receipt.stage_execution;
    let task_kind: Option<String> = conn
        .query_row(
            "SELECT task_kind FROM narrative_extraction_tasks WHERE id = ?1 AND run_id = ?2",
            params![execution.task_id, run_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(task_kind) = task_kind else {
        anyhow::bail!(
                "NEX_CHRONICLE_STAGE_RECEIPT_TASK_UNKNOWN: receipt taskId '{}' is not a Task of this Run",
                execution.task_id
            );
    };
    // A stage may only run under a Task whose kind honestly hosts it:
    // observation under an observe or single-task plan owner, synthesis
    // under a synthesize or single-task plan owner, and repair only under
    // the same Task its failed parent stage ran on (closure validation
    // already pins repair to the parent's task/attempt, so it inherits
    // the parent's admissible kinds).
    let admissible_kinds: &[&str] = match &execution.stage_id {
        ChronicleStageId::NarrativeObservationExtract => {
            &["chronicle.observe-events@1", "chronicle.plan-proposals@1"]
        }
        ChronicleStageId::NarrativeEventSynthesize => {
            &["chronicle.synthesize-event@1", "chronicle.plan-proposals@1"]
        }
        ChronicleStageId::NarrativeStructuredRepair => &[
            "chronicle.observe-events@1",
            "chronicle.synthesize-event@1",
            "chronicle.plan-proposals@1",
        ],
    };
    anyhow::ensure!(
            admissible_kinds.contains(&task_kind.as_str()),
            "NEX_CHRONICLE_STAGE_RECEIPT_TASK_KIND_MISMATCH: stage '{}' may not run under Task kind '{}'",
            stage_id_name(&execution.stage_id),
            task_kind
        );
    let attempt: Option<(String, i64, i64, String)> = conn
        .query_row(
            "SELECT a.status, a.attempt_number, t.attempt_count, t.status
                   FROM narrative_extraction_attempts a
                   JOIN narrative_extraction_tasks t ON t.id = a.task_id
                  WHERE a.id = ?1 AND a.task_id = ?2 AND t.run_id = ?3",
            params![execution.attempt_id, execution.task_id, run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((attempt_status, attempt_number, current_attempt_number, task_status)) = attempt
    else {
        anyhow::bail!(
                "NEX_CHRONICLE_STAGE_RECEIPT_ATTEMPT_UNKNOWN: receipt attemptId '{}' is not an Attempt of Task '{}'",
                execution.attempt_id,
                execution.task_id
            );
    };
    // A reclaimed lease leaves its former Attempt row behind. A closure
    // must never revive that stale row: every receipt is pinned to the
    // Task's current Attempt number, whether the Task is still running
    // (the aggregate owner) or was completed by an earlier DAG stage.
    anyhow::ensure!(
            attempt_number == current_attempt_number
                && matches!(attempt_status.as_str(), "running" | "completed")
                && matches!(task_status.as_str(), "running" | "completed"),
            "NEX_CHRONICLE_STAGE_RECEIPT_ATTEMPT_RECLAIMED: stage execution '{}' belongs to stale or terminal-invalid Attempt '{}' (attempt {}, current {}, status '{}', task '{}')",
            execution.stage_execution_id,
            execution.attempt_id,
            attempt_number,
            current_attempt_number,
            attempt_status,
            task_status,
        );
    let operation_id = format!(
        "{}:{}:{}",
        execution.run_id, execution.task_id, execution.attempt_id
    );
    if let Some(response_digest) = receipt.response_digest.as_deref() {
        // The transport records terminal stage audits with
        // execution_id = stageExecutionId and
        // operation_id = "runId:taskId:attemptId"
        // (chronicleStageAudit.ts), and stamps the terminal receipt
        // digest into the chronicleStage metadata. CAS all of them so a
        // receipt cannot borrow another stage's audit trail.
        let audited: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ai_audit_events
                  WHERE project_id = ?1
                    AND execution_id = ?2
                    AND operation_id = ?3
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.stageExecution.stageExecutionId') = ?2
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.responseDigest') = ?4
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.stageExecutionReceiptDigest') = ?5
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.parseStatus') = ?6
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.terminalStatus') = ?7",
            params![
                project_id,
                execution.stage_execution_id,
                operation_id,
                response_digest,
                receipt.stage_execution_receipt_digest,
                parse_status_name(&receipt.parse_status),
                terminal_status_name(&receipt.terminal_status),
            ],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            audited >= 1,
            "NEX_CHRONICLE_STAGE_RECEIPT_AUDIT_MISSING: no AI-audit ledger event records \
                 stage execution '{}' under operation '{}' with this responseDigest and \
                 terminal receipt digest",
            execution.stage_execution_id,
            operation_id
        );
    } else {
        // A no-response terminal is not exempt from transport evidence.
        // `emitChronicleStageAuditSkippedReceipt` writes the same exact
        // execution/receipt binding with a JSON null response digest.
        let audited: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ai_audit_events
                  WHERE project_id = ?1
                    AND execution_id = ?2
                    AND operation_id = ?3
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.stageExecution.stageExecutionId') = ?2
                    AND json_type(payload,
                            '$.metadata.chronicleStage.responseDigest') = 'null'
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.stageExecutionReceiptDigest') = ?4
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.parseStatus') = ?5
                    AND json_extract(payload,
                            '$.metadata.chronicleStage.terminalStatus') = ?6",
            params![
                project_id,
                execution.stage_execution_id,
                operation_id,
                receipt.stage_execution_receipt_digest,
                parse_status_name(&receipt.parse_status),
                terminal_status_name(&receipt.terminal_status),
            ],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
                audited >= 1,
                "NEX_CHRONICLE_STAGE_RECEIPT_AUDIT_MISSING: no no-response AI-audit ledger event records \
                 stage execution '{}' under operation '{}' with this terminal receipt digest",
                execution.stage_execution_id,
                operation_id
            );
    }
    Ok(())
}

fn validate_receipt_lifecycle_bindings(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    closure: &ChronicleStageProvenanceClosure,
) -> anyhow::Result<()> {
    for receipt in &closure.receipts {
        validate_receipt_lifecycle_binding(conn, project_id, run_id, receipt)?;
    }
    Ok(())
}

/// Reconstruct the durable C1 receipt roster after a renderer/process restart.
///
/// The persisted C1 closure itself is deliberately ephemeral, so a resumed
/// coordinator must rebuild it from these independently sealed receipt and
/// model-binding rows.  Do not expose a best-effort roster: every row is
/// revalidated against its intrinsic digest, its duplicate model-binding
/// sidecar, the current Task/Attempt lifecycle, and the exact AI-audit
/// terminal evidence before it crosses this read boundary.
pub(crate) fn load_verified_stage_receipts_for_hydration(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let mut receipt_stmt = conn.prepare(
        "SELECT task_id, attempt_id, stage_execution_id, receipt_json,
                receipt_digest, model_binding_digest, terminal_status
           FROM narrative_extraction_stage_receipts
          WHERE project_id = ?1 AND run_id = ?2
          ORDER BY stage_execution_id ASC, id ASC",
    )?;
    let rows = receipt_stmt
        .query_map(params![project_id, run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut receipts = Vec::with_capacity(rows.len());
    let mut seen_execution_ids = HashSet::new();
    for (
        stored_task_id,
        stored_attempt_id,
        stored_execution_id,
        receipt_json,
        stored_receipt_digest,
        stored_model_binding_digest,
        stored_terminal_status,
    ) in rows
    {
        let receipt: ChronicleStageTerminalReceipt = serde_json::from_str(&receipt_json).map_err(
            |error| {
                anyhow!(
                    "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: durable receipt '{}' has invalid JSON: {error}",
                    stored_execution_id
                )
            },
        )?;
        let validated = validate_receipt(project_id, run_id, &receipt).map_err(|error| {
            anyhow!(
                "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: durable receipt '{}' is invalid: {error}",
                stored_execution_id
            )
        })?;
        anyhow::ensure!(
            seen_execution_ids.insert(validated.stage_execution_id.clone()),
            "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: duplicate durable stage execution '{}'",
            validated.stage_execution_id
        );
        anyhow::ensure!(
            validated.task_id == stored_task_id
                && validated.attempt_id == stored_attempt_id
                && validated.stage_execution_id == stored_execution_id
                && validated.receipt_digest == stored_receipt_digest
                && receipt.model_binding_digest == stored_model_binding_digest
                && terminal_status_name(&receipt.terminal_status) == stored_terminal_status,
            "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: durable receipt row '{}' disagrees with its sealed JSON",
            stored_execution_id
        );

        let mut binding_stmt = conn.prepare(
            "SELECT task_id, attempt_id, binding_json, binding_digest
               FROM narrative_extraction_stage_model_bindings
              WHERE project_id = ?1 AND run_id = ?2 AND stage_execution_id = ?3
              ORDER BY id ASC",
        )?;
        let bindings = binding_stmt
            .query_map(params![project_id, run_id, stored_execution_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            bindings.len() == 1,
            "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: durable receipt '{}' requires exactly one model-binding row",
            stored_execution_id
        );
        let (binding_task_id, binding_attempt_id, binding_json, binding_digest) = bindings
            .into_iter()
            .next()
            .ok_or_else(|| {
                anyhow!(
                    "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: durable receipt '{}' is missing its model-binding row",
                    stored_execution_id
                )
            })?;
        let stored_binding: Value = serde_json::from_str(&binding_json).map_err(|error| {
            anyhow!(
                "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: model binding for '{}' has invalid JSON: {error}",
                stored_execution_id
            )
        })?;
        let expected_binding = serde_json::to_value(&receipt.model_execution_binding)?;
        anyhow::ensure!(
            binding_task_id == receipt.stage_execution.task_id
                && binding_attempt_id == receipt.stage_execution.attempt_id
                && stored_binding == expected_binding
                && binding_digest == receipt.model_binding_digest
                // `modelBindingDigest` commits the binding under its typed
                // domain wrapper, rather than hashing the raw stored binding
                // JSON.  Reconstruct the same canonical commitment used by
                // `validate_receipt`; otherwise every honestly persisted
                // receipt becomes unverifiable after a process restart.
                && canonical_json_digest(&serde_json::json!({
                    "domain": MODEL_BINDING_DOMAIN,
                    "binding": stored_binding,
                }))? == receipt.model_binding_digest,
            "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: model binding for '{}' disagrees with its sealed receipt",
            stored_execution_id
        );

        validate_receipt_lifecycle_binding(conn, project_id, run_id, &receipt).map_err(
            |error| {
                anyhow!(
                    "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: durable receipt '{}' lacks valid lifecycle/audit evidence: {error}",
                    stored_execution_id
                )
            },
        )?;
        receipts.push(receipt);
    }

    let binding_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_extraction_stage_model_bindings
          WHERE project_id = ?1 AND run_id = ?2",
        params![project_id, run_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        binding_count == receipts.len() as i64,
        "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: Run has orphan or duplicate durable model-binding rows"
    );
    receipts.sort_by(|left, right| {
        compare_code_units(
            &left.stage_execution.stage_execution_id,
            &right.stage_execution.stage_execution_id,
        )
    });
    receipts
        .into_iter()
        .map(|receipt| serde_json::to_value(receipt).map_err(Into::into))
        .collect()
}

fn validate_owner_execution_digests(
    closure: &ChronicleStageProvenanceClosure,
    binding: &ChronicleStageC1ExecutionBinding,
    synthesis_owner_pairs: &[(String, String)],
) -> anyhow::Result<()> {
    let owner_root = closure
        .receipts
        .iter()
        .find(|receipt| {
            let execution = &receipt.stage_execution;
            matches!(
                &execution.stage_id,
                ChronicleStageId::NarrativeEventSynthesize
            ) && execution.parent_stage_execution_id.is_none()
                && execution.project_id == binding.project_id
                && execution.run_id == binding.run_id
                && execution.task_id == binding.stage_execution_owner_task_id
                && execution.attempt_id == binding.stage_execution_owner_attempt_id
                && execution.stage_execution_id
                    == binding.stage_execution_owner_stage_execution_id
                && synthesis_owner_pairs
                    .iter()
                    .any(|(owner_task, owner_attempt)| {
                        execution.task_id == *owner_task && execution.attempt_id == *owner_attempt
                    })
        })
        .ok_or_else(|| {
            anyhow!(
                "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_MISSING: closure lacks the selected stageExecutionOwner synthesis receipt"
            )
        })?;
    anyhow::ensure!(
        owner_root.context_set_digest == binding.context_set_digest
            && owner_root.component_contract_digest == binding.component_contract_digest
            && owner_root.final_request_digest == binding.final_request_digest,
        "NEX_CHRONICLE_STAGE_BUNDLE_DIGEST_MISMATCH: selected synthesis C1 digests do not match trusted execution binding"
    );
    let _terminal = resolve_terminal_output_receipt(closure, owner_root).map_err(|error| {
        anyhow!(
            "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_PATH_MISMATCH: selected synthesis terminal path is invalid: {error}"
        )
    })?;
    Ok(())
}

/// Persist task-local C1 terminal receipts at the point their producing Task
/// completes.  This deliberately accepts no closure: a closure aggregates
/// multiple DAG stages and is transport-ephemeral, while this batch can be
/// checked entirely against one durable Task/Attempt and its AI-audit rows.
///
/// Keeping this separate from `persist_chronicle_stage_bundle` is what makes
/// an Observation-complete / process-crash-before-Synthesis Run resumable
/// without trusting a renderer-local receipt collection.
pub(crate) fn persist_chronicle_stage_receipts(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    receipts: &[ChronicleStageTerminalReceipt],
) -> anyhow::Result<()> {
    if receipts.is_empty() {
        return Ok(());
    }

    let mut seen_execution_ids = HashSet::new();
    let mut seen_receipt_digests = HashSet::new();
    let mut validated = Vec::with_capacity(receipts.len());
    for receipt in receipts {
        let row = validate_receipt(project_id, run_id, receipt)?;
        anyhow::ensure!(
            row.task_id == task_id && row.attempt_id == attempt_id,
            "NEX_CHRONICLE_STAGE_RECEIPT_OWNER_MISMATCH: terminal receipt '{}' must belong to the finishing Task/Attempt",
            row.stage_execution_id
        );
        anyhow::ensure!(
            seen_execution_ids.insert(row.stage_execution_id.clone()),
            "NEX_CHRONICLE_STAGE_RECEIPT_BATCH_INVALID: duplicate stage execution ID '{}'",
            row.stage_execution_id
        );
        anyhow::ensure!(
            seen_receipt_digests.insert(row.receipt_digest.clone()),
            "NEX_CHRONICLE_STAGE_RECEIPT_BATCH_INVALID: duplicate terminal receipt digest",
        );
        validate_receipt_lifecycle_binding(conn, project_id, run_id, receipt)?;
        validated.push(row);
    }

    // A repair child cannot be independently invented at terminalization: its
    // failed root must be in the same Task-local batch, with the same owner.
    // The later aggregate closure will additionally require a successful
    // observation/synthesis path before a V2 ProposalSet may consume it.
    for receipt in &validated {
        let Some(parent_id) = receipt.parent_stage_execution_id.as_deref() else {
            continue;
        };
        let parent = validated
            .iter()
            .find(|candidate| candidate.stage_execution_id == parent_id)
            .ok_or_else(|| {
                anyhow!(
                    "NEX_CHRONICLE_STAGE_RECEIPT_BATCH_INVALID: repair receipt '{}' is missing its Task-local parent '{}'",
                    receipt.stage_execution_id,
                    parent_id
                )
            })?;
        anyhow::ensure!(
            parent.task_id == receipt.task_id
                && parent.attempt_id == receipt.attempt_id
                && (parent.stage_id == OBSERVATION_STAGE_ID
                    || parent.stage_id == SYNTHESIS_STAGE_ID)
                && parent.parse_status == "invalid"
                && parent.terminal_status == "failed",
            "NEX_CHRONICLE_STAGE_RECEIPT_BATCH_INVALID: repair receipt '{}' has an invalid Task-local parent",
            receipt.stage_execution_id
        );
    }

    let created_at = grimodex_core::now_rfc3339_millis();
    for receipt in receipts {
        persist_receipt(conn, project_id, run_id, receipt, &created_at)?;
    }
    Ok(())
}

pub(crate) fn persist_stage_bundle_if_present(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    synthesis_owner_pairs: &[(String, String)],
    closure: &ChronicleStageProvenanceClosure,
) -> anyhow::Result<()> {
    validate_closure_shape(
        project_id,
        run_id,
        task_id,
        attempt_id,
        synthesis_owner_pairs,
        closure,
    )?;
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

/// ProposalSet summaries are durable user-facing metadata, not another
/// transport channel for the C1 proof.  A direct key check is insufficient:
/// callers could otherwise hide a full closure or the FinishTask C1 bundle
/// under arbitrary nested metadata and make the supposedly-ephemeral proof
/// durable.
fn reject_ephemeral_chronicle_stage_provenance_in_summary(value: &Value) -> anyhow::Result<()> {
    match value {
        Value::Array(values) => {
            for value in values {
                reject_ephemeral_chronicle_stage_provenance_in_summary(value)?;
            }
        }
        Value::Object(object) => {
            // Preserve the pre-existing fail-closed contract for this legacy
            // field at every depth, not only as a summary root key.
            anyhow::ensure!(
                !object.contains_key("stageProvenanceBundle")
                    && !object.contains_key("chronicleStageBundle"),
                "NEX_CHRONICLE_STAGE_CLOSURE_EPHEMERAL: full Chronicle stage provenance closure/C1 bundle must not be persisted in ProposalSet summaryJson"
            );

            // A closure remains forbidden even when a caller deliberately
            // chooses an unrelated property name for it.
            anyhow::ensure!(
                object.get("kind").and_then(Value::as_str) != Some(CLOSURE_KIND),
                "NEX_CHRONICLE_STAGE_CLOSURE_EPHEMERAL: full Chronicle stage provenance closure/C1 bundle must not be persisted in ProposalSet summaryJson"
            );

            // `ChronicleStageC1ExecutionBinding` has no discriminating `kind`
            // field. Detect its complete wire shape as well, including a
            // malformed/nested `closure`, so it cannot become a storage bypass.
            const C1_BUNDLE_FIELDS: [&str; 12] = [
                "projectId",
                "runId",
                "taskId",
                "attemptId",
                "stageExecutionOwnerTaskId",
                "stageExecutionOwnerAttemptId",
                "stageExecutionOwnerStageExecutionId",
                "contextSetDigest",
                "componentContractDigest",
                "finalRequestDigest",
                "stageProvenanceClosureDigest",
                "closure",
            ];
            anyhow::ensure!(
                !C1_BUNDLE_FIELDS
                    .iter()
                    .all(|field| object.contains_key(*field)),
                "NEX_CHRONICLE_STAGE_CLOSURE_EPHEMERAL: full Chronicle stage provenance closure/C1 bundle must not be persisted in ProposalSet summaryJson"
            );

            for child in object.values() {
                reject_ephemeral_chronicle_stage_provenance_in_summary(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Validate the receipt roster bound to a V2 ProposalSet and produce the only
/// summary JSON that may be stored.  The full C1 closure is deliberately not
/// accepted here: it is FinishTask transport proof only.  A V2 revision must
/// instead point at a durable terminal receipt that was already verified with
/// its typed synthesis-output companion during stage terminalization.
pub(crate) fn prepare_chronicle_v2_proposal_set_summary(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    summary_json: Option<&Value>,
    proposals: &[ProposalSeed],
) -> anyhow::Result<Value> {
    let mut summary = summary_json
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    reject_ephemeral_chronicle_stage_provenance_in_summary(&summary)?;
    let summary_object = summary.as_object_mut().ok_or_else(|| {
        anyhow!("NEX_CHRONICLE_PROPOSAL_SET_SUMMARY_INVALID: summaryJson must be an object")
    })?;
    let roster_value = summary_object.remove("chronicleStageReceiptRefs");
    let has_v2 = proposals.iter().any(|proposal| {
        proposal
            .reconciliation_envelope
            .as_ref()
            .and_then(|value| value.get("schemaVersion"))
            .and_then(Value::as_u64)
            == Some(2)
    });
    let refs = match roster_value {
        Some(value) => serde_json::from_value::<Vec<ChronicleStageReceiptRef>>(value).map_err(
            |error| anyhow!(
                "NEX_CHRONICLE_STAGE_RECEIPT_ROSTER_INVALID: chronicleStageReceiptRefs are invalid: {error}"
            ),
        )?,
        None => Vec::new(),
    };
    if !has_v2 {
        anyhow::ensure!(
            refs.is_empty(),
            "NEX_CHRONICLE_STAGE_RECEIPT_ROSTER_UNEXPECTED: non-V2 ProposalSet must not carry Chronicle stage receipt refs"
        );
        return Ok(summary);
    }
    anyhow::ensure!(
        !refs.is_empty(),
        "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: V2 ProposalSet requires verified chronicleStageReceiptRefs"
    );
    validate_receipt_roster(conn, project_id, run_id, &refs)?;
    for proposal in proposals {
        let Some(envelope) = proposal.reconciliation_envelope.as_ref() else {
            continue;
        };
        if envelope.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
            continue;
        }
        validate_v2_envelope_stage_receipt(conn, project_id, run_id, envelope, &refs)?;
    }
    summary_object.insert(
        "chronicleStageReceiptRefs".to_string(),
        serde_json::to_value(refs)?,
    );
    Ok(summary)
}

fn validate_receipt_roster(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    refs: &[ChronicleStageReceiptRef],
) -> anyhow::Result<()> {
    let mut previous: Option<(&str, &str)> = None;
    for reference in refs {
        anyhow::ensure!(
            !reference.stage_execution_id.trim().is_empty()
                && reference.stage_execution_id == reference.stage_execution_id.trim(),
            "NEX_CHRONICLE_STAGE_RECEIPT_ROSTER_INVALID: stageExecutionId must be non-empty and trimmed"
        );
        ensure_digest(
            &reference.stage_execution_receipt_digest,
            "stageExecutionReceiptDigest",
        )?;
        if let Some((previous_execution, previous_digest)) = previous {
            anyhow::ensure!(
                compare_code_units(previous_execution, &reference.stage_execution_id).then_with(
                    || {
                        compare_code_units(
                            previous_digest,
                            &reference.stage_execution_receipt_digest,
                        )
                    }
                ) != Ordering::Greater,
                "NEX_CHRONICLE_STAGE_RECEIPT_ROSTER_INVALID: receipt refs must use canonical order"
            );
            anyhow::ensure!(
                previous_execution != reference.stage_execution_id
                    || previous_digest != reference.stage_execution_receipt_digest,
                "NEX_CHRONICLE_STAGE_RECEIPT_ROSTER_INVALID: duplicate receipt ref"
            );
        }
        let found: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_stage_receipts
              WHERE project_id = ?1 AND run_id = ?2
                AND stage_execution_id = ?3 AND receipt_digest = ?4",
            params![
                project_id,
                run_id,
                reference.stage_execution_id,
                reference.stage_execution_receipt_digest,
            ],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            found == 1,
            "NEX_CHRONICLE_STAGE_RECEIPT_ROSTER_UNKNOWN: receipt ref '{}' is not a verified receipt of this Run",
            reference.stage_execution_id
        );
        previous = Some((
            reference.stage_execution_id.as_str(),
            reference.stage_execution_receipt_digest.as_str(),
        ));
    }
    Ok(())
}

fn required_envelope_string<'a>(envelope: &'a Value, pointer: &str) -> anyhow::Result<&'a str> {
    envelope
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!("NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: V2 envelope is missing '{pointer}'")
        })
}

fn validate_v2_envelope_stage_receipt(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    envelope: &Value,
    refs: &[ChronicleStageReceiptRef],
) -> anyhow::Result<()> {
    let task_id = required_envelope_string(envelope, "/revisionBasis/taskId")?;
    let context_set_digest = required_envelope_string(envelope, "/revisionBasis/contextSetDigest")?;
    let component_contract_digest =
        required_envelope_string(envelope, "/revisionBasis/componentContractDigest")?;
    let final_request_digest =
        required_envelope_string(envelope, "/revisionBasis/finalRequestDigest")?;
    for (field, value) in [
        ("revisionBasis.contextSetDigest", context_set_digest),
        (
            "revisionBasis.componentContractDigest",
            component_contract_digest,
        ),
        ("revisionBasis.finalRequestDigest", final_request_digest),
    ] {
        ensure_digest(value, field)?;
    }
    let roster = refs
        .iter()
        .map(|reference| {
            (
                reference.stage_execution_id.as_str(),
                reference.stage_execution_receipt_digest.as_str(),
            )
        })
        .collect::<HashSet<_>>();

    // Only refs listed in the durable ProposalSet roster may participate in
    // this proof.  In particular a successful structured-repair child must
    // be accompanied by its failed synthesis root: the child owns the output
    // digest, while the root owns the V2 revision-basis prompt coordinates.
    let mut statement = conn.prepare(
        "SELECT r.stage_execution_id, r.receipt_digest, r.receipt_json
           FROM narrative_extraction_stage_receipts r
          WHERE r.project_id = ?1 AND r.run_id = ?2 AND r.task_id = ?3",
    )?;
    let rows = statement
        .query_map(params![project_id, run_id, task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut roster_receipts = Vec::new();
    for (execution_id, receipt_digest, receipt_json) in rows {
        if !roster.contains(&(execution_id.as_str(), receipt_digest.as_str())) {
            continue;
        }
        let receipt: ChronicleStageTerminalReceipt = serde_json::from_str(&receipt_json).map_err(
            |error| anyhow!(
                "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: verified receipt '{}' has malformed durable JSON: {error}",
                execution_id
            ),
        )?;
        let validated = validate_receipt(project_id, run_id, &receipt).map_err(|error| {
            anyhow!(
                "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: verified receipt '{}' is internally invalid: {error}",
                execution_id
            )
        })?;
        anyhow::ensure!(
            validated.stage_execution_id == execution_id && validated.receipt_digest == receipt_digest,
            "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: durable receipt row '{}' does not match its sealed receipt JSON",
            execution_id
        );
        roster_receipts.push(receipt);
    }
    let roots = roster_receipts
        .iter()
        .filter(|receipt| {
            receipt.stage_execution.stage_id == ChronicleStageId::NarrativeEventSynthesize
                && receipt.stage_execution.parent_stage_execution_id.is_none()
                && receipt.stage_execution.task_id == task_id
                && receipt.context_set_digest == context_set_digest
                && receipt.component_contract_digest == component_contract_digest
                && receipt.final_request_digest == final_request_digest
        })
        .collect::<Vec<_>>();
    anyhow::ensure!(
        roots.len() == 1,
        "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: V2 envelope must resolve to exactly one verified synthesis root in its ProposalSet roster"
    );
    let root = roots[0];
    let (terminal, disposition) =
        resolve_terminal_output_receipt_from_receipts(&roster_receipts, root).map_err(|error| {
            anyhow!(
                "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: V2 envelope synthesis terminal path is invalid: {error}"
            )
        })?;
    anyhow::ensure!(
        terminal.stage_execution.task_id == root.stage_execution.task_id
            && terminal.stage_execution.attempt_id == root.stage_execution.attempt_id,
        "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: terminal synthesis output must share its root Task and Attempt"
    );
    anyhow::ensure!(
        terminal.response_digest.is_some()
            && matches!(terminal.parse_status, ChronicleStageParseStatus::Parsed)
            && matches!(terminal.terminal_status, ChronicleStageTerminalStatus::Succeeded),
        "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: V2 proposals require a response-backed parsed synthesis terminal; deterministic empty output cannot create a proposal"
    );
    let parsed_output_digest = terminal.parsed_output_digest.as_deref().ok_or_else(|| {
        anyhow!(
            "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: terminal synthesis receipt lacks parsedOutputDigest"
        )
    })?;
    ensure_digest(parsed_output_digest, "receipt.parsedOutputDigest")?;
    let companion_count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_artifacts a,
                json_each(a.payload_json, '$.outputs') AS output
          WHERE a.run_id = ?1 AND a.task_id = ?2 AND a.attempt_id = ?3
            AND a.artifact_kind = ?4
            AND json_extract(output.value, '$.rootStageExecutionId') = ?5
            AND json_extract(output.value, '$.terminalStageExecutionId') = ?6
            AND json_extract(output.value, '$.disposition') = ?7
            AND json_extract(output.value, '$.output.parsedOutputDigest') = ?8",
        params![
            run_id,
            terminal.stage_execution.task_id,
            terminal.stage_execution.attempt_id,
            CHRONICLE_STAGE_SYNTHESIS_OUTPUTS_KIND,
            root.stage_execution.stage_execution_id,
            terminal.stage_execution.stage_execution_id,
            disposition.wire_name(),
            parsed_output_digest,
        ],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        companion_count == 1,
        "NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED: terminal receipt '{}' lacks its verified typed synthesis-output companion",
        terminal.stage_execution.stage_execution_id
    );
    Ok(())
}

fn validate_closure_shape(
    project_id: &str,
    run_id: &str,
    owner_task_id: &str,
    owner_attempt_id: &str,
    synthesis_owner_pairs: &[(String, String)],
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
    // The successful synthesis path may be owned by the finish owner or by
    // this Run's durable synthesize task (production DAG topology).
    let has_synthesis = synthesis_owner_pairs.iter().any(|(task, attempt)| {
        has_successful_stage_path(
            &validated_receipts,
            SYNTHESIS_STAGE_ID,
            Some(task.as_str()),
            Some(attempt.as_str()),
        ) || closure.receipts.iter().any(|receipt| {
            receipt.stage_execution.stage_id == ChronicleStageId::NarrativeEventSynthesize
                && receipt.stage_execution.parent_stage_execution_id.is_none()
                && receipt.stage_execution.task_id == *task
                && receipt.stage_execution.attempt_id == *attempt
                && receipt.parse_status == ChronicleStageParseStatus::NotAttempted
                && receipt.terminal_status == ChronicleStageTerminalStatus::Skipped
                && receipt.raw_observations_digest.is_some()
                && receipt.parsed_output_digest.is_some()
        })
    });
    anyhow::ensure!(
        has_observation && has_synthesis,
        "NEX_STAGE_PROVENANCE_CLOSURE_INVALID: observation requires a successful root/repair child and synthesis requires a successful root/repair child or deterministic empty terminal"
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
    for (field, digest) in [
        (
            "rawObservationsDigest",
            receipt.raw_observations_digest.as_deref(),
        ),
        (
            "parsedOutputDigest",
            receipt.parsed_output_digest.as_deref(),
        ),
    ] {
        if let Some(digest) = digest {
            ensure_digest(digest, field)?;
        }
    }
    if receipt.stage_execution.stage_id == ChronicleStageId::NarrativeEventSynthesize
        && receipt.terminal_status == ChronicleStageTerminalStatus::Succeeded
    {
        anyhow::ensure!(
            receipt.raw_observations_digest.is_some()
                && receipt.parsed_output_digest.is_some(),
            "NEX_STAGE_TERMINAL_RECEIPT_INVALID: successful synthesis receipt must bind rawObservationsDigest and parsedOutputDigest"
        );
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
        "rawObservationsDigest": receipt.raw_observations_digest,
        "parsedOutputDigest": receipt.parsed_output_digest,
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
    let existing_binding: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT run_id, task_id, attempt_id, binding_json, binding_digest
               FROM narrative_extraction_stage_model_bindings
              WHERE project_id = ?1 AND stage_execution_id = ?2",
            params![project_id, execution.stage_execution_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let existing_receipt: Option<(String, String, String, String, String, String)> = conn
        .query_row(
            "SELECT run_id, task_id, attempt_id, receipt_json, receipt_digest, model_binding_digest
               FROM narrative_extraction_stage_receipts
              WHERE project_id = ?1 AND stage_execution_id = ?2",
            params![project_id, execution.stage_execution_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    match (existing_binding, existing_receipt) {
        (None, None) => {}
        (Some(binding), Some(stored_receipt)) => {
            anyhow::ensure!(
                binding.0 == run_id
                    && binding.1 == execution.task_id
                    && binding.2 == execution.attempt_id
                    && binding.3 == binding_json
                    && binding.4 == receipt.model_binding_digest
                    && stored_receipt.0 == run_id
                    && stored_receipt.1 == execution.task_id
                    && stored_receipt.2 == execution.attempt_id
                    && stored_receipt.3 == receipt_json
                    && stored_receipt.4 == receipt.stage_execution_receipt_digest
                    && stored_receipt.5 == receipt.model_binding_digest,
                "NEX_CHRONICLE_STAGE_RECEIPT_DUPLICATE_MISMATCH: existing durable stage execution '{}' does not match its terminalized receipt",
                execution.stage_execution_id
            );
            return Ok(());
        }
        _ => anyhow::bail!(
            "NEX_CHRONICLE_STAGE_RECEIPT_DUPLICATE_MISMATCH: stage execution '{}' has incomplete durable receipt/model-binding rows",
            execution.stage_execution_id
        ),
    }
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
