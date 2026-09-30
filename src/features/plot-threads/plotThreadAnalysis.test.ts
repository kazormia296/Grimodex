import { describe, it, expect } from "vitest";
import type { PlotThreadLinkRow } from "./api";
import type { PlotPhaseType } from "@/db/schema";
import {
  computeThreadDormancy,
  computeThreadPhaseProgress,
} from "./plotThreadAnalysis";

function link(
  threadId: string,
  nodeId: string,
  phaseType: PlotPhaseType = "develop",
): PlotThreadLinkRow {
  return {
    id: `${threadId}-${nodeId}-${phaseType}`,
    threadId,
    nodeId,
    phaseType,
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  };
}

// 軸 index: s0..s5 を 0..5 に並べた Timeline を想定。
const indexById = new Map<string, number>([
  ["s0", 0],
  ["s1", 1],
  ["s2", 2],
  ["s3", 3],
  ["s4", 4],
  ["s5", 5],
]);
const TAIL = 5;

describe("computeThreadDormancy", () => {
  it("現在シーンにマーカーがある → active (今)", () => {
    const links = [link("t1", "s1"), link("t1", "s3")];
    const d = computeThreadDormancy(links, "t1", indexById, 3, TAIL);
    expect(d.state).toBe("active");
    expect(d.scenesSinceLast).toBe(0);
    expect(d.distanceFromTail).toBe(2); // 5 - 3
  });

  it("直近マーカーが過去 → dormant (+N)", () => {
    const links = [link("t1", "s1")];
    const d = computeThreadDormancy(links, "t1", indexById, 4, TAIL);
    expect(d.state).toBe("dormant");
    expect(d.scenesSinceLast).toBe(3); // 4 - 1
    expect(d.lastMarkerIndex).toBe(1);
    expect(d.distanceFromTail).toBe(4); // 5 - 1
  });

  it("マーカーが全て未来 → upcoming + scenesUntilNext", () => {
    const links = [link("t1", "s4"), link("t1", "s5")];
    const d = computeThreadDormancy(links, "t1", indexById, 1, TAIL);
    expect(d.state).toBe("upcoming");
    expect(d.scenesSinceLast).toBeNull();
    expect(d.scenesUntilNext).toBe(3); // 4 - 1
    expect(d.nextMarkerIndex).toBe(4);
  });

  it("マーカー無し → unplaced", () => {
    const d = computeThreadDormancy([], "t1", indexById, 2, TAIL);
    expect(d.state).toBe("unplaced");
    expect(d.scenesSinceLast).toBeNull();
    expect(d.distanceFromTail).toBeNull();
  });

  it("indexById に無いマーカー（archived/note）は無視", () => {
    const links = [link("t1", "ghost"), link("t1", "s2")];
    const d = computeThreadDormancy(links, "t1", indexById, 2, TAIL);
    expect(d.state).toBe("active");
    expect(d.lastMarkerIndex).toBe(2);
  });

  it("他スレッドの link は集計しない", () => {
    const links = [link("t1", "s1"), link("t2", "s3")];
    const d = computeThreadDormancy(links, "t1", indexById, 3, TAIL);
    expect(d.lastMarkerIndex).toBe(1);
    expect(d.scenesSinceLast).toBe(2);
  });
});

describe("computeThreadPhaseProgress", () => {
  const written = new Map<string, string | null>([
    ["s1", "complete"],
    ["s2", "final"],
    ["s3", "draft"],
    ["s4", null],
  ]);

  it("present の phase は drafted、書けた scene があれば written", () => {
    const links = [
      link("t1", "s1", "introduce"), // complete → written
      link("t1", "s3", "develop"), // draft → drafted
    ];
    const p = computeThreadPhaseProgress(links, "t1", written);
    expect(p.cells.introduce).toBe("written");
    expect(p.cells.develop).toBe("drafted");
    expect(p.cells.turn).toBe("absent");
    expect(p.phasesPresent).toBe(2);
    expect(p.maxPhaseReached).toBe("develop");
    expect(p.linkedSceneCount).toBe(2);
    expect(p.writtenSceneCount).toBe(1);
  });

  it("型抜け: climax 無しで resolve → anomalies に欠落前段", () => {
    const links = [link("t1", "s1", "introduce"), link("t1", "s2", "resolve")];
    const p = computeThreadPhaseProgress(links, "t1", written);
    expect(p.maxPhaseReached).toBe("resolve");
    // resolve 以前で欠けているのは develop / turn / climax
    expect(p.anomalies).toEqual(["develop", "turn", "climax"]);
  });

  it("同一 scene の複数 phase は各 phase 独立に占有", () => {
    const links = [link("t1", "s1", "introduce"), link("t1", "s1", "develop")];
    const p = computeThreadPhaseProgress(links, "t1", written);
    expect(p.cells.introduce).toBe("written");
    expect(p.cells.develop).toBe("written");
    expect(p.linkedSceneCount).toBe(1); // dedup nodeId
    expect(p.writtenSceneCount).toBe(1);
  });

  it("マーカー無し → 全 absent・anomalies 空", () => {
    const p = computeThreadPhaseProgress([], "t1", written);
    expect(p.phasesPresent).toBe(0);
    expect(p.maxPhaseReached).toBeNull();
    expect(p.anomalies).toEqual([]);
  });
});
