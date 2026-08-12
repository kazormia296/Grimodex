import { describe, expect, it } from "vitest";
import {
  singleSegmentPartition,
  validateBoundaries,
} from "./documentPartition";

describe("documentPartition", () => {
  it("accepts a partition covering all blocks exactly once", () => {
    const blockIds = ["b1", "b2", "b3"];
    const proposal = singleSegmentPartition(
      "r1",
      "chapter.md",
      "Chapter",
      blockIds,
    );
    const result = validateBoundaries(proposal, blockIds);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("rejects duplicate block assignments", () => {
    const proposal = {
      resourceKey: "r1",
      relativePath: "chapter.md",
      segments: [
        { segmentId: "s1", title: "A", blockIds: ["b1", "b2"] },
        { segmentId: "s2", title: "B", blockIds: ["b2"] },
      ],
    };
    const result = validateBoundaries(proposal, ["b1", "b2"]);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((d) => d.code === "partition-duplicate-block"),
    ).toBe(true);
  });

  it("rejects missing blocks", () => {
    const proposal = singleSegmentPartition("r1", "chapter.md", "Chapter", [
      "b1",
    ]);
    const result = validateBoundaries(proposal, ["b1", "b2"]);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((d) => d.code === "partition-missing-block"),
    ).toBe(true);
  });
});
