import type { ChronicleExistingMatch } from "@/features/chronicle/extraction/existingEventMatcher";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  buildChronicleSceneEventV2,
  type ChronicleSceneEventRevision,
  type ChronicleSceneEventRevealBasis,
} from "@/features/narrative-extraction/proposals/chronicleSceneEventAdapter";
import type {
  ChronicleStageProvenanceBindingV1,
  ChronicleStageProvenanceClosureV1,
  ChronicleStageProvenanceReceiptRefV1,
  ChronicleStageTerminalReceiptV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import {
  buildChronicleStageProvenanceBindingV1,
  buildChronicleStageProvenanceClosureV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import {
  CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID,
  digestChronicleContextSet,
} from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { NARRATIVE_STAGE_IDS } from "@/features/narrative-extraction/reconciler/stageExecution";
import type {
  ContextSetEntry,
  DependencySetEntry,
  SourceBasis,
  SourceBasisRevision,
} from "@/features/narrative-extraction/reconciler/types";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";

export const CHRONICLE_PRODUCTION_RECONCILER_ID =
  "grimodex.chronicle-extraction" as const;
export const CHRONICLE_PRODUCTION_RECONCILER_VERSION = "1" as const;
export const CHRONICLE_SCENE_EVENT_V2_PRODUCTION = true as const;

export interface ChronicleV2ProductionInput {
  readonly projectId: string;
  readonly runId: string;
  readonly proposalKey: string;
  readonly proposal: CreateChronicleEventProposalPayloadV1;
  readonly hypothesis: EventHypothesis;
  readonly originalObservations: readonly RawChronicleEventObservation[];
  readonly mergedObservations: readonly RawChronicleEventObservation[];
  readonly evidenceAnchors: readonly ResolvedEvidenceAnchor[];
  readonly existingEventMatch: ChronicleExistingMatch;
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceBasis: SourceBasis;
  readonly stageReceipts: readonly ChronicleStageTerminalReceiptV1[];
}

export interface ChronicleV2ProductionResult {
  readonly proposalKey: string;
  readonly envelope: ChronicleSceneEventRevision;
  readonly stageProvenanceClosure: ChronicleStageProvenanceClosureV1;
  readonly provenanceBinding: ChronicleStageProvenanceBindingV1;
}

export interface ChronicleV2PlannedProposal {
  readonly proposal: CreateChronicleEventProposalPayloadV1;
  readonly match: ChronicleExistingMatch;
  readonly hypothesisId: string;
}

export interface ChronicleV2ProductionBatchInput {
  readonly projectId: string;
  readonly runId: string;
  readonly plannedProposals: readonly ChronicleV2PlannedProposal[];
  readonly hypotheses: readonly EventHypothesis[];
  readonly originalObservations: readonly RawChronicleEventObservation[];
  readonly mergedObservations: readonly RawChronicleEventObservation[];
  readonly evidenceAnchors: readonly ResolvedEvidenceAnchor[];
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceBasis: SourceBasis;
  readonly stageReceipts: readonly ChronicleStageTerminalReceiptV1[];
}

export interface ChronicleV2ProductionBatchResult {
  readonly envelopeByProposalKey: ReadonlyMap<
    string,
    ChronicleV2ProductionResult["envelope"]
  >;
  /** Durable ProposalSet binds only these verified receipt refs, never a closure. */
  readonly stageReceiptRefs?: readonly ChronicleStageProvenanceReceiptRefV1[];
}

/** The Context Set must be identical to the Event Synthesis prompt builder. */
export function buildEventSynthesisContextManifests(
  clusterRef: string,
  observations: readonly RawChronicleEventObservation[],
): readonly ContextSetEntry[] {
  return [
    {
      contextId: `event-cluster:${clusterRef}`,
      inputRef: `cluster:${clusterRef}`,
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      exposure: "model-visible",
      selector: { kind: "whole-source" },
    },
    ...observations.map((observation) => ({
      contextId: `event-observation:${observation.localId}`,
      inputRef: `observation:${observation.localId}`,
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      exposure: "model-visible" as const,
      selector: { kind: "whole-source" as const },
    })),
  ];
}

function observationsForHypothesis(
  observations: readonly RawChronicleEventObservation[],
  hypothesis: EventHypothesis,
): readonly RawChronicleEventObservation[] {
  const byId = new Map(
    observations.map((observation) => [observation.localId, observation]),
  );
  const selected = hypothesis.observationRefs.map((ref) => byId.get(ref));
  if (selected.some((observation) => observation === undefined)) {
    throw new Error(
      `NEX_CHRONICLE_V2_OBSERVATION_PROVENANCE_MISSING: hypothesis '${hypothesis.hypothesisId}' references an unavailable Observation`,
    );
  }
  return selected as readonly RawChronicleEventObservation[];
}

function buildDependencyDeclarations(
  clusterRef: string,
  proposal: CreateChronicleEventProposalPayloadV1,
  observations: readonly RawChronicleEventObservation[],
  anchors: readonly ResolvedEvidenceAnchor[],
  sourceBasis: SourceBasis,
  evidenceSourceBasisByDocumentRef: ReadonlyMap<string, SourceBasisRevision>,
  contextManifests: readonly ContextSetEntry[],
  componentContractDigest: string,
): readonly DependencySetEntry[] {
  const contextIds = [
    `event-cluster:${clusterRef}`,
    ...observations.map(
      (observation) => `event-observation:${observation.localId}`,
    ),
  ];
  const anchorIds = new Set(proposal.evidenceAnchorIds);
  const evidenceDependencies: DependencySetEntry[] = [];
  const sourceRefs = new Set<string>();
  for (const anchor of anchors) {
    const sourceKey =
      evidenceSourceBasisByDocumentRef.get(anchor.documentRef)?.sourceKey ??
      anchor.sourceRef;
    if (!anchorIds.has(anchor.id) || sourceRefs.has(sourceKey)) continue;
    sourceRefs.add(sourceKey);
    evidenceDependencies.push({
      dependencyId: `dependency:evidence:${anchor.id}`,
      inputRef: sourceKey,
      contextIds,
      role: "direct-evidence",
      selector: { kind: "whole-source" },
    });
  }
  const contextDependencies = contextManifests
    .filter((context) => context.exposure === "model-visible")
    .map((context) => ({
      dependencyId: `dependency:context:${context.contextId}`,
      inputRef: context.inputRef,
      contextIds: [context.contextId],
      role: "opaque-model-context" as const,
      selector: context.selector,
    }));
  const sourceBasisDependencies = sourceBasis
    .filter((source) => !sourceRefs.has(source.sourceKey))
    .map((source) => ({
      dependencyId: `dependency:source-basis:${source.sourceKey}`,
      inputRef: source.sourceKey,
      contextIds,
      role: "opaque-model-context" as const,
      selector: { kind: "whole-source" as const },
    }));
  return [
    ...evidenceDependencies,
    ...sourceBasisDependencies,
    ...contextDependencies,
    {
      dependencyId: "dependency:component-contract",
      inputRef: `component:${CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID}`,
      contextIds: [],
      role: "component-contract",
      selector: {
        kind: "component-contract",
        contractId: CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID,
        contractDigest: componentContractDigest,
      },
    },
  ];
}

function buildRevealBasis(
  proposal: CreateChronicleEventProposalPayloadV1,
): ChronicleSceneEventRevealBasis {
  if (!proposal.disclosure.secret) return { status: "not-secret" };
  return {
    status: "unresolved",
    documentRef: proposal.disclosure.revealDocumentRef,
    audience: {
      reason: "not-provided",
      constraintId: `audience:${proposal.eventId}`,
    },
    readingOrder: {
      reason: "not-provided",
      constraintId: `reading-order:${proposal.eventId}`,
    },
  };
}

function sceneRefForDocument(
  snapshot: NarrativeCorpusSnapshot,
  documentRef: string,
): string {
  const sourceKey = projectSourceKeyForDocument(snapshot, documentRef);
  return `scene:${sourceKey.slice("project:scene:".length)}`;
}

function projectSourceKeyForDocument(
  snapshot: NarrativeCorpusSnapshot,
  documentRef: string,
): string {
  const document = snapshot.documents.find((item) => item.ref === documentRef);
  if (!document || document.origin.kind !== "project-node") {
    throw new Error(
      `NEX_CHRONICLE_V2_SCENE_PROVENANCE_MISSING: document '${documentRef}' has no project Scene origin`,
    );
  }
  return `project:scene:${document.origin.nodeId}`;
}

function evidenceSourceBasisByDocumentRef(
  snapshot: NarrativeCorpusSnapshot,
  sourceBasis: SourceBasis,
  anchors: readonly ResolvedEvidenceAnchor[],
): ReadonlyMap<string, SourceBasisRevision> {
  const result = new Map<string, SourceBasisRevision>();
  for (const anchor of anchors) {
    const sourceKey = projectSourceKeyForDocument(snapshot, anchor.documentRef);
    const source = sourceBasis.find((entry) => entry.sourceKey === sourceKey);
    if (!source) {
      throw new Error(
        `NEX_CHRONICLE_V2_SOURCE_BASIS_MISSING: source '${sourceKey}' is required for document '${anchor.documentRef}'`,
      );
    }
    result.set(anchor.documentRef, source);
  }
  return result;
}

function synthesisReceiptsForInput(
  receipts: readonly ChronicleStageTerminalReceiptV1[],
  contextSetDigest: string,
): readonly ChronicleStageTerminalReceiptV1[] {
  return receipts.filter(
    (receipt) =>
      receipt.stageExecution.stageId === NARRATIVE_STAGE_IDS.eventSynthesis &&
      receipt.stageExecution.parentStageExecutionId === undefined &&
      receipt.contextSetDigest === contextSetDigest,
  );
}

type AcceptedSynthesisTerminal = {
  readonly terminal: ChronicleStageTerminalReceiptV1;
  readonly disposition:
    | "root-success"
    | "repair-success"
    | "deterministic-empty";
};

/**
 * Keep production V2 selection aligned with Native's terminal-path resolver:
 * the root owns the Revision Basis prompt coordinates, while a successful
 * structured-repair child owns the parsed output digest.
 */
function resolveAcceptedSynthesisTerminal(
  receipts: readonly ChronicleStageTerminalReceiptV1[],
  root: ChronicleStageTerminalReceiptV1,
): AcceptedSynthesisTerminal {
  if (
    root.stageExecution.stageId !== NARRATIVE_STAGE_IDS.eventSynthesis ||
    root.stageExecution.parentStageExecutionId !== undefined
  ) {
    throw new Error(
      "NEX_CHRONICLE_V2_PROVENANCE_MISSING: terminal path must begin at a synthesis root",
    );
  }
  if (root.parseStatus === "parsed" && root.terminalStatus === "succeeded") {
    return { terminal: root, disposition: "root-success" };
  }
  if (
    root.parseStatus === "not-attempted" &&
    root.terminalStatus === "skipped"
  ) {
    return { terminal: root, disposition: "deterministic-empty" };
  }
  if (root.parseStatus === "invalid" && root.terminalStatus === "failed") {
    const repairs = receipts.filter(
      (receipt) =>
        receipt.stageExecution.stageId ===
          NARRATIVE_STAGE_IDS.structuredRepair &&
        receipt.stageExecution.parentStageExecutionId ===
          root.stageExecution.stageExecutionId &&
        receipt.stageExecution.taskId === root.stageExecution.taskId &&
        receipt.stageExecution.attemptId === root.stageExecution.attemptId &&
        receipt.parseStatus === "parsed" &&
        receipt.terminalStatus === "succeeded",
    );
    if (repairs.length === 1 && repairs[0]) {
      return { terminal: repairs[0], disposition: "repair-success" };
    }
  }
  throw new Error(
    "NEX_CHRONICLE_V2_PROVENANCE_MISSING: synthesis root has no accepted terminal output path",
  );
}

export async function buildChronicleProductionV2Envelope(
  input: ChronicleV2ProductionInput,
): Promise<ChronicleV2ProductionResult> {
  const mergedObservations = observationsForHypothesis(
    input.mergedObservations,
    input.hypothesis,
  );
  const originalObservations = observationsForHypothesis(
    input.originalObservations,
    input.hypothesis,
  );
  const contextManifests = buildEventSynthesisContextManifests(
    input.hypothesis.clusterRef,
    mergedObservations,
  );
  const contextSetDigest = await digestChronicleContextSet(
    contextManifests,
    NARRATIVE_STAGE_IDS.eventSynthesis,
  );
  const synthesisReceipts = synthesisReceiptsForInput(
    input.stageReceipts,
    contextSetDigest,
  );
  if (synthesisReceipts.length > 1) {
    throw new Error(
      `NEX_CHRONICLE_V2_PROVENANCE_AMBIGUOUS: multiple C1 synthesis receipts match cluster '${input.hypothesis.clusterRef}'`,
    );
  }
  const synthesisReceipt = synthesisReceipts[0];
  if (!synthesisReceipt) {
    throw new Error(
      `NEX_CHRONICLE_V2_PROVENANCE_MISSING: no C1 synthesis receipt matches cluster '${input.hypothesis.clusterRef}'`,
    );
  }
  const terminal = resolveAcceptedSynthesisTerminal(
    input.stageReceipts,
    synthesisReceipt,
  );
  if (
    terminal.disposition === "deterministic-empty" ||
    terminal.terminal.responseDigest === null ||
    terminal.terminal.rawObservationsDigest === null ||
    terminal.terminal.parsedOutputDigest === null
  ) {
    throw new Error(
      "NEX_CHRONICLE_V2_PROVENANCE_MISSING: a V2 proposal requires a response-backed parsed synthesis terminal",
    );
  }
  // Choose the root after computing this proposal's exact Context Set. A
  // multi-cluster Run may contain several synthesis receipts; using the first
  // receipt would bind a valid envelope to the wrong model invocation.
  const closure = await buildChronicleStageProvenanceClosureV1({
    projectId: input.projectId,
    runId: input.runId,
    ownerTaskId: synthesisReceipt.stageExecution.taskId,
    ownerAttemptId: synthesisReceipt.stageExecution.attemptId,
    receipts: input.stageReceipts,
  });
  const binding = buildChronicleStageProvenanceBindingV1({
    projectId: input.projectId,
    runId: input.runId,
    taskId: synthesisReceipt.stageExecution.taskId,
    closure,
  });

  const evidenceById = new Map(
    input.evidenceAnchors.map((anchor) => [anchor.id, anchor] as const),
  );
  const proposalAnchorIds = new Set(input.proposal.evidenceAnchorIds);
  const proposalAnchors = input.evidenceAnchors.filter((anchor) =>
    proposalAnchorIds.has(anchor.id),
  );
  if (proposalAnchors.length !== proposalAnchorIds.size) {
    throw new Error(
      "NEX_CHRONICLE_V2_EVIDENCE_MISSING: every proposal Evidence Anchor must be resolved",
    );
  }
  const firstAnchor = evidenceById.get(input.proposal.evidenceAnchorIds[0]);
  if (!firstAnchor) {
    throw new Error(
      "NEX_CHRONICLE_V2_EVIDENCE_MISSING: proposal has no first Evidence Anchor",
    );
  }
  const execution = {
    projectId: input.projectId,
    runId: input.runId,
    taskId: synthesisReceipt.stageExecution.taskId,
    attemptId: synthesisReceipt.stageExecution.attemptId,
    reconcilerId: CHRONICLE_PRODUCTION_RECONCILER_ID,
    reconcilerVersion: CHRONICLE_PRODUCTION_RECONCILER_VERSION,
    contextSetDigest: synthesisReceipt.contextSetDigest,
    componentContractId: CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID,
    componentContractDigest: synthesisReceipt.componentContractDigest,
    finalRequestDigest: synthesisReceipt.finalRequestDigest,
  } as const;

  const evidenceSourceBasis = evidenceSourceBasisByDocumentRef(
    input.snapshot,
    input.sourceBasis,
    proposalAnchors,
  );

  const result = await buildChronicleSceneEventV2({
    execution,
    stageProvenanceClosure: closure,
    provenanceBinding: binding,
    sceneRef: sceneRefForDocument(input.snapshot, firstAnchor.documentRef),
    proposalPayload: input.proposal,
    hypothesis: input.hypothesis,
    originalObservations,
    mergedObservations,
    originalObservationRefs: originalObservations.map(
      (observation) => observation.localId,
    ),
    mergedObservationRefs: mergedObservations.map(
      (observation) => observation.localId,
    ),
    evidenceAnchors: proposalAnchors,
    attribution: mergedObservations[0]!.assertion.attribution,
    narrativeFrame: mergedObservations[0]!.assertion.narrativeFrame,
    actuality: input.proposal.actuality,
    significance: input.proposal.significance,
    existingEventMatch: input.existingEventMatch,
    sourceBasis: input.sourceBasis,
    evidenceSourceBasisByDocumentRef: evidenceSourceBasis,
    contextManifests,
    dependencyDeclarations: buildDependencyDeclarations(
      input.hypothesis.clusterRef,
      input.proposal,
      mergedObservations,
      proposalAnchors,
      input.sourceBasis,
      evidenceSourceBasis,
      contextManifests,
      synthesisReceipt.componentContractDigest,
    ),
    revealBasis: buildRevealBasis(input.proposal),
  });

  return {
    proposalKey: input.proposalKey,
    envelope: result.envelope,
    stageProvenanceClosure: closure,
    provenanceBinding: binding,
  };
}

export async function buildChronicleProductionV2Envelopes(
  input: ChronicleV2ProductionBatchInput,
): Promise<ChronicleV2ProductionBatchResult> {
  const hypothesesById = new Map(
    input.hypotheses.map((hypothesis) => [hypothesis.hypothesisId, hypothesis]),
  );
  const envelopeByProposalKey = new Map<
    string,
    ChronicleV2ProductionResult["envelope"]
  >();
  const stageReceiptRefs = new Map<
    string,
    ChronicleStageProvenanceReceiptRefV1
  >();

  for (const [index, plannedRow] of input.plannedProposals.entries()) {
    const proposalKey = `${plannedRow.proposal.eventId}:${index}`;
    const hypothesis = hypothesesById.get(plannedRow.hypothesisId);
    if (!hypothesis) {
      throw new Error(
        `Missing hypothesis for Chronicle V2 proposal ${proposalKey}`,
      );
    }
    const builtV2 = await buildChronicleProductionV2Envelope({
      projectId: input.projectId,
      runId: input.runId,
      proposalKey,
      proposal: plannedRow.proposal,
      hypothesis,
      originalObservations: input.originalObservations,
      mergedObservations: input.mergedObservations,
      evidenceAnchors: input.evidenceAnchors,
      existingEventMatch: plannedRow.match,
      snapshot: input.snapshot,
      sourceBasis: input.sourceBasis,
      stageReceipts: input.stageReceipts,
    });
    envelopeByProposalKey.set(proposalKey, builtV2.envelope);
    for (const reference of builtV2.stageProvenanceClosure.receiptRefs) {
      stageReceiptRefs.set(reference.stageExecutionId, reference);
    }
  }

  return {
    envelopeByProposalKey,
    ...(stageReceiptRefs.size > 0
      ? {
          stageReceiptRefs: [...stageReceiptRefs.values()].sort(
            (left, right) =>
              left.stageExecutionId < right.stageExecutionId
                ? -1
                : left.stageExecutionId > right.stageExecutionId
                  ? 1
                  : left.stageExecutionReceiptDigest <
                      right.stageExecutionReceiptDigest
                    ? -1
                    : left.stageExecutionReceiptDigest >
                        right.stageExecutionReceiptDigest
                      ? 1
                      : 0,
          ),
        }
      : {}),
  };
}
