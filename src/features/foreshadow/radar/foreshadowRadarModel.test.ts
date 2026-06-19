import { describe, it, expect } from "vitest";
import { buildForeshadowRadarModel } from "./foreshadowRadarModel";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { DerivedLabel, ForeshadowWithLabel } from "../types";

function makeF(p: {
  id: string;
  label: DerivedLabel;
  title?: string;
  intent?: string | null;
  payoffSceneId?: string | null;
  payoffConfirmed?: boolean;
  payoffFromPos?: number | null;
  payoffToPos?: number | null;
  abandoned?: boolean;
  setupCount?: number;
}): ForeshadowWithLabel {
  return {
    id: p.id,
    projectId: "proj",
    title: p.title ?? p.id,
    intent: p.intent ?? null,
    notes: null,
    payoffSceneId: p.payoffSceneId ?? null,
    payoffFromPos: p.payoffFromPos ?? null,
    payoffToPos: p.payoffToPos ?? null,
    payoffConfirmed: p.payoffConfirmed ?? false,
    abandoned: p.abandoned ?? false,
    secret: false,
    loadBearing: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    label: p.label,
    setupCount: p.setupCount ?? 0,
  };
}

// 読書順: s0..s3 → 0..3 (maxIndex = 3)
const ORDER = new Map<string, number>([
  ["s0", 0],
  ["s1", 1],
  ["s2", 2],
  ["s3", 3],
]);

