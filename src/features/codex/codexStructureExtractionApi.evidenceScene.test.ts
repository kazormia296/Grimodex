import { describe, expect, it } from "vitest";
import { buildRelationEvidenceFromOccurrences } from "./codexStructureExtractionApi";
import type { EntityCandidateOccurrence } from "./extraction/entityCandidatePrepass";

const occurrence = {
  documentRef: "D000001",
  canonicalRange: { start: 5, end: 9 },
  context: { prefix: "前文", suffix: "後文" },
  evidence: { id: "anchor-1" },
} as EntityCandidateOccurrence;

describe("buildRelationEvidenceFromOccurrences scene metadata", () => {
  it("adds scene metadata when supplied and preserves the old call shape", () => {
    const scenes = new Map([
      ["D000001", { sceneId: "scene-1", sceneTitle: "Scene 1" }],
    ]);
    const withScene = buildRelationEvidenceFromOccurrences(
      [occurrence],
      undefined,
      scenes,
    );
    const withoutScene = buildRelationEvidenceFromOccurrences([occurrence]);

    expect(withScene[0]).toMatchObject({
      sceneId: "scene-1",
      sceneTitle: "Scene 1",
    });
    expect(withoutScene[0]).not.toHaveProperty("sceneId");
    expect(withoutScene[0]).not.toHaveProperty("sceneTitle");
    expect(withScene[0]).toMatchObject({
      anchorId: withoutScene[0]?.anchorId,
      quote: withoutScene[0]?.quote,
      documentRef: withoutScene[0]?.documentRef,
      method: withoutScene[0]?.method,
      blocked: withoutScene[0]?.blocked,
      canonicalRange: withoutScene[0]?.canonicalRange,
    });
  });
});
