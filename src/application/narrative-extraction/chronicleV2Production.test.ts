import { describe, expect, it } from "vitest";

import type { ChronicleExistingMatch } from "@/features/chronicle/extraction/existingEventMatcher";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { buildSnapshotSourceBasis } from "./proposalRepository";
import {
  buildChronicleProductionV2Envelope,
  buildChronicleProductionV2Envelopes,
  buildEventSynthesisContextManifests,
  type ChronicleV2ProductionInput,
} from "./chronicleV2Production";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import {
  createStageExecutionContext,
  createChildStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";

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

async function receipts(
  clusterObservations: readonly RawChronicleEventObservation[] = [observation],
) {
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
    clusterObservations,
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
  const rawObservationsDigest = await digestStableJson({
    kind: "chronicle.raw-observations@1",
    version: 1,
    observations: clusterObservations,
  });
  const eventOutput = {
    clusterRef: hypothesis.clusterRef,
    resolution: "single-event",
    events: [
      {
        observationRefs: [observation.localId],
        titleSuggestion: hypothesis.titleSuggestion,
        summary: hypothesis.summary,
        actuality: hypothesis.actuality,
        significance: hypothesis.significance,
      },
    ],
  };
  const parsedOutputDigest = await digestStableJson({
    domain: "chronicle.parsed-output/1",
    kind: "chronicle.event-synthesis-output@1",
    observationCount: clusterObservations.length,
    eventCount: 1,
    observationRefs: clusterObservations.map((item) => item.localId),
    rawObservationsDigest,
    eventOutputDigest: await digestStableJson(eventOutput),
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
      rawObservationsDigest,
      parsedOutputDigest,
      parseStatus: "parsed",
      terminalStatus: "succeeded",
    }),
  ]);
}

async function repairReceipts() {
  const direct = await receipts();
  const observationReceipt = direct.find(
    (receipt) =>
      receipt.stageExecution.stageId ===
      NARRATIVE_STAGE_IDS.observationExtraction,
  );
  const rootSuccess = direct.find(
    (receipt) =>
      receipt.stageExecution.stageId === NARRATIVE_STAGE_IDS.eventSynthesis,
  );
  if (!observationReceipt || !rootSuccess) {
    throw new Error("missing direct fixture receipts");
  }
  const failedRoot = await buildChronicleStageTerminalReceiptV1({
    stageExecution: rootSuccess.stageExecution,
    contextSetVersion: rootSuccess.contextSetVersion,
    contextSetDigest: rootSuccess.contextSetDigest,
    componentContractDigest: rootSuccess.componentContractDigest,
    finalRequestDigest: rootSuccess.finalRequestDigest,
    modelExecutionBinding: rootSuccess.modelExecutionBinding,
    responseDigest: rootSuccess.responseDigest,
    parseStatus: "invalid",
    terminalStatus: "failed",
  });
  const repairStageExecution = createChildStageExecutionContext(
    rootSuccess.stageExecution,
    NARRATIVE_STAGE_IDS.structuredRepair,
    "stage:synthesis-repair",
  );
  const repair = await buildChronicleStageTerminalReceiptV1({
    stageExecution: repairStageExecution,
    contextSetVersion: "chronicle.context-set/1",
    // The child carries its own repair-prompt coordinates; the V2 Revision
    // Basis must still select the failed root's synthesis coordinates.
    contextSetDigest: await digestStableJson({ repair: "context" }),
    componentContractDigest: await digestStableJson({ repair: "component" }),
    finalRequestDigest: await digestStableJson({ repair: "request" }),
    modelExecutionBinding: rootSuccess.modelExecutionBinding,
    responseDigest: DIGEST,
    rawObservationsDigest: rootSuccess.rawObservationsDigest,
    parsedOutputDigest: rootSuccess.parsedOutputDigest,
    parseStatus: "parsed",
    terminalStatus: "succeeded",
  });
  return [observationReceipt, failedRoot, repair];
}

