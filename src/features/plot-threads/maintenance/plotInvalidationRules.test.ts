import { describe, expect, it } from "vitest";
import { advisePlotInvalidation } from "./plotInvalidationRules";

describe("advisePlotInvalidation", () => {
  it("never auto-applies any Gate C0 advice", () => {
    const signals = [
      "scene-content",
      "reading-order",
      "story-time",
      "scene-add-or-delete",
    ] as const;
    for (const signal of signals) {
      expect(advisePlotInvalidation(signal).autoApply).toBe(false);
    }
  });

  it("does not change phaseType on story-time updates", () => {
    expect(advisePlotInvalidation("story-time").changesPhaseType).toBe(false);
  });

  it("marks reading-order as affecting phaseType assignment", () => {
    expect(advisePlotInvalidation("reading-order").changesPhaseType).toBe(true);
  });
});