describe("buildForeshadowRadarModel", () => {
  it("確定回収 (paid) は最早 setup → payoff の実線アークになる", () => {
    const items = [
      makeF({
        id: "f1",
        label: "paid",
        payoffSceneId: "s3",
        payoffConfirmed: true,
        payoffFromPos: 5,
        payoffToPos: 9,
        setupCount: 1,
      }),
    ];
    const model = buildForeshadowRadarModel(items, { f1: ["s1"] }, ORDER, []);
    expect(model.arcs).toHaveLength(1);
    const a = model.arcs[0];
    expect(a).toMatchObject({
      foreshadowId: "f1",
      startIndex: 1,
      startSceneId: "s1",
      endIndex: 3,
      endSceneId: "s3",
      payoffFromPos: 5,
      payoffToPos: 9,
      open: false,
      broken: false,
      span: 2,
    });
    expect(model.summary.paid).toBe(1);
    expect(model.summary.total).toBe(1);
    expect(model.summary.recoveryRate).toBe(1);
    expect(model.maxIndex).toBe(3);
  });

  it("未回収 (seeded) は setup → フロンティアへダングリング (endIndex null, open)", () => {
    const items = [makeF({ id: "f2", label: "seeded", setupCount: 1 })];
    const model = buildForeshadowRadarModel(items, { f2: ["s0"] }, ORDER, []);
    expect(model.arcs).toHaveLength(1);
    expect(model.arcs[0]).toMatchObject({
      startIndex: 0,
      endIndex: null,
      open: true,
      broken: false,
      span: 3, // maxIndex - 0
    });
    expect(model.summary.open).toBe(1);
    expect(model.summary.recoveryRate).toBe(0);
  });

  it("orphan_payoff は setup 不在・payoff マーカーのみ (startIndex null)", () => {
    const items = [
      makeF({
        id: "f3",
        label: "orphan_payoff",
        payoffSceneId: "s2",
        payoffConfirmed: true,
        setupCount: 0,
      }),
    ];
    const model = buildForeshadowRadarModel(items, {}, ORDER, []);
    expect(model.arcs).toHaveLength(1);
    expect(model.arcs[0]).toMatchObject({
      startIndex: null,
      endIndex: 2,
      open: false,
      span: 0,
    });
    expect(model.summary.atRisk).toBe(1);
  });

  it("planned で setup も payoff も無いものは floating (未配置)", () => {
    const items = [makeF({ id: "f4", label: "planned", setupCount: 0 })];
    const model = buildForeshadowRadarModel(items, {}, ORDER, []);
    expect(model.arcs).toHaveLength(0);
    expect(model.floating).toEqual([
      { foreshadowId: "f4", title: "f4", label: "planned" },
    ]);
    expect(model.summary.open).toBe(1); // planned は未回収として集計
  });

  it("abandoned はアーク・floating どちらにも出さず total から除外する", () => {
    const items = [
      makeF({ id: "f5", label: "abandoned", abandoned: true, setupCount: 1 }),
      makeF({ id: "f1", label: "seeded", setupCount: 1 }),
    ];
    const model = buildForeshadowRadarModel(
      items,
      { f5: ["s0"], f1: ["s1"] },
      ORDER,
      [],
    );
    expect(model.arcs.map((a) => a.foreshadowId)).toEqual(["f1"]);
    expect(model.floating).toHaveLength(0);
    expect(model.summary.abandoned).toBe(1);
    expect(model.summary.total).toBe(1); // seeded のみ
  });

  it("回収確定だが回収先シーンが読書順に無い → broken (endIndex null, open false)", () => {
    const items = [
      makeF({
        id: "f6",
        label: "paid",
        payoffSceneId: "deleted",
        payoffConfirmed: true,
        setupCount: 1,
      }),
    ];
    const model = buildForeshadowRadarModel(items, { f6: ["s0"] }, ORDER, []);
    expect(model.arcs[0]).toMatchObject({
      startIndex: 0,
      endIndex: null,
      broken: true,
      open: false,
    });
  });

  it("最早 setup を採用する (順不同の setup から最小読書順)", () => {
    const items = [makeF({ id: "f7", label: "seeded", setupCount: 2 })];
    const model = buildForeshadowRadarModel(
      items,
      { f7: ["s3", "s1"] },
      ORDER,
      [],
    );
    expect(model.arcs[0]).toMatchObject({ startIndex: 1, startSceneId: "s1" });
  });

  it("削除済み setup は無視し、生きている setup を採用する", () => {
    const items = [makeF({ id: "f8", label: "seeded", setupCount: 1 })];
    const model = buildForeshadowRadarModel(
      items,
      { f8: ["deleted", "s2"] },
      ORDER,
      [],
    );
    expect(model.arcs[0]).toMatchObject({ startIndex: 2, startSceneId: "s2" });
  });

  it("setup が全て削除済みで payoff も無いものは floating", () => {
    const items = [makeF({ id: "f9", label: "seeded", setupCount: 1 })];
    const model = buildForeshadowRadarModel(
      items,
      { f9: ["deleted"] },
      ORDER,
      [],
    );
    expect(model.arcs).toHaveLength(0);
    expect(model.floating.map((f) => f.foreshadowId)).toEqual(["f9"]);
  });

  it("同じ開始位置のアークは foreshadowId で決定的にソートする", () => {
    const items = [
      makeF({ id: "fB", label: "seeded", setupCount: 1 }),
      makeF({ id: "fA", label: "seeded", setupCount: 1 }),
    ];
    const model = buildForeshadowRadarModel(
      items,
      { fA: ["s0"], fB: ["s0"] },
      ORDER,
      [],
    );
    expect(model.arcs.map((a) => a.foreshadowId)).toEqual(["fA", "fB"]);
  });

  it("非 abandoned が無いとき recoveryRate は 0", () => {
    const items = [makeF({ id: "f5", label: "abandoned", abandoned: true })];
    const model = buildForeshadowRadarModel(items, {}, ORDER, []);
    expect(model.summary.total).toBe(0);
    expect(model.summary.recoveryRate).toBe(0);
    expect(model.arcs).toHaveLength(0);
    expect(model.floating).toHaveLength(0);
  });

  it("章バンドを読書順で連続するトップレベルフォルダ単位にまとめる", () => {
    const nodes = [
      { id: "c1", parentId: null, nodeType: "folder", title: "第1章" },
      { id: "s0", parentId: "c1", nodeType: "scene", title: "s0" },
      { id: "s1", parentId: "c1", nodeType: "scene", title: "s1" },
      { id: "s2", parentId: null, nodeType: "scene", title: "s2" },
    ] as unknown as TreeNodeData[];
    const order = new Map<string, number>([
      ["s0", 0],
      ["s1", 1],
      ["s2", 2],
    ]);
    const model = buildForeshadowRadarModel([], {}, order, nodes);
    expect(model.bands).toEqual([
      { key: "c1", label: "第1章", startIndex: 0, endIndex: 1 },
      { key: "__root__", label: null, startIndex: 2, endIndex: 2 },
    ]);
  });
});
