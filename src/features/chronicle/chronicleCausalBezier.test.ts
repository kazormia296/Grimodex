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

  it("原因側は末尾 outX から出し、結果側は先頭 cx へ入る", () => {
    const c = new Map<string, { cx: number; cy: number; outX?: number }>([
      ["a", { cx: 10, cy: 0, outX: 40 }], // 原因: 先頭10・末尾40
      ["b", { cx: 100, cy: 0 }], // 結果: 先頭100
    ]);
    const edges = buildCausalBezier({
      relations: [{ causeId: "a", effectId: "b" }],
      centers: c,
      conflictPairs: new Set(),
    });
    // 出力は末尾(40,0)から、入力は結果先頭(100,0)で終端。
    expect(edges[0].d.startsWith("M 40 0 ")).toBe(true);
    expect(edges[0].d.endsWith(" 100 0")).toBe(true);
  });

  it("outX 未指定なら従来どおり先頭 cx から出る（後方互換）", () => {
    const edges = buildCausalBezier({
      relations: [{ causeId: "a", effectId: "b" }],
      centers, // outX なし → a.cx=0 から
      conflictPairs: new Set(),
    });
    expect(edges[0].d.startsWith("M 0 0 ")).toBe(true);
  });

  it("dx<0（原因が結果の右）でも末尾→先頭で描き、矢印は結果側を指す", () => {
    // 時系列の重なりで原因マーカーが結果より右に来るケース（S字になる）。
    const c = new Map<string, { cx: number; cy: number; outX?: number }>([
      ["a", { cx: 200, cy: 0, outX: 250 }], // 原因: 末尾250（結果より右）
      ["b", { cx: 50, cy: 0 }], // 結果: 先頭50
    ]);
    const edges = buildCausalBezier({
      relations: [{ causeId: "a", effectId: "b" }],
      centers: c,
      conflictPairs: new Set(),
    });
    // 出力は原因末尾(250,0)から始まり、入力は結果先頭(50,0)で終端（向きは保たれる）。
    expect(edges[0].d.startsWith("M 250 0 ")).toBe(true);
    expect(edges[0].d.endsWith(" 50 0")).toBe(true);
    // 矢印の先端は結果側 (50,0)。3 点のうち先頭ペアが頂点。
    const tip = edges[0].arrowPoints.split(" ")[0];
    expect(tip).toBe("50,0");
    // 制御点は有限値（NaN を出さない）。
    for (const nstr of edges[0].d
      .replace("M ", "")
      .replace(" C ", " ")
      .split(" ")) {
      expect(Number.isNaN(Number(nstr))).toBe(false);
    }
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
