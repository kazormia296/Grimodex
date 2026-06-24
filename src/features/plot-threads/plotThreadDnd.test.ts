import { describe, it, expect } from "vitest";
import { resolveMarkerDrop } from "./plotThreadDnd";

// ドロップ列のライブスロット Y(px): a(100), b(156), c(212)。
const columnSlots = [
  { threadId: "a", y: 100 },
  { threadId: "b", y: 156 },
  { threadId: "c", y: 212 },
];

describe("resolveMarkerDrop（ライブスロット順）", () => {
  it("同レーン（最寄りスロットが自スレッド）→ シーン移動", () => {
    const r = resolveMarkerDrop({
      dropY: 102,
      sourceThreadId: "a",
      nodeId: "s2",
      columnSlots,
    });
    expect(r).toEqual({ type: "move-scene", nodeId: "s2" });
  });

  it("別レーン(下=y 大)へドロップ → branch", () => {
    const r = resolveMarkerDrop({
      dropY: 156,
      sourceThreadId: "a",
      nodeId: "s2",
      columnSlots,
    });
    expect(r).toEqual({
      type: "branch",
      fromThreadId: "a",
      toThreadId: "b",
      atNodeId: "s2",
      kind: "branch",
    });
  });

  it("別レーン(上=y 小)へドロップ → merge", () => {
    const r = resolveMarkerDrop({
      dropY: 100,
      sourceThreadId: "b",
      nodeId: "s1",
      columnSlots,
    });
    expect(r).toEqual({
      type: "branch",
      fromThreadId: "b",
      toThreadId: "a",
      atNodeId: "s1",
      kind: "merge",
    });
  });

  it("方向は固定 sortOrder ではなくライブスロット Y で決まる（束ねで反転しても追従）", () => {
    // ライブ順が c(上), a(下) に再配置された列。a→c へドロップ＝上 → merge。
    const reordered = [
      { threadId: "c", y: 100 },
      { threadId: "a", y: 156 },
    ];
    const r = resolveMarkerDrop({
      dropY: 100,
      sourceThreadId: "a",
      nodeId: "s2",
      columnSlots: reordered,
    });
    expect(r).toMatchObject({
      type: "branch",
      fromThreadId: "a",
      toThreadId: "c",
      kind: "merge",
    });
  });

  it("方向は columnSlots の配列順ではなく実 Y で決まる（配列順と逆でも追従）", () => {
    // columnSlots の配列順は a→b（昇順）だが、ライブ Y は b が上(100)・a が下(200)。
    // a を b(上, y100) へドロップ → 上 = merge。配列 index 比較なら branch になり誤判定。
    const inverted = [
      { threadId: "a", y: 200 },
      { threadId: "b", y: 100 },
    ];
    const r = resolveMarkerDrop({
      dropY: 100,
      sourceThreadId: "a",
      nodeId: "s2",
      columnSlots: inverted,
    });
    expect(r).toMatchObject({
      type: "branch",
      fromThreadId: "a",
      toThreadId: "b",
      kind: "merge",
    });
  });

  it("最寄りシーンが無ければ none", () => {
    const r = resolveMarkerDrop({
      dropY: 100,
      sourceThreadId: "a",
      nodeId: undefined,
      columnSlots,
    });
    expect(r).toEqual({ type: "none" });
  });

  it("列にレーンが無ければ none", () => {
    const r = resolveMarkerDrop({
      dropY: 0,
      sourceThreadId: "a",
      nodeId: "s1",
      columnSlots: [],
    });
    expect(r).toEqual({ type: "none" });
  });
});
