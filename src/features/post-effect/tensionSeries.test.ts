import { describe, it, expect } from "vitest";
import { buildTensionSeries, detectSaggyRuns } from "./tensionSeries";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { SceneLensRecord } from "./types";

function scene(id: string, parentId: string | null, sortOrder: string, title = id): TreeNodeData {
  return {
    id, projectId: "p1", parentId, nodeType: "scene", title,
    synopsis: null, intent: null, sortOrder, status: null,
    storyTimeOrder: null, storyTimeLabel: null, povCharacterId: null,
    locationId: null, charCount: 0,
  } as TreeNodeData;
}
function lens(sceneId: string, lensType: string, tension: unknown): SceneLensRecord {
  return {
    id: `${sceneId}-${lensType}`, projectId: "p1", runId: "r1", targetId: sceneId,
    lensType: lensType as SceneLensRecord["lensType"],
    metrics: tension === undefined ? {} : { tension },
    finding: "x", severity: "info", createdAt: "2024-01-01T00:00:00Z", runCompletedAt: null,
  };
}

describe("buildTensionSeries", () => {
  it("読了順で plot_structure の tension を引き、isChapterEnd を立てる", () => {
    const nodes = [scene("s2", "f1", "b"), scene("s1", "f1", "a"), scene("s3", "f2", "c")];
    const by = new Map<string, SceneLensRecord[]>([
      ["s1", [lens("s1", "plot_structure", 0.6), lens("s1", "pacing", undefined)]],
      ["s2", [lens("s2", "plot_structure", 0.2)]],
      ["s3", [lens("s3", "pacing", 0.9)]],
    ]);
    const out = buildTensionSeries(nodes, by);
    expect(out.map((p) => p.sceneId)).toEqual(["s1", "s2", "s3"]);
    expect(out.map((p) => p.tension)).toEqual([0.6, 0.2, null]);
    expect(out.map((p) => p.isChapterEnd)).toEqual([false, true, true]);
  });
  it("metrics.tension が数値でない/範囲外は null/クランプ", () => {
    const nodes = [scene("s1", null, "a"), scene("s2", null, "b")];
    const by = new Map<string, SceneLensRecord[]>([
      ["s1", [lens("s1", "plot_structure", "high")]],
      ["s2", [lens("s2", "plot_structure", 1.5)]],
    ]);
    const out = buildTensionSeries(nodes, by);
    expect(out[0].tension).toBeNull();
    expect(out[1].tension).toBe(1);
  });
});

describe("detectSaggyRuns", () => {
  const mk = (tensions: (number | null)[]) =>
    tensions.map((t, i) => ({ sceneId: `s${i}`, title: `s${i}`, tension: t, parentId: null, isChapterEnd: false }));
  it("閾値以下が連続2以上で検出、単発は無視", () => {
    expect(detectSaggyRuns(mk([0.8, 0.2, 0.3, 0.7, 0.1]), 0.35)).toEqual([{ startIdx: 1, endIdx: 2 }]);
  });
  it("null は区間を分断する", () => {
    expect(detectSaggyRuns(mk([0.2, null, 0.2, 0.2]), 0.35)).toEqual([{ startIdx: 2, endIdx: 3 }]);
  });
  it("末尾までの連続区間も検出", () => {
    expect(detectSaggyRuns(mk([0.9, 0.3, 0.3]), 0.35)).toEqual([{ startIdx: 1, endIdx: 2 }]);
  });
});
