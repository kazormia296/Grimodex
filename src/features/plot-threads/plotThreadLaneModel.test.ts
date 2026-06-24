import { describe, it, expect } from "vitest";
import { buildPlotLaneModel, laneY } from "./plotThreadLaneModel";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
  PlotThreadBranchRow,
} from "./api";
import type { PlotPhaseType, PlotBranchKind } from "@/db/schema";

const thread = (id: string, sortOrder: string, name = id): PlotThreadRow => ({
  id,
  projectId: "p1",
  name,
  color: null,
  description: null,
  sortOrder,
  createdAt: "",
  updatedAt: "",
});
const link = (
  id: string,
  threadId: string,
  nodeId: string,
  phaseType: PlotPhaseType,
): PlotThreadLinkRow => ({
  id,
  threadId,
  nodeId,
  phaseType,
  note: null,
  sortOrder: null,
  createdAt: "",
  updatedAt: "",
});
const branch = (
  id: string,
  fromThreadId: string,
  toThreadId: string,
  atNodeId: string,
  kind: PlotBranchKind,
): PlotThreadBranchRow => ({
  id,
  projectId: "p1",
  fromThreadId,
  toThreadId,
  atNodeId,
  kind,
  createdAt: "",
  updatedAt: "",
});

describe("plotThreadLaneModel", () => {
  const sceneX = new Map([
    ["s1", 0],
    ["s2", 1],
    ["s3", 2],
  ]);

  it("orders lanes by sortOrder and assigns increasing y", () => {
    const m = buildPlotLaneModel({
      threads: [thread("b", "a1"), thread("a", "a0")],
      links: [],
      sceneX,
    });
    expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]); // a0 < a1
    expect(m.lanes[0].y).toBe(laneY(0));
    expect(m.lanes[1].y).toBe(laneY(1));
    expect(m.contentHeight).toBe(laneY(2));
  });

  it("places markers at their scene x and drops markers whose scene is absent", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [
        link("l1", "t1", "s2", "introduce"),
        link("l2", "t1", "GONE", "develop"),
      ],
      sceneX,
    });
    expect(m.lanes[0].markers).toHaveLength(1);
    expect(m.lanes[0].markers[0]).toMatchObject({ linkId: "l1", x: 1 });
    expect(m.contentWidth).toBe(1);
  });

  it("orders same-scene markers by canonical phase order then id", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [
        link("l2", "t1", "s1", "develop"),
        link("l1", "t1", "s1", "introduce"),
      ],
      sceneX,
    });
    expect(m.lanes[0].markers.map((mk) => mk.linkId)).toEqual(["l1", "l2"]); // introduce < develop
  });

  it("returns an empty model with zero dimensions when there are no threads", () => {
    const m = buildPlotLaneModel({ threads: [], links: [], sceneX });
    expect(m.lanes).toEqual([]);
    expect(m.contentWidth).toBe(0);
    expect(m.contentHeight).toBe(laneY(0));
  });

  it("同一 sortOrder のレーンは thread.id で決定化する", () => {
    const m = buildPlotLaneModel({
      threads: [thread("b", "a0"), thread("a", "a0")],
      links: [],
      sceneX,
    });
    expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]);
  });

  it("未知の phaseType でもクラッシュせず決定的にソートする", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [
        // @ts-expect-error 不正値を意図的に注入（本来は CHECK で弾かれる）
        link("l1", "t1", "s1", "BOGUS"),
        link("l2", "t1", "s1", "introduce"),
      ],
      sceneX,
    });
    expect(m.lanes[0].markers).toHaveLength(2);
    // BOGUS(??0) と introduce(0) は同値 → linkId 昇順で決定化
    expect(m.lanes[0].markers.map((mk) => mk.linkId)).toEqual(["l1", "l2"]);
  });

  it("laneTop を指定するとレーン y と contentHeight がそのぶん下がる", () => {
    const m = buildPlotLaneModel({
      threads: [thread("a", "a0"), thread("b", "a1")],
      links: [],
      sceneX,
      laneTop: 200,
    });
    expect(m.lanes[0].y).toBe(200);
    expect(m.lanes[1].y).toBe(200 + 56);
    expect(m.contentHeight).toBe(200 + 2 * 56);
  });

  describe("収束 (convergences)", () => {
    it("2 本以上のレーンが同じシーン x にマーカーを持つ列を検出する", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("l1", "a", "s1", "introduce"), // x=0
          link("l2", "a", "s2", "develop"), // x=1
          link("l3", "b", "s2", "introduce"), // x=1 ← a と収束
          link("l4", "b", "s3", "climax"), // x=2
        ],
        sceneX,
      });
      expect(m.convergences).toEqual([1]);
    });

    it("同一スレッドが同一シーンに複数段階を置いても収束扱いしない", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s1", "develop"), // 同レーン同 x → 1 本扱い
        ],
        sceneX,
      });
      expect(m.convergences).toEqual([]);
    });
  });

  describe("分岐 / 合流コネクタ (connectors)", () => {
    it("from/to スレッドと at シーンが揃うエッジだけ採用しレーン y を解決する", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [],
        sceneX, // s2 = x:1
        branches: [
          branch("br1", "a", "b", "s2", "branch"),
          branch("br2", "a", "GONE", "s2", "merge"), // to 不在 → 除外
          branch("br3", "a", "b", "MISSING", "branch"), // scene 不在 → 除外
        ],
      });
      expect(m.connectors).toHaveLength(1);
      expect(m.connectors[0]).toMatchObject({
        id: "br1",
        x: 1,
        fromY: laneY(0),
        toY: laneY(1),
        kind: "branch",
        color: null, // from(a) の色
      });
    });

    it("branches 未指定なら connectors は空", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [],
        sceneX,
      });
      expect(m.connectors).toEqual([]);
    });
  });

  describe("線セグメント (lineSegments)", () => {
    it("branch/merge が無ければ全マーカーを1本に繋ぐ（並走・完了は最後のビートで自然に終わる）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s3", "climax"),
        ],
        sceneX, // s1=0, s3=2
      });
      expect(m.lanes[0].lineSegments).toEqual([{ x1: 0, x2: 2 }]);
    });

    it("merge 点で線が終わり branch 点で始まる（継ぎ目で分割）", () => {
      const sx = new Map([
        ["s1", 0],
        ["s2", 1],
        ["s3", 2],
        ["s4", 3],
      ]);
      const m = buildPlotLaneModel({
        threads: [thread("A", "a0"), thread("B", "a1")],
        links: [
          link("lb1", "B", "s1", "introduce"),
          link("lb2", "B", "s2", "develop"), // merge-out
          link("lb3", "B", "s3", "develop"), // branch-in
          link("lb4", "B", "s4", "climax"),
        ],
        sceneX: sx,
        branches: [
          branch("m1", "B", "A", "s2", "merge"), // B が A に畳まれる
          branch("br1", "A", "B", "s3", "branch"), // A から B が生まれる
        ],
      });
      const B = m.lanes.find((l) => l.thread.id === "B")!;
      // s1→s2 まで（merge で終端）と、s3→s4（branch で始まる）の 2 セグメント。
      expect(B.lineSegments).toEqual([
        { x1: 0, x2: 1 },
        { x1: 2, x2: 3 },
      ]);
    });

    it("単独マーカーはセグメントを持たない（点のみ）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [link("l1", "a", "s1", "introduce")],
        sceneX,
      });
      expect(m.lanes[0].lineSegments).toEqual([]);
    });

    it("同一シーンに複数 phase があってもゼロ長セグメントを出さない", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s1", "develop"), // 同シーン同 x
        ],
        sceneX,
      });
      // x1===x2 のゼロ長線は出さない
      expect(m.lanes[0].lineSegments).toEqual([]);
    });
  });

  describe("終端キャップ (terminusX)", () => {
    it("自走で終わるスレッドは最後のビートを terminusX にする", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s3", "climax"),
        ],
        sceneX, // s3 = 2
      });
      expect(m.lanes[0].terminusX).toBe(2);
    });

    it("最後のビートが merge なら terminusX は null（コネクタで表現）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("A", "a0"), thread("B", "a1")],
        links: [
          link("lb1", "B", "s1", "introduce"),
          link("lb2", "B", "s2", "develop"),
        ],
        sceneX, // s2 = 1
        branches: [branch("m1", "B", "A", "s2", "merge")], // B 最後で畳まれる
      });
      const B = m.lanes.find((l) => l.thread.id === "B")!;
      expect(B.terminusX).toBeNull();
    });

    it("単独マーカー（線なし）は terminusX null", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [link("l1", "a", "s1", "introduce")],
        sceneX,
      });
      expect(m.lanes[0].terminusX).toBeNull();
    });
  });

  describe("scheduledCount による未配置の除外（story-time 衝突防止）", () => {
    it("x >= scheduledCount のマーカー・収束・コネクタを描画対象から外す", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("l1", "a", "s1", "introduce"), // x=0 scheduled
          link("l2", "a", "s3", "climax"), // x=2 未配置(scheduledCount=2)
          link("l3", "b", "s3", "introduce"), // x=2 未配置
        ],
        sceneX, // s1=0,s2=1,s3=2
        scheduledCount: 2,
        branches: [branch("br1", "a", "b", "s3", "branch")], // at 未配置 → 除外
      });
      expect(m.lanes[0].markers.map((mk) => mk.x)).toEqual([0]); // s3 除外
      expect(m.lanes[1].markers).toHaveLength(0); // b の s3 も除外
      expect(m.convergences).toEqual([]); // s3 収束も消える
      expect(m.connectors).toHaveLength(0); // 未配置 at のコネクタ除外
    });
  });
});
