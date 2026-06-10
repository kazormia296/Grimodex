import { describe, it, expect } from "vitest";
import type { CrossReferenceEntry } from "./crossReference";
import {
  transposeToSceneSets,
  emitCooccurrencePairs,
  cooccurrenceWeightToStrength,
  cooccurrenceWeightToColor,
} from "./cooccurrence";

function entry(
  entryId: string,
  scenes: Array<[sceneId: string, count: number]>,
): CrossReferenceEntry {
  return {
    entryId,
    entryName: entryId,
    entryType: "character",
    scenes: scenes.map(([sceneId, count]) => ({
      sceneId,
      sceneTitle: sceneId,
      count,
    })),
  };
}

describe("transposeToSceneSets", () => {
  it("transposes entries to scene → entryId sets, dropping count", () => {
    const report = [
      entry("a", [
        ["s1", 3],
        ["s2", 1],
      ]),
      entry("b", [["s1", 9]]),
    ];
    const sets = transposeToSceneSets(report);
    expect(sets.get("s1")).toEqual(new Set(["a", "b"]));
    expect(sets.get("s2")).toEqual(new Set(["a"]));
    // count (3, 1, 9) は集合に痕跡を残さない(存在のみ)
    expect(sets.size).toBe(2);
  });
});

describe("emitCooccurrencePairs", () => {
  const entryIds = new Set(["a", "b", "c"]);

  it("counts shared scenes for character pairs", () => {
    const sets = transposeToSceneSets([
      entry("a", [
        ["s1", 1],
        ["s2", 1],
      ]),
      entry("b", [
        ["s1", 1],
        ["s2", 1],
      ]),
    ]);
    const pairs = emitCooccurrencePairs(sets, { entryIds, minSharedScenes: 1 });
    expect(pairs).toEqual([{ aId: "a", bId: "b", sharedScenes: 2 }]);
  });

  it("applies the minSharedScenes threshold", () => {
    const sets = transposeToSceneSets([
      entry("a", [
        ["s1", 1],
        ["s2", 1],
      ]),
      entry("b", [["s1", 1]]),
    ]);
    expect(
      emitCooccurrencePairs(sets, { entryIds, minSharedScenes: 2 }),
    ).toEqual([]);
    expect(
      emitCooccurrencePairs(sets, { entryIds, minSharedScenes: 1 }),
    ).toEqual([{ aId: "a", bId: "b", sharedScenes: 1 }]);
  });

  it("ignores entries outside entryIds (e.g. non-character)", () => {
    const sets = transposeToSceneSets([
      entry("a", [["s1", 1]]),
      entry("loc", [["s1", 1]]), // not in entryIds
    ]);
    const pairs = emitCooccurrencePairs(sets, {
      entryIds: new Set(["a"]),
      minSharedScenes: 1,
    });
    expect(pairs).toEqual([]);
  });

  it("normalizes pairs to aId < bId regardless of input order", () => {
    const sets = transposeToSceneSets([
      entry("c", [["s1", 1]]),
      entry("a", [["s1", 1]]),
    ]);
    const pairs = emitCooccurrencePairs(sets, { entryIds, minSharedScenes: 1 });
    expect(pairs).toEqual([{ aId: "a", bId: "c", sharedScenes: 1 }]);
  });

  it("sorts deterministically by sharedScenes desc, then ids", () => {
    const sets = transposeToSceneSets([
      entry("a", [
        ["s1", 1],
        ["s2", 1],
        ["s3", 1],
      ]),
      entry("b", [
        ["s1", 1],
        ["s2", 1],
        ["s3", 1],
      ]), // a-b: 3
      entry("c", [["s1", 1]]), // a-c: 1, b-c: 1
    ]);
    const pairs = emitCooccurrencePairs(sets, { entryIds, minSharedScenes: 1 });
    expect(pairs).toEqual([
      { aId: "a", bId: "b", sharedScenes: 3 },
      { aId: "a", bId: "c", sharedScenes: 1 },
      { aId: "b", bId: "c", sharedScenes: 1 },
    ]);
  });
});

describe("cooccurrenceWeightToStrength", () => {
  it("stays within [0.2, 0.6] and is monotonic", () => {
    expect(cooccurrenceWeightToStrength(0, 0)).toBeCloseTo(0.2);
    expect(cooccurrenceWeightToStrength(1, 4)).toBeCloseTo(0.3);
    expect(cooccurrenceWeightToStrength(4, 4)).toBeCloseTo(0.6);
    expect(cooccurrenceWeightToStrength(2, 4)).toBeLessThan(
      cooccurrenceWeightToStrength(3, 4),
    );
  });
});

describe("cooccurrenceWeightToColor", () => {
  it("returns the weakest bucket for the degenerate maxShared <= 1", () => {
    expect(cooccurrenceWeightToColor(1, 1)).toBe("#cbd5e1");
  });

  it("maps stronger cooccurrence to darker buckets", () => {
    const weak = cooccurrenceWeightToColor(2, 10);
    const strong = cooccurrenceWeightToColor(10, 10);
    expect(weak).not.toBe(strong);
    expect(strong).toBe("#334155");
  });
});