async function productionInput(): Promise<ChronicleV2ProductionInput> {
  return {
    projectId: "project:chronicle",
    runId: "run:production",
    proposalKey: "event:arrival:0",
    proposal,
    hypothesis,
    synthesisCluster: {
      clusterRef: hypothesis.clusterRef,
      observationRefs: [observation.localId],
    },
    originalObservations: [observation],
    mergedObservations: [observation],
    evidenceAnchors: [anchor],
    existingEventMatch: { status: "none" },
    snapshot,
    sourceBasis: buildSnapshotSourceBasis("run:production", snapshot),
    stageReceipts: await receipts(),
  };
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
      synthesisCluster: {
        clusterRef: hypothesis.clusterRef,
        observationRefs: [observation.localId],
      },
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
    expect(result.envelope.effectiveMaterialBasis.evidenceSet).toEqual([
      expect.objectContaining({
        evidenceRef: "anchor:arrival",
        sourceKey: "project:scene:scene-arrival",
        revisionToken: "v1@2026-08-25T00:00:00.000Z",
      }),
    ]);
    expect(result.envelope.effectiveMaterialBasis.dependencySet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputRef: "project:scene:scene-arrival",
          role: "direct-evidence",
        }),
        expect.objectContaining({
          inputRef: "snapshot:run:production",
          role: "opaque-model-context",
        }),
      ]),
    );
    expect(result.stageProvenanceClosure.receipts).toHaveLength(2);
    expect(result.provenanceBinding.taskId).toBe("task:synthesis");
  });

  it("builds the production batch map without moving orchestration into the UI chunk", async () => {
    const stageReceipts = await receipts();
    const result = await buildChronicleProductionV2Envelopes({
      projectId: "project:chronicle",
      runId: "run:production",
      plannedProposals: [
        {
          proposal,
          match: { status: "none" } satisfies ChronicleExistingMatch,
          hypothesisId: hypothesis.hypothesisId,
        },
      ],
      hypotheses: [hypothesis],
      synthesisClusters: [
        {
          clusterRef: hypothesis.clusterRef,
          observationRefs: [observation.localId],
        },
      ],
      originalObservations: [observation],
      mergedObservations: [observation],
      evidenceAnchors: [anchor],
      snapshot,
      sourceBasis: buildSnapshotSourceBasis("run:production", snapshot),
      stageReceipts,
    });

    expect(result.envelopeByProposalKey.has("event:arrival:0")).toBe(true);
    expect(result.stageReceiptRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageExecutionId: "stage:synthesis" }),
      ]),
    );
  });

  it("uses the failed synthesis root for V2 basis while accepting its parsed repair child output", async () => {
    const stageReceipts = await repairReceipts();
    const result = await buildChronicleProductionV2Envelope({
      projectId: "project:chronicle",
      runId: "run:production",
      proposalKey: "event:arrival:repair",
      proposal,
      hypothesis,
      synthesisCluster: {
        clusterRef: hypothesis.clusterRef,
        observationRefs: [observation.localId],
      },
      originalObservations: [observation],
      mergedObservations: [observation],
      evidenceAnchors: [anchor],
      existingEventMatch: { status: "none" } satisfies ChronicleExistingMatch,
      snapshot,
      sourceBasis: buildSnapshotSourceBasis("run:production", snapshot),
      stageReceipts,
    });

    expect(result.envelope.revisionBasis).toMatchObject({
      taskId: "task:synthesis",
      contextSetDigest: stageReceipts[1]?.contextSetDigest,
    });
    expect(result.stageProvenanceClosure.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageExecution: expect.objectContaining({
            stageExecutionId: "stage:synthesis-repair",
          }),
          parsedOutputDigest: expect.any(String),
        }),
      ]),
    );
  });

  it.each(["planned", "dreamed", "rumored"] as const)(
    "keeps the full %s/actual synthesis context while projecting only the actual claim",
    async (actuality) => {
      const contrast: RawChronicleEventObservation = {
        ...observation,
        localId: `observation:${actuality}`,
        payload: { ...observation.payload, actuality },
      };
      const all = [observation, contrast];
      const stageReceipts = await receipts(all);
      const before = JSON.stringify({ stageReceipts, hypothesis, all });
      const result = await buildChronicleProductionV2Envelope({
        projectId: "project:chronicle",
        runId: "run:production",
        proposalKey: "event:arrival:0",
        proposal,
        hypothesis,
        synthesisCluster: {
          clusterRef: hypothesis.clusterRef,
          observationRefs: all.map((item) => item.localId),
        },
        originalObservations: all,
        mergedObservations: all,
        evidenceAnchors: [anchor],
        existingEventMatch: { status: "none" },
        snapshot,
        sourceBasis: buildSnapshotSourceBasis("run:production", snapshot),
        stageReceipts,
      });
      const revisionBasis = result.envelope.revisionBasis;
      if (revisionBasis.kind !== "interpretation") {
        throw new Error("Expected a synthesis interpretation revision basis");
      }
      expect(revisionBasis.contextSetDigest).toBe(
        stageReceipts[1]!.contextSetDigest,
      );
      expect(result.envelope.assertion.payload.observationRefs).toEqual([
        observation.localId,
      ]);
      expect(result.envelope.assertion.payload.actuality).toBe("actual");
      expect(revisionBasis.contextSet).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inputRef: `observation:${contrast.localId}`,
          }),
        ]),
      );
      expect(result.envelope.effectiveMaterialBasis.dependencySet).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inputRef: `observation:${contrast.localId}`,
            role: "opaque-model-context",
          }),
        ]),
      );
      expect(JSON.stringify({ stageReceipts, hypothesis, all })).toBe(before);
    },
  );

  it.each([
    ["missing cluster", undefined],
    [
      "mismatched cluster",
      { clusterRef: "cluster:other", observationRefs: [observation.localId] },
    ],
    [
      "empty cluster",
      { clusterRef: hypothesis.clusterRef, observationRefs: [] },
    ],
    [
      "duplicate cluster refs",
      {
        clusterRef: hypothesis.clusterRef,
        observationRefs: [observation.localId, observation.localId],
      },
    ],
    [
      "unavailable cluster observation",
      {
        clusterRef: hypothesis.clusterRef,
        observationRefs: [observation.localId, "observation:missing"],
      },
    ],
    [
      "hypothesis outside cluster",
      {
        clusterRef: hypothesis.clusterRef,
        observationRefs: ["observation:other"],
      },
    ],
  ] as const)(
    "rejects %s without reconstructing a hypothesis-only context",
    async (_name, synthesisCluster) => {
      const input = await productionInput();
      await expect(
        buildChronicleProductionV2Envelope({
          ...input,
          synthesisCluster,
        } as ChronicleV2ProductionInput),
      ).rejects.toThrow(/NEX_CHRONICLE_V2_(OBSERVATION_)?PROVENANCE_MISSING/);
    },
  );

  it.each(["originalObservations", "mergedObservations"] as const)(
    "rejects duplicate localIds in %s",
    async (field) => {
      const input = await productionInput();
      await expect(
        buildChronicleProductionV2Envelope({
          ...input,
          [field]: [
            observation,
            {
              ...observation,
              payload: { ...observation.payload, actuality: "planned" },
            },
          ],
        }),
      ).rejects.toThrow("Observation localIds must be nonempty and unique");
    },
  );

  it("rejects a subset-only receipt for a saved mixed synthesis cluster", async () => {
    const contrast: RawChronicleEventObservation = {
      ...observation,
      localId: "observation:planned",
      payload: { ...observation.payload, actuality: "planned" },
    };
    const input = await productionInput();
    await expect(
      buildChronicleProductionV2Envelope({
        ...input,
        synthesisCluster: {
          clusterRef: hypothesis.clusterRef,
          observationRefs: [observation.localId, contrast.localId],
        },
        originalObservations: [observation, contrast],
        mergedObservations: [observation, contrast],
      }),
    ).rejects.toThrow("no C1 synthesis receipt matches cluster");
  });

  it.each([0, 2])(
    "rejects a batch with %i matching saved synthesis clusters",
    async (count) => {
      const input = await productionInput();
      await expect(
        buildChronicleProductionV2Envelopes({
          ...input,
          hypotheses: [hypothesis],
          synthesisClusters: Array.from(
            { length: count },
            () => input.synthesisCluster,
          ),
          plannedProposals: [
            {
              proposal,
              match: { status: "none" },
              hypothesisId: hypothesis.hypothesisId,
            },
          ],
        }),
      ).rejects.toThrow("exactly one saved synthesis cluster must match");
    },
  );

  it("fails closed when the C1 synthesis receipt is absent", async () => {
    const stageReceipts = await receipts();
    await expect(
      buildChronicleProductionV2Envelope({
        projectId: "project:chronicle",
        runId: "run:production",
        proposalKey: "event:arrival:0",
        proposal,
        hypothesis,
        synthesisCluster: {
          clusterRef: hypothesis.clusterRef,
          observationRefs: [observation.localId],
        },
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
