import { describe, it, expect } from "vitest";
import { resolveMarkerDrop } from "./plotThreadDnd";

// レーン: a(y=100), b(y=156), c(y=212)。laneHeight=56。
const lanes = [
  { threadId: "a", y: 100 },
  { threadId: "b", y: 156 },
  { threadId: "c", y: 212 },
];
// xOf: index*96 + 48 → 最寄り scheduled シーン id
const xOf = (i: number) => 48 + i * 96;
const sceneIdAt = ["s1", "s2", "s3"];
const nearestSceneId = (x: number) => {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(xOf(i) - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return sceneIdAt[best];
};

const base = { lanes, laneHeight: 56, nearestSceneId };

describe("resolveMarkerDrop", () => {
  it("同レーン内ドロップ → シーン移動（最寄りシーン）", () => {
    const r = resolveMarkerDrop({
      ...base,
      dropX: 144,
      dropY: 100,
      sourceThreadId: "a",
    });
    expect(r).toEqual({ type: "move-scene", nodeId: "s2" });
  });

  it("別レーン(下)へドロップ → その列で branch", () => {
    // a(index0) を b(index1, y=156) の s2 列(x144)へ
    const r = resolveMarkerDrop({
      ...base,
      dropX: 144,
      dropY: 156,
      sourceThreadId: "a",
    });
    expect(r).toEqual({
      type: "branch",
      fromThreadId: "a",
      toThreadId: "b",
      atNodeId: "s2",
      kind: "branch",
    });
  });

  it("別レーン(上)へドロップ → その列で merge", () => {
    // b(index1) を a(index0, y=100) の s1 列(x48)へ
    const r = resolveMarkerDrop({
      ...base,
      dropX: 48,
      dropY: 100,
      sourceThreadId: "b",
    });
    expect(r).toEqual({
      type: "branch",
      fromThreadId: "b",
      toThreadId: "a",
      atNodeId: "s1",
      kind: "merge",
    });
  });

  it("別レーンならマーカーの有無に関わらず drop 列で分岐する", () => {
    // a を c レーン(y212) の s3 列(x240)へ（c にマーカー無くても branch）
    const r = resolveMarkerDrop({
      ...base,
      dropX: 240,
      dropY: 212,
      sourceThreadId: "a",
    });
    expect(r).toEqual({
      type: "branch",
      fromThreadId: "a",
      toThreadId: "c",
      atNodeId: "s3",
      kind: "branch",
    });
  });

  it("最寄りシーンが無ければ none", () => {
    const r = resolveMarkerDrop({
      ...base,
      nearestSceneId: () => undefined,
      dropX: 0,
      dropY: 100,
      sourceThreadId: "a",
    });
    expect(r).toEqual({ type: "none" });
  });

  it("レーンが無ければ none", () => {
    const r = resolveMarkerDrop({
      ...base,
      lanes: [],
      dropX: 0,
      dropY: 0,
      sourceThreadId: "a",
    });
    expect(r).toEqual({ type: "none" });
  });
});
