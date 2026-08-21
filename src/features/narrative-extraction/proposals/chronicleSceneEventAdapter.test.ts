import { describe, expect, it } from "vitest";

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

const proposal = nonSecretCase.input.proposalPayload as unknown as CreateChronicleEventProposalPayloadV1;

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

const sourceBasis: SourceBasis = [
  {
    sourceKind: "scene-body",
    sourceKey: "scene:1",
    revisionToken: "revision:1",
  },
];

const contextManifests: readonly ContextSetEntry[] = [
  {
    contextId: "context:observation",
    inputRef: "source:scene:1",
    stageId: "narrative_observation_extract",
    exposure: "model-visible",
    selector: { kind: "whole-source" },
  },
];

const dependencyDeclarations: readonly DependencySetEntry[] = [
  {
    dependencyId: "dependency:evidence",
    inputRef: "source:scene:1",
    contextIds: ["context:observation"],
    role: "direct-evidence",
    selector: { kind: "whole-source" },
  },
];

const existingEventMatch: ChronicleExistingMatch = { status: "none" };

const adapterInput: ChronicleSceneEventAdapterInput = {
  execution: {
    runId: "run:chronicle",
    taskId: "task:event-synthesis",
    reconcilerId: "chronicle.reconciler",
    reconcilerVersion: "1",
    componentContractDigest: DIGEST,
    finalRequestDigest: DIGEST,
  },
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
  revealBasis: nonSecretCase.input.revealBasis,
};

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
    expect(result.existingEventMatch).toEqual(existingEventMatch);
    expect(validateChronicleSceneEventV2(result.envelope)).toEqual({
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
    await expect(buildChronicleSceneEventV2(missingObservations)).rejects.toThrow(
      /provenance|observation/i,
    );

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

  it("executes every shared golden Scope and human-classification case", async () => {
    for (const entry of goldenCorpus.cases) {
      const input = entry.input as unknown as Record<string, unknown>;
      const proposalPayload = (input.proposalPayload ??
        input.editedPayload) as CreateChronicleEventProposalPayloadV1;
      const scopeInput: ChronicleSceneEventScopeInput = {
        sceneRef: input.sceneRef as string,
        proposalPayload,
        revealBasis: input.revealBasis as ChronicleSceneEventScopeInput["revealBasis"],
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
        if (entry.expected.disposition === "accept") {
          expect(classification.derivationKind, entry.id).toBe(
            entry.expected.derivationKind,
          );
          expect(classification.changedPathClasses, entry.id).toEqual(
            entry.expected.changedPathClasses,
          );
        } else {
          expect(classification.reason, entry.id).toBe(
            entry.expected.reason,
          );
        }
      }
    }
  });
});
