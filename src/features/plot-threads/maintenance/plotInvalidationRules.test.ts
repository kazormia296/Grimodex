import { describe, expect, it } from "vitest";
import { advisePlotInvalidation } from "./plotInvalidationRules";

describe("advisePlotInvalidation", () => {
  it("does not change phaseType on story-time updates", () => {
    expect(advisePlotInvalidation("story-time").changesPhaseType).toBe(false);
  });

  it("marks reading-order as affecting phaseType assignment", () => {
    expect(advisePlotInvalidation("reading-order").changesPhaseType).toBe(true);
  });
});
