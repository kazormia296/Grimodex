import { describe, expect, it } from "vitest";
import { averageEvaluation, scoreScanCase } from "../src/index.js";

describe("scan evaluation scoring", () => {
  it("scores recall, alias precision, evidence validity and JSON validity", () => {
    const score = scoreScanCase(
      {
        id: "ja-1",
        expectedEntities: [{ name: "葵", aliases: ["アオイ"] }],
        expectedEvidence: [{ sectionId: "s1", paragraphId: "p1" }],
      },
      [
        {
          id: "entity:11111111-1111-4111-8111-111111111111",
          type: "character",
          name: "葵",
          aliases: ["アオイ", "別名"],
          evidence: [],
          confidence: 0.9,
        },
      ],
      [{ sectionId: "s1", paragraphId: "p1" }],
      true,
    );
    expect(score.entityRecall).toBe(1);
    expect(score.aliasPrecision).toBe(0.5);
    expect(score.evidenceValidity).toBe(1);
    expect(averageEvaluation([score])).toEqual(score);
  });
});
