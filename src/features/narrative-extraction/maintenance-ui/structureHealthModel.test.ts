import { describe, expect, it } from "vitest";
import {
  buildPreviewStructureHealthSummary,
  summarizeFreshnessCounts,
} from "./structureHealthModel";

describe("structureHealthModel", () => {
  it("exposes preview counts without claiming live Change Feed data", () => {
    const summary = buildPreviewStructureHealthSummary();
    expect(summary.mode).toBe("deterministic");
    expect(summary.freshness.fresh).toBeGreaterThan(0);
    expect(summarizeFreshnessCounts(summary).length).toBeGreaterThan(0);
  });
});
