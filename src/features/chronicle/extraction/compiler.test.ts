import { describe, expect, it } from "vitest";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import { compileCreateChronicleEventOperation } from "./compiler";

const snapshot = {
  documents: [
    {
      ref: "D000001",
      origin: {
        kind: "project-node",
        projectId: "project-1",
        nodeId: "scene-1",
        sourceVersion: 3,
      },
    },
  ],
} as unknown as NarrativeCorpusSnapshot;

function proposal(secret: boolean): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId: "event-1",
    title: "宿舎が砲撃される",
    note: null,
    actuality: "actual",
    significance: "scene-level",
    evidenceAnchorIds: ["anchor:one"],
    evidenceDocumentRefs: ["D000001"],
    disclosure: { secret, revealDocumentRef: "D000001" },
    unresolvedMetadata: {
      participantSurfaces: [],
      locationSurface: null,
      temporalExpressions: [],
    },
  };
}

describe("compileCreateChronicleEventOperation", () => {
  // 版の disclosure.secret は IR の関門。年表の出来事は常に secret で作る。
  // Native の compile_current_chronicle_event_operation_payload と同じ規則。
  it.each([false, true])(
    "版の disclosure.secret が %s でも、年表の出来事は secret で作り、reveal は版から導く",
    (versionSecret) => {
      const operation = compileCreateChronicleEventOperation(
        proposal(versionSecret),
        { snapshot },
      );

      expect(operation.payload.secret).toBe(true);
      expect(operation.payload.revealSceneId).toBe("scene-1");
      expect(operation.payload.evidenceSceneLinks).toEqual([
        {
          sceneId: "scene-1",
          expectedSceneVersion: 3,
          evidenceAnchorIds: ["anchor:one"],
        },
      ]);
    },
  );
});
