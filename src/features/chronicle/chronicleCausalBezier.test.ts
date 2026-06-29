import { describe, expect, it } from "vitest";
import { buildCausalBezier, type CausalRel } from "./chronicleCausalBezier";

const centers = new Map<string, { cx: number; cy: number }>([
  ["a", { cx: 0, cy: 0 }],
  ["b", { cx: 100, cy: 50 }],
  ["c", { cx: 200, cy: -30 }],
]);

describe("buildCausalBezier", () => {
  it('produces a path that starts with "M " and contains " C "', () => {
    const relations: CausalRel[] = [{ causeId: "a", effectId: "b" }];
    const edges = buildCausalBezier({
      relations,
      centers,
      conflictPairs: new Set(),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].d.startsWith("M ")).toBe(true);
    expect(edges[0].d).toContain(" C ");
  });

  it("emits arrowPoints with exactly 3 coordinate pairs", () => {
    const edges = buildCausalBezier({
      relations: [{ causeId: "a", effectId: "b" }],
      centers,
      conflictPairs: new Set(),
    });
    const pairs = edges[0].arrowPoints.split(" ");
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) {
      const coords = pair.split(",");
      expect(coords).toHaveLength(2);
      expect(Number.isNaN(Number(coords[0]))).toBe(false);
      expect(Number.isNaN(Number(coords[1]))).toBe(false);
    }
  });

  it("reflects conflictPairs membership in the conflict flag", () => {
    const edges = buildCausalBezier({
      relations: [
        { causeId: "a", effectId: "b" },
        { causeId: "b", effectId: "c" },
      ],
      centers,
      conflictPairs: new Set(["b|c"]),
    });
    const ab = edges.find((e) => e.causeId === "a" && e.effectId === "b");
    const bc = edges.find((e) => e.causeId === "b" && e.effectId === "c");
    expect(ab?.conflict).toBe(false);
    expect(bc?.conflict).toBe(true);
  });

  it("skips a relation whose cause or effect center is missing", () => {
    const edges = buildCausalBezier({
      relations: [
        { causeId: "a", effectId: "missing" },
        { causeId: "missing", effectId: "b" },
        { causeId: "a", effectId: "b" },
      ],
      centers,
      conflictPairs: new Set(),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].causeId).toBe("a");
    expect(edges[0].effectId).toBe("b");
  });

  it('orders edges deterministically by "cause|effect"', () => {
    const relations: CausalRel[] = [
      { causeId: "b", effectId: "c" },
      { causeId: "a", effectId: "c" },
      { causeId: "a", effectId: "b" },
    ];
    const edges = buildCausalBezier({
      relations,
      centers,
      conflictPairs: new Set(),
    });
    const keys = edges.map((e) => `${e.causeId}|${e.effectId}`);
    expect(keys).toEqual(["a|b", "a|c", "b|c"]);
  });
});
