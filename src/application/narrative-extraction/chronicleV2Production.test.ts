import { describe, expect, it } from "vitest";

import type { ChronicleExistingMatch } from "@/features/chronicle/extraction/existingEventMatcher";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { buildSnapshotSourceBasis } from "./proposalRepository";
import {
  buildChronicleProductionV2Envelope,
  buildEventSynthesisContextManifests,
} from "./chronicleV2Production";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import {
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

const proposal = {
  eventId: "event:arrival",
  title: "Arrival",
  note: null,
  actuality: "actual",
  significance: "major",
  evidenceAnchorIds: ["anchor:arrival"],
  evidenceDocumentRefs: ["document:arrival"],
  disclosure: {
    secret: true,
    revealDocumentRef: "document:arrival",
  },
  unresolvedMetadata: {
    participantSurfaces: [],
    locationSurface: null,
    temporalExpressions: [],
  },
} as unknown as CreateChronicleEventProposalPayloadV1;

const observation: RawChronicleEventObservation = {
  localId: "observation:arrival",
  evidence: [{ sourceRef: "source:scene:arrival", quote: "Arrival." }],
  assertion: { attribution: "narrator", narrativeFrame: "story-world" },
  payload: {
    predicate: "arrival",
    semanticType: "arrival",
    actuality: "actual",
    participants: [],
    temporalExpressions: [],
    durationKind: "instant",
  },
};

const hypothesis: EventHypothesis = {
  hypothesisId: "hypothesis:arrival",
  clusterRef: "cluster:arrival",
  observationRefs: [observation.localId],
  titleSuggestion: proposal.title,
  summary: "A arrives.",
  actuality: "actual",
  significance: "major",
};

const anchor = {
  id: "anchor:arrival",
  sourceRef: "source:scene:arrival",
  documentRef: "document:arrival",
  quote: "Arrival.",
  quoteDigest: DIGEST,
} as unknown as ResolvedEvidenceAnchor;

const snapshot = {
  schemaVersion: 1,
  id: "snapshot:production",
  snapshotId: "snapshot:production",
  createdAt: "2026-08-25T00:00:00.000Z",
  language: "ja",
  normalizerVersion: "gdx-canonical-text/1",
  origin: { kind: "grimodex-project", projectId: "project:chronicle" },
  documents: [
    {
      ref: "document:arrival",
      sourceKey: "project:scene:arrival",
      parentRef: null,
      title: "Arrival",
      orderIndex: 0,
      canonical:
        {} as NarrativeCorpusSnapshot["documents"][number]["canonical"],
      contentDigest: DIGEST,
      documentDigest: DIGEST,
      artifactDigest: DIGEST,
      origin: {
        kind: "project-node",
        projectId: "project:chronicle",
        nodeId: "scene-arrival",
        sourceVersion: 1,
        sourceUpdatedAt: "2026-08-25T00:00:00.000Z",
        sourceUri: null,
      },
    },
  ],
  omissions: [],
  digest: DIGEST,
  artifactDigest: DIGEST,
} as unknown as NarrativeCorpusSnapshot;

async function receipts() {
  const observationExecution = createStageExecutionContext({
    projectId: "project:chronicle",
    runId: "run:production",
    taskId: "task:synthesis",
    attemptId: "attempt:1",
    stageId: NARRATIVE_STAGE_IDS.observationExtraction,
    stageExecutionId: "stage:observation",
  });
  const synthesisExecution = createStageExecutionContext({
    projectId: "project:chronicle",
    runId: "run:production",
    taskId: "task:synthesis",
    attemptId: "attempt:1",
    stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
    stageExecutionId: "stage:synthesis",
  });
  const contextSet = buildEventSynthesisContextManifests(
    hypothesis.clusterRef,
    [observation],
  );
  const contextDigest =
    await import("@/features/narrative-extraction/reconciler/chroniclePromptBuilder").then(
      ({ digestChronicleContextSet }) =>
        digestChronicleContextSet(
          contextSet,
          NARRATIVE_STAGE_IDS.eventSynthesis,
        ),
    );
  const model = createStageModelExecutionBindingV1({
    provider: "test",
    requestedModel: "test-model",
    resolutionStatus: "requested-only",
  });
  return Promise.all([
    buildChronicleStageTerminalReceiptV1({
      stageExecution: observationExecution,
      contextSetVersion: "chronicle.context-set/1",
      contextSetDigest: DIGEST,
      componentContractDigest: DIGEST,
      finalRequestDigest: DIGEST,
      modelExecutionBinding: model,
      responseDigest: DIGEST,
      parseStatus: "parsed",
      terminalStatus: "succeeded",
    }),
    buildChronicleStageTerminalReceiptV1({
      stageExecution: synthesisExecution,
      contextSetVersion: "chronicle.context-set/1",
      contextSetDigest: contextDigest,
      componentContractDigest: DIGEST,
      finalRequestDigest: DIGEST,
      modelExecutionBinding: model,
      responseDigest: DIGEST,
      parseStatus: "parsed",
      terminalStatus: "succeeded",
    }),
  ]);
}

describe("Chronicle V2 production adapter boundary", () => {
  it("builds the exact synthesis Context Set declarations", () => {
    expect(
      buildEventSynthesisContextManifests(hypothesis.clusterRef, [observation]),
    ).toEqual([
      {
        contextId: "event-cluster:cluster:arrival",
        inputRef: "cluster:cluster:arrival",
        stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
        exposure: "model-visible",
        selector: { kind: "whole-source" },
      },
      {
        contextId: "event-observation:observation:arrival",
        inputRef: "observation:observation:arrival",
        stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
        exposure: "model-visible",
        selector: { kind: "whole-source" },
      },
    ]);
  });

  it("builds a production add Envelope and its C1 sidecar", async () => {
    const stageReceipts = await receipts();
    const result = await buildChronicleProductionV2Envelope({
      projectId: "project:chronicle",
      runId: "run:production",
      proposalKey: "event:arrival:0",
      proposal,
      hypothesis,
      originalObservations: [observation],
      mergedObservations: [observation],
      evidenceAnchors: [anchor],
      existingEventMatch: { status: "none" } satisfies ChronicleExistingMatch,
      snapshot,
      sourceBasis: buildSnapshotSourceBasis("run:production", snapshot),
      stageReceipts,
    });

    expect(result.envelope.schemaVersion).toBe(2);
    expect(result.envelope.changeIntent).toEqual({ changeKind: "add" });
    expect(result.envelope.projectionBinding.proposalKind).toBe(
      "chronicle.create-event@1",
    );
    expect(result.stageProvenanceClosure.receipts).toHaveLength(2);
    expect(result.provenanceBinding.taskId).toBe("task:synthesis");
  });

  it("fails closed when the C1 synthesis receipt is absent", async () => {
    const stageReceipts = await receipts();
    await expect(
      buildChronicleProductionV2Envelope({
        projectId: "project:chronicle",
        runId: "run:production",
        proposalKey: "event:arrival:0",
        proposal,
        hypothesis,
        originalObservations: [observation],
        mergedObservations: [observation],
        evidenceAnchors: [anchor],
        existingEventMatch: { status: "none" } satisfies ChronicleExistingMatch,
        snapshot,
        sourceBasis: buildSnapshotSourceBasis("run:production", snapshot),
        stageReceipts: stageReceipts.filter(
          (receipt) =>
            receipt.stageExecution.stageId !==
            NARRATIVE_STAGE_IDS.eventSynthesis,
        ),
      }),
    ).rejects.toThrow("synthesis receipt");
  });
});
