import { beforeAll, describe, expect, it } from "vitest";

import goldenCorpus from "../../../../policies/narrative/fixtures/narrative-ir/chronicle-scene-event-v2.json";
import type { ChronicleExistingMatch } from "@/features/chronicle/extraction/existingEventMatcher";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type {
  ContextSetEntry,
  DependencySetEntry,
  SourceBasis,
} from "@/features/narrative-extraction/reconciler/types";
import type { CreateChronicleEventProposalPayloadV1 } from "./chronicleEventProposal";
import {
  buildChronicleStageProvenanceBindingV1,
  buildChronicleStageProvenanceClosureV1,
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
  type ChronicleStageProvenanceBindingV1,
  type ChronicleStageProvenanceClosureV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import {
  createChildStageExecutionContext,
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import { digestChronicleContextSet } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import {
  buildChronicleSceneEventV2,
  classifyChronicleSceneEventChanges,
  deriveChronicleSceneEventScope,
  validateChronicleSceneEventV2,
  type ChronicleSceneEventAdapterInput,
  type ChronicleSceneEventScopeInput,
} from "./chronicleSceneEventAdapter";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

const nonSecretCase = goldenCorpus.cases.find(
  (entry) => entry.id === "non-secret-event",
);
if (!nonSecretCase) throw new Error("missing non-secret-event golden case");

const proposal = nonSecretCase.input
  .proposalPayload as unknown as CreateChronicleEventProposalPayloadV1;

const observation: RawChronicleEventObservation = {
  localId: "observation:arrival",
  evidence: [{ sourceRef: "source:scene:1", quote: "Arrival." }],
  assertion: { attribution: "narrator", narrativeFrame: "story-world" },
  payload: {
    predicate: "arrival",
    semanticType: "arrival",
    actuality: "actual",
    participants: [{ surface: "A", role: "subject" }],
    locationSurface: "station",
    temporalExpressions: ["morning"],
    durationKind: "instant",
  },
};

const observationTwo: RawChronicleEventObservation = {
  ...observation,
  localId: "observation:departure",
  evidence: [{ sourceRef: "source:scene:1", quote: "Departure." }],
  payload: {
    ...observation.payload,
    predicate: "departure",
    semanticType: "departure",
  },
};

const hypothesis: EventHypothesis = {
  hypothesisId: "hypothesis:arrival",
  clusterRef: "cluster:arrival",
  observationRefs: [observation.localId],
  titleSuggestion: proposal.title,
  summary: "A arrives at the station.",
  actuality: proposal.actuality,
  significance: proposal.significance,
  semanticType: proposal.semanticType,
};

const anchor = {
  id: proposal.evidenceAnchorIds[0],
  sourceRef: "source:scene:1",
  documentRef: proposal.evidenceDocumentRefs[0],
  quote: "Arrival.",
  quoteDigest: DIGEST,
} as unknown as ResolvedEvidenceAnchor;

const anchorTwo = {
  ...anchor,
  id: "anchor:departure",
  documentRef: "document:2",
  quote: "Departure.",
} as unknown as ResolvedEvidenceAnchor;

const sourceBasis: SourceBasis = [
  {
    sourceKind: "scene-body",
    sourceKey: "scene:1",
    revisionToken: "revision:1",
  },
];

const contextManifests: readonly ContextSetEntry[] = [
  {
    contextId: "context:event-synthesis",
    inputRef: "source:scene:1",
    stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
    exposure: "model-visible",
    selector: { kind: "whole-source" },
  },
];

const dependencyDeclarations: readonly DependencySetEntry[] = [
  {
    dependencyId: "dependency:evidence",
    inputRef: "source:scene:1",
    contextIds: ["context:event-synthesis"],
    role: "direct-evidence",
    selector: { kind: "whole-source" },
  },
];

const existingEventMatch: ChronicleExistingMatch = { status: "none" };

const execution = {
  projectId: "project:chronicle",
  runId: "run:chronicle",
  taskId: "task:event-synthesis",
  attemptId: "attempt:1",
  reconcilerId: "chronicle.reconciler",
  reconcilerVersion: "1",
  contextSetDigest: DIGEST,
  componentContractDigest: DIGEST,
  finalRequestDigest: DIGEST,
};

const adapterInput: ChronicleSceneEventAdapterInput = {
  execution:
    execution as unknown as ChronicleSceneEventAdapterInput["execution"],
  sceneRef: nonSecretCase.input.sceneRef,
  proposalPayload: proposal,
  hypothesis,
  originalObservations: [observation],
  mergedObservations: [observation],
  originalObservationRefs: [observation.localId],
  mergedObservationRefs: [observation.localId],
  evidenceAnchors: [anchor],
  attribution: observation.assertion.attribution,
  narrativeFrame: observation.assertion.narrativeFrame,
  actuality: proposal.actuality,
  significance: proposal.significance,
  existingEventMatch,
  sourceBasis,
  contextManifests,
  dependencyDeclarations,
  revealBasis: nonSecretCase.input
    .revealBasis as ChronicleSceneEventScopeInput["revealBasis"],
  stageProvenanceClosure:
    undefined as unknown as ChronicleStageProvenanceClosureV1,
  provenanceBinding: undefined as unknown as ChronicleStageProvenanceBindingV1,
};

beforeAll(async () => {
  Object.assign(execution, {
    contextSetDigest: await digestChronicleContextSet(
      contextManifests,
      NARRATIVE_STAGE_IDS.eventSynthesis,
    ),
  });
  const observationStageExecution = createStageExecutionContext({
    projectId: execution.projectId,
    runId: execution.runId,
    taskId: "task:observation",
    attemptId: "attempt:observation",
    stageId: NARRATIVE_STAGE_IDS.observationExtraction,
    stageExecutionId: "stage:observation",
  });
  const stageExecution = createStageExecutionContext({
    projectId: execution.projectId,
    runId: execution.runId,
    taskId: execution.taskId,
    attemptId: execution.attemptId,
    stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
    stageExecutionId: "stage:event-synthesis",
  });
  const observationReceipt = await buildChronicleStageTerminalReceiptV1({
    stageExecution: observationStageExecution,
    contextSetVersion: "chronicle.context-set/1",
    contextSetDigest: execution.contextSetDigest,
    componentContractDigest: execution.componentContractDigest,
    finalRequestDigest: execution.finalRequestDigest,
    modelExecutionBinding: createStageModelExecutionBindingV1({
      provider: "ollama",
      requestedModel: "qwen3:8b",
      resolutionStatus: "requested-only",
    }),
    responseDigest: DIGEST,
    parseStatus: "parsed",
    terminalStatus: "succeeded",
  });
  const terminalReceipt = await buildChronicleStageTerminalReceiptV1({
    stageExecution,
    contextSetVersion: "chronicle.context-set/1",
    contextSetDigest: execution.contextSetDigest,
    componentContractDigest: execution.componentContractDigest,
    finalRequestDigest: execution.finalRequestDigest,
    modelExecutionBinding: createStageModelExecutionBindingV1({
      provider: "ollama",
      requestedModel: "qwen3:8b",
      resolutionStatus: "requested-only",
    }),
    responseDigest: DIGEST,
    parseStatus: "invalid",
    terminalStatus: "failed",
  });
  const repairReceipt = await buildChronicleStageTerminalReceiptV1({
    stageExecution: createChildStageExecutionContext(
      stageExecution,
      NARRATIVE_STAGE_IDS.structuredRepair,
      "stage:repair",
    ),
    contextSetVersion: "chronicle.context-set/1",
    contextSetDigest: execution.contextSetDigest,
    componentContractDigest: execution.componentContractDigest,
    finalRequestDigest: execution.finalRequestDigest,
    modelExecutionBinding: createStageModelExecutionBindingV1({
      provider: "ollama",
      requestedModel: "repair-model",
      resolutionStatus: "requested-only",
    }),
    responseDigest: DIGEST,
    parseStatus: "parsed",
    terminalStatus: "succeeded",
  });
  const closure = await buildChronicleStageProvenanceClosureV1({
    projectId: execution.projectId,
    runId: execution.runId,
    ownerTaskId: execution.taskId,
    ownerAttemptId: execution.attemptId,
    receipts: [observationReceipt, terminalReceipt, repairReceipt],
  });
  Object.assign(adapterInput, {
    stageProvenanceClosure: closure,
    provenanceBinding: buildChronicleStageProvenanceBindingV1({
      projectId: execution.projectId,
      runId: execution.runId,
      taskId: execution.taskId,
      closure,
    }),
  });
});

function cloneObservation(
  source: RawChronicleEventObservation,
): RawChronicleEventObservation {
  return JSON.parse(JSON.stringify(source)) as RawChronicleEventObservation;
}

describe("Chronicle scene-event@1 pure Adapter", () => {
  it("builds and validates an add-only Evidence-bound V2 object from the complete seam", async () => {
    const result = await buildChronicleSceneEventV2(adapterInput);

    expect(result.envelope.schemaVersion).toBe(2);
    expect(result.envelope.changeIntent).toEqual({ changeKind: "add" });
    expect(result.envelope.assertion.assertionKind).toBe("scene-event@1");
    expect(result.envelope.projectionBinding).toMatchObject({
      proposalKind: "chronicle.create-event@1",
      proposalSchemaRef: {
        id: "narrative.chronicle-event.create",
        version: "1",
      },
      adapterContractId: "chronicle.scene-event",
      adapterContractVersion: "1",
    });
    expect(result.envelope.assertion.payload).not.toHaveProperty("disclosure");
    expect(result.envelope.assertion.payload).not.toHaveProperty("secret");
    expect(result.envelope.assertion.payload).not.toHaveProperty(
      "revealDocumentRef",
    );
    expect(result.envelope.revisionBasis).toMatchObject({
      contextSetDigest: execution.contextSetDigest,
    });
    expect(result.envelope.revisionBasis).not.toHaveProperty(
      "stageProvenanceClosureDigest",
    );
    expect(result.provenanceBinding).toMatchObject({
      projectId: execution.projectId,
      runId: execution.runId,
      taskId: execution.taskId,
      stageProvenanceClosureDigest:
        adapterInput.provenanceBinding.stageProvenanceClosureDigest,
    });
    expect(result.existingEventMatch).toEqual(existingEventMatch);
    expect(validateChronicleSceneEventV2(result.envelope)).toEqual({
      valid: true,
    });
  });

  it("requires a sealed C1 provenance sidecar and rejects owner/tampered closure input", async () => {
    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        execution: { ...execution, taskId: "task:other" },
      }),
    ).rejects.toThrow(/owner|task|reach/i);

    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        stageProvenanceClosure: {
          ...adapterInput.stageProvenanceClosure,
          receipts: [],
        },
      }),
    ).rejects.toThrow(/receipt|terminal|empty/i);

    const receipt = adapterInput.stageProvenanceClosure.receipts[0]!;
    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        stageProvenanceClosure: {
          ...adapterInput.stageProvenanceClosure,
          receipts: [
            {
              ...receipt,
              responseDigest: `sha256:${"b".repeat(64)}`,
            },
          ],
        },
      }),
    ).rejects.toThrow(/digest|tamper/i);
  });

  it("rejects a merged observation that forges content under an original local ID", async () => {
    const forgedMergedObservation: RawChronicleEventObservation = {
      ...observation,
      payload: {
        ...observation.payload,
        predicate: "forged-semantic",
      },
    };

    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        mergedObservations: [forgedMergedObservation],
      }),
    ).rejects.toThrow(/provenance|merged observation/i);
  });

  it("rejects a merged observation ID that is absent from originals", async () => {
    const orphanMergedObservation: RawChronicleEventObservation = {
      ...observation,
      localId: "observation:orphan",
    };

    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        mergedObservations: [orphanMergedObservation],
        mergedObservationRefs: [orphanMergedObservation.localId],
        hypothesis: {
          ...hypothesis,
          observationRefs: [orphanMergedObservation.localId],
        },
      }),
    ).rejects.toThrow(/provenance|merged observation/i);
  });

  it("rejects independently forged nested semantic observation content", async () => {
    const forgedMergedObservation: RawChronicleEventObservation = {
      ...observation,
      payload: {
        ...observation.payload,
        participants: [{ surface: "forged participant", role: "subject" }],
        semanticType: "forged-semantic",
      },
    };

    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        mergedObservations: [forgedMergedObservation],
      }),
    ).rejects.toThrow(/provenance|merged observation/i);
  });

  it("rejects independently forged nested assertion provenance", async () => {
    const forgedMergedObservation: RawChronicleEventObservation = {
      ...observation,
      assertion: {
        ...observation.assertion,
        narrativeFrame: "flashback",
      },
    };

    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        mergedObservations: [forgedMergedObservation],
        narrativeFrame: "flashback",
      }),
    ).rejects.toThrow(/provenance|merged observation/i);
  });

  it("rejects independently forged nested evidence provenance", async () => {
    const forgedEvidenceAnchor = {
      ...anchor,
      id: "anchor:forged-evidence",
      documentRef: "document:2",
      quote: "Forged evidence.",
    } as unknown as ResolvedEvidenceAnchor;
    const forgedMergedObservation: RawChronicleEventObservation = {
      ...observation,
      evidence: [
        {
          sourceRef: "source:scene:1",
          quote: forgedEvidenceAnchor.quote,
        },
      ],
    };

    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        proposalPayload: {
          ...proposal,
          evidenceAnchorIds: [anchor.id, forgedEvidenceAnchor.id],
          evidenceDocumentRefs: [
            anchor.documentRef,
            forgedEvidenceAnchor.documentRef,
          ],
        },
        mergedObservations: [forgedMergedObservation],
        evidenceAnchors: [anchor, forgedEvidenceAnchor],
      }),
    ).rejects.toThrow(/provenance|merged observation/i);
  });

  it("keeps embedded-NUL evidence tuples bound to the correct Anchor", async () => {
    const collisionAnchorA = {
      ...anchor,
      id: "anchor:nul-a",
      sourceRef: "source:scene:1",
      quote: "b\0c",
      documentRef: "document:nul-a",
    } as unknown as ResolvedEvidenceAnchor;
    const collisionAnchorB = {
      ...anchor,
      id: "anchor:nul-b",
      sourceRef: "source:scene:1\0b",
      quote: "c",
      documentRef: "document:nul-b",
    } as unknown as ResolvedEvidenceAnchor;
    const collisionObservation: RawChronicleEventObservation = {
      ...observation,
      localId: "observation:nul",
      evidence: [{ sourceRef: "source:scene:1", quote: "b\0c" }],
    };
    const collisionInput = {
      ...adapterInput,
      proposalPayload: {
        ...proposal,
        evidenceAnchorIds: [collisionAnchorA.id],
        evidenceDocumentRefs: [collisionAnchorA.documentRef],
      },
      hypothesis: {
        ...hypothesis,
        observationRefs: [collisionObservation.localId],
      },
      originalObservations: [collisionObservation],
      mergedObservations: [collisionObservation],
      originalObservationRefs: [collisionObservation.localId],
      mergedObservationRefs: [collisionObservation.localId],
      evidenceAnchors: [collisionAnchorA, collisionAnchorB],
    } satisfies ChronicleSceneEventAdapterInput;

    const result = await buildChronicleSceneEventV2(collisionInput);
    expect(result.envelope.effectiveMaterialBasis.evidenceSet).toEqual([
      expect.objectContaining({
        evidenceRef: collisionAnchorA.id,
        documentRef: collisionAnchorA.documentRef,
        sourceKey: collisionAnchorA.sourceRef,
        quote: collisionAnchorA.quote,
      }),
    ]);

    await expect(
      buildChronicleSceneEventV2({
        ...collisionInput,
        proposalPayload: {
          ...collisionInput.proposalPayload,
          evidenceAnchorIds: [collisionAnchorB.id],
          evidenceDocumentRefs: [collisionAnchorB.documentRef],
        },
      }),
    ).rejects.toThrow(/evidenceAnchorIds|provenance/i);

    await expect(
      buildChronicleSceneEventV2({
        ...collisionInput,
        evidenceAnchors: [
          collisionAnchorA,
          { ...collisionAnchorA, id: "anchor:nul-duplicate" },
        ],
      }),
    ).rejects.toThrow(/sourceRef\/quote|unique/i);
  });

  it("accepts verbatim deduplication subsets and deeply cloned equal observations", async () => {
    const deduplicatedResult = await buildChronicleSceneEventV2({
      ...adapterInput,
      proposalPayload: {
        ...proposal,
        evidenceAnchorIds: [anchor.id, anchorTwo.id],
        evidenceDocumentRefs: [anchor.documentRef, anchorTwo.documentRef],
      },
      hypothesis: {
        ...hypothesis,
        observationRefs: [observation.localId],
      },
      originalObservations: [observation, observationTwo],
      mergedObservations: [observation],
      originalObservationRefs: [observation.localId, observationTwo.localId],
      mergedObservationRefs: [observation.localId],
      evidenceAnchors: [anchor, anchorTwo],
    });
    expect(validateChronicleSceneEventV2(deduplicatedResult.envelope)).toEqual({
      valid: true,
    });

    const clonedObservation = cloneObservation(observation);
    expect(clonedObservation).toEqual(observation);
    expect(clonedObservation).not.toBe(observation);
    const clonedResult = await buildChronicleSceneEventV2({
      ...adapterInput,
      mergedObservations: [clonedObservation],
    });
    expect(validateChronicleSceneEventV2(clonedResult.envelope)).toEqual({
      valid: true,
    });
  });

  it("refuses a lossy hypothesis or missing resolved evidence provenance", async () => {
    const missingObservations = {
      ...adapterInput,
      originalObservations: [],
      mergedObservations: [],
      originalObservationRefs: [],
      mergedObservationRefs: [],
    };
    await expect(
      buildChronicleSceneEventV2(missingObservations),
    ).rejects.toThrow(/provenance|observation/i);

    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        evidenceAnchors: [],
      }),
    ).rejects.toThrow(/evidence|anchor/i);
  });

  it("refuses an already-satisfied match and keeps Proposal payload binding separate", async () => {
    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        existingEventMatch: {
          status: "already-satisfied",
          existingRef: "event:existing",
        },
      }),
    ).rejects.toThrow(/already-satisfied/i);

    const result = await buildChronicleSceneEventV2(adapterInput);
    expect(result.proposalPayload).toEqual(proposal);
    expect(result.proposalPayloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.envelope.assertion.payloadSchemaRef).not.toEqual(
      result.envelope.projectionBinding.proposalSchemaRef,
    );
  });

  it("rejects a Context Set that does not match the audited E2 digest seam", async () => {
    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        contextManifests: [
          {
            ...contextManifests[0]!,
            inputRef: "source:scene:tampered",
          },
        ],
      }),
    ).rejects.toThrow(/context.?set.*digest/i);
  });

  it("rejects an Observation-stage Context Set at the Event Synthesis adapter boundary", async () => {
    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        contextManifests: [
          {
            ...contextManifests[0]!,
            stageId: NARRATIVE_STAGE_IDS.observationExtraction,
          },
        ],
      }),
    ).rejects.toThrow(/expected.*narrative_event_synthesize|Context Set/i);
  });

  it("accepts an empty Chronicle Proposal note as a string", async () => {
    await expect(
      deriveChronicleSceneEventScope({
        sceneRef: nonSecretCase.input.sceneRef,
        proposalPayload: { ...proposal, note: "" },
        revealBasis: nonSecretCase.input
          .revealBasis as ChronicleSceneEventScopeInput["revealBasis"],
      }),
    ).resolves.toMatchObject({ scope: expect.any(Object) });
  });

  it("rejects an invalid Context Set selector before accepting its audit seam", async () => {
    await expect(
      buildChronicleSceneEventV2({
        ...adapterInput,
        contextManifests: [
          {
            ...contextManifests[0]!,
            selector: { kind: "unknown-selector" } as never,
          },
        ],
      }),
    ).rejects.toThrow(/selector/i);
  });

  it("requires exact observation and hypothesis provenance coverage", async () => {
    const multiInput = {
      ...adapterInput,
      proposalPayload: {
        ...proposal,
        evidenceAnchorIds: [anchor.id, anchorTwo.id],
        evidenceDocumentRefs: [anchor.documentRef, anchorTwo.documentRef],
      },
      hypothesis: {
        ...hypothesis,
        observationRefs: [observation.localId, observationTwo.localId],
      },
      originalObservations: [observation, observationTwo],
      mergedObservations: [observation, observationTwo],
      originalObservationRefs: [observation.localId, observationTwo.localId],
      mergedObservationRefs: [observation.localId, observationTwo.localId],
      evidenceAnchors: [anchor, anchorTwo],
    } satisfies ChronicleSceneEventAdapterInput;

    await expect(
      buildChronicleSceneEventV2({
        ...multiInput,
        originalObservationRefs: [observation.localId],
      }),
    ).rejects.toThrow(/originalObservationRefs|observation refs/i);
    await expect(
      buildChronicleSceneEventV2({
        ...multiInput,
        hypothesis: {
          ...multiInput.hypothesis,
          observationRefs: [observation.localId],
        },
      }),
    ).rejects.toThrow(/hypothesis|observation refs/i);
  });

  it("requires resolved Evidence Anchor and document refs to exactly cover observations", async () => {
    const extraAnchor = {
      ...anchor,
      id: "anchor:unused",
      documentRef: "document:unused",
      quote: "Unused.",
    } as unknown as ResolvedEvidenceAnchor;
    const multiInput = {
      ...adapterInput,
      proposalPayload: {
        ...proposal,
        evidenceAnchorIds: [anchor.id, anchorTwo.id, extraAnchor.id],
        evidenceDocumentRefs: [
          anchor.documentRef,
          anchorTwo.documentRef,
          extraAnchor.documentRef,
        ],
      },
      hypothesis: {
        ...hypothesis,
        observationRefs: [observation.localId, observationTwo.localId],
      },
      originalObservations: [observation, observationTwo],
      mergedObservations: [observation, observationTwo],
      originalObservationRefs: [observation.localId, observationTwo.localId],
      mergedObservationRefs: [observation.localId, observationTwo.localId],
      evidenceAnchors: [anchor, anchorTwo, extraAnchor],
    } satisfies ChronicleSceneEventAdapterInput;

    await expect(buildChronicleSceneEventV2(multiInput)).rejects.toThrow(
      /evidence|provenance/i,
    );
  });

  it("executes every shared golden Scope and human-classification case", async () => {
    for (const entry of goldenCorpus.cases) {
      const input = entry.input as unknown as Record<string, unknown>;
      const proposalPayload = (input.proposalPayload ??
        input.editedPayload) as CreateChronicleEventProposalPayloadV1;
      if (
        entry.kind === "human-derivation" &&
        entry.expected.disposition === "reject"
      ) {
        const classification = classifyChronicleSceneEventChanges(
          input.parentPayload,
          input.editedPayload,
        );
        expect(classification.changedPaths, entry.id).toEqual(
          entry.expected.changedPaths,
        );
        expect(classification.disposition, entry.id).toBe("reject");
        if (classification.disposition === "reject") {
          expect(classification.reason, entry.id).toBe(entry.expected.reason);
        }
        continue;
      }
      const scopeInput: ChronicleSceneEventScopeInput = {
        sceneRef: input.sceneRef as string,
        proposalPayload,
        revealBasis:
          input.revealBasis as ChronicleSceneEventScopeInput["revealBasis"],
      };
      const derived = await deriveChronicleSceneEventScope(scopeInput);
      expect(derived.canonicalJson, entry.id).toBe(
        entry.expected.canonicalScopeJson,
      );
      expect(derived.digest, entry.id).toBe(entry.expected.scopeDigest);

      if (entry.kind === "human-derivation") {
        const classification = classifyChronicleSceneEventChanges(
          input.parentPayload,
          input.editedPayload,
        );
        expect(classification.changedPaths, entry.id).toEqual(
          entry.expected.changedPaths,
        );
        expect(classification.disposition, entry.id).toBe(
          entry.expected.disposition,
        );
        if (
          entry.expected.disposition === "accept" &&
          classification.disposition === "accept"
        ) {
          expect(classification.derivationKind, entry.id).toBe(
            entry.expected.derivationKind,
          );
          expect(classification.changedPathClasses, entry.id).toEqual(
            entry.expected.changedPathClasses,
          );
        }
      }
    }
  });
});
