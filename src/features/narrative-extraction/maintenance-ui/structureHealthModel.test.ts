import { describe, expect, it } from "vitest";
import { buildStructureHealthPreview } from "./structureHealthModel";

describe("structureHealthModel", () => {
  it("keeps the Gate C0 preview truthful and inert", () => {
    expect(buildStructureHealthPreview()).toEqual({
      phase: "foundation-only",
      liveCountsAvailable: false,
      automaticRepairEnabled: false,
      idleSchedulerEnabled: false,
      backgroundAiEnabled: false,
    });
  });
});
