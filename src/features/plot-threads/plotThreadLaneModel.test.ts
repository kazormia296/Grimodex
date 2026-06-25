import { describe, it, expect } from "vitest";
import {
  buildPlotLaneModel,
  laneY,
  LANE_HEIGHT,
  LANE_TOP,
  type PlotLaneModel,
} from "./plotThreadLaneModel";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
  PlotThreadBranchRow,
} from "./api";
import type { PlotPhaseType, PlotBranchKind } from "@/db/schema";

const thread = (
  id: string,
  sortOrder: string,
  extra: Partial<PlotThreadRow> = {},
): PlotThreadRow => ({
  id,
  projectId: "p1",
  name: id,
  color: null,
  description: null,
  sortOrder,
  startNodeId: null,
  endNodeId: null,
  createdAt: "",
  updatedAt: "",
  ...extra,
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

/** s1..s6 → 0..5 */
const sceneX = new Map([
  ["s1", 0],
  ["s2", 1],
  ["s3", 2],
  ["s4", 3],
  ["s5", 4],
  ["s6", 5],
]);

function serialize(m: PlotLaneModel) {
  return {
    lanes: m.lanes.map((l) => ({
      id: l.thread.id,
      y: l.y,
      terminusX: l.terminusX,
      markers: l.markers,
      lineSegments: l.lineSegments,
      yByColumn: [...l.yByColumn.entries()].sort((a, b) => a[0] - b[0]),
    })),
    contentWidth: m.contentWidth,
    contentHeight: m.contentHeight,
    convergences: m.convergences,
    connectors: m.connectors,
  };
}

describe("plotThreadLaneModel (ストーリーライン: ホーム行＋出会いで寄る)", () => {
  describe("ホーム行", () => {
    it("各スレッドは sortOrder 順の固定ホーム行を持つ", () => {
      const m = buildPlotLaneModel({
        threads: [thread("b", "a1"), thread("a", "a0")],
        links: [],
        sceneX,
      });
      expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]);
      expect(m.lanes[0].y).toBe(laneY(0));
      expect(m.lanes[1].y).toBe(laneY(1));
      expect(m.contentHeight).toBe(laneY(2));
    });

    it("同一 sortOrder は id で決定化", () => {
      const m = buildPlotLaneModel({
        threads: [thread("b", "a0"), thread("a", "a0")],
        links: [],
        sceneX,
      });
      expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]);
    });

    it("threads 空ならゼロ寸法", () => {
      const m = buildPlotLaneModel({ threads: [], links: [], sceneX });
      expect(m.lanes).toEqual([]);
      expect(m.contentWidth).toBe(0);
      expect(m.contentHeight).toBe(laneY(0));
    });

    it("単独スレッドのマーカーはホーム行 Y に乗る（出会い無し）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("l1", "a", "s2", "introduce"),
          link("l2", "a", "s3", "develop"),
        ],
        sceneX,
      });
      const a = m.lanes.find((l) => l.thread.id === "a")!;
      expect(a.markers.every((mk) => mk.y === laneY(0))).toBe(true);
      expect(a.lineSegments).toEqual([
        { x1: 1, y1: laneY(0), x2: 2, y2: laneY(0) },
      ]);
    });

    it("laneTop でホーム行と高さが下がる", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [],
        sceneX,
        laneTop: 200,
      });
      expect(m.lanes[0].y).toBe(200);
      expect(m.lanes[1].y).toBe(200 + LANE_HEIGHT);
      expect(m.contentHeight).toBe(200 + 2 * LANE_HEIGHT);
    });
  });

  describe("被っても畳まない・寄らない（固定ホーム行）", () => {
    it("被るスレッドは別ホーム行で重ならず、線は真っ直ぐ（斜め無し）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("la1", "a", "s1", "introduce"),
          link("la2", "a", "s2", "develop"),
          link("la3", "a", "s3", "climax"),
          link("lb1", "b", "s1", "introduce"),
          link("lb2", "b", "s2", "develop"),
          link("lb3", "b", "s3", "climax"),
        ],
        sceneX,
      });
      const a = m.lanes.find((l) => l.thread.id === "a")!;
      const b = m.lanes.find((l) => l.thread.id === "b")!;
      // 各スレッドは全列でホーム行 Y を保つ（出会いでも寄らない）。
      for (let c = 0; c <= 2; c++) {
        expect(a.yByColumn.get(c)).toBe(laneY(0));
        expect(b.yByColumn.get(c)).toBe(laneY(1));
      }
      // マーカーもホーム行 Y。
      expect(a.markers.every((mk) => mk.y === laneY(0))).toBe(true);
      expect(b.markers.every((mk) => mk.y === laneY(1))).toBe(true);
      // 線は水平のみ（斜めブリッジ無し）。
      expect(a.lineSegments.every((s) => s.y1 === s.y2)).toBe(true);
      expect(b.lineSegments.every((s) => s.y1 === s.y2)).toBe(true);
      // 高さは畳まれない＝2 行ぶん。
      expect(m.contentHeight).toBe(laneY(2));
    });

    it("出会い列でもマーカー・線はホーム行のまま", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("la1", "a", "s1", "introduce"),
          link("la2", "a", "s2", "develop"), // 出会い
          link("la3", "a", "s3", "climax"),
          link("lb", "b", "s2", "introduce"), // 出会い
        ],
        sceneX,
      });
      const a = m.lanes.find((l) => l.thread.id === "a")!;
      expect(a.yByColumn.get(0)).toBe(laneY(0));
      expect(a.yByColumn.get(1)).toBe(laneY(0)); // 寄らない
      expect(a.yByColumn.get(2)).toBe(laneY(0));
      expect(a.lineSegments.every((s) => s.y1 === s.y2)).toBe(true);
    });
  });

  describe("convergences", () => {
    it("2 本以上が同列にマーカーを持つ列を検出", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s2", "develop"),
          link("l3", "b", "s2", "introduce"),
          link("l4", "b", "s3", "climax"),
        ],
        sceneX,
      });
      expect(m.convergences).toEqual([1]);
    });

    it("同一スレッドが同列に複数段階でも収束扱いしない", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s1", "develop"),
        ],
        sceneX,
      });
      expect(m.convergences).toEqual([]);
    });
  });

  describe("carry-forward (#7)", () => {
    it("マーカーが飛んでも生存列を埋め、ホーム行で直線に跨ぐ", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s4", "climax"),
        ],
        sceneX,
      });
      const a = m.lanes[0];
      expect([...a.yByColumn.keys()].sort((x, y) => x - y)).toEqual([
        0, 1, 2, 3,
      ]);
      expect(a.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 3, y2: laneY(0) },
      ]);
    });
  });

  describe("線セグメント / 終端", () => {
    it("branch/merge 無しは1本に繋ぐ", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s3", "climax"),
        ],
        sceneX,
      });
      expect(m.lanes[0].lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 2, y2: laneY(0) },
      ]);
      expect(m.lanes[0].terminusX).toBe(2);
    });

    it("単独マーカーはセグメント無し・terminus null", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [link("l1", "a", "s1", "introduce")],
        sceneX,
      });
      expect(m.lanes[0].lineSegments).toEqual([]);
      expect(m.lanes[0].terminusX).toBeNull();
    });

    it("merge で終わり branch で始まる（継ぎ目分割）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("A", "a0"), thread("B", "a1")],
        links: [
          link("lb1", "B", "s1", "introduce"),
          link("lb2", "B", "s2", "develop"),
          link("lb3", "B", "s3", "develop"),
          link("lb4", "B", "s4", "climax"),
        ],
        sceneX,
        branches: [
          branch("m1", "B", "A", "s2", "merge"),
          branch("br1", "A", "B", "s3", "branch"),
        ],
      });
      const B = m.lanes.find((l) => l.thread.id === "B")!;
      expect(B.lineSegments.map((s) => ({ x1: s.x1, x2: s.x2 }))).toEqual([
        { x1: 0, x2: 1 },
        { x1: 2, x2: 3 },
      ]);
    });

    it("最後が merge なら terminus null", () => {
      const m = buildPlotLaneModel({
        threads: [thread("A", "a0"), thread("B", "a1")],
        links: [
          link("lb1", "B", "s1", "introduce"),
          link("lb2", "B", "s2", "develop"),
        ],
        sceneX,
        branches: [branch("m1", "B", "A", "s2", "merge")],
      });
      const B = m.lanes.find((l) => l.thread.id === "B")!;
      expect(B.terminusX).toBeNull();
    });
  });

  describe("コネクタ (#5: at 列の実 Y)", () => {
    it("from/to と at が揃うエッジだけ採用し Y は at 列の実 Y", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [],
        sceneX,
        branches: [
          branch("br1", "a", "b", "s2", "branch"),
          branch("br2", "a", "GONE", "s2", "merge"),
          branch("br3", "a", "b", "MISSING", "branch"),
        ],
      });
      expect(m.connectors).toHaveLength(1);
      // a,b ともマーカー無し → 出会い無し → ホーム行 Y。
      expect(m.connectors[0]).toMatchObject({
        id: "br1",
        x: 1,
        fromY: laneY(0),
        toY: laneY(1),
        kind: "branch",
        color: null,
      });
    });

    it("出会い列でも branch コネクタ端点は各ホーム行 Y", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
        links: [
          link("la", "a", "s3", "develop"),
          link("lb", "b", "s3", "develop"),
          link("lc", "c", "s3", "develop"),
        ],
        sceneX,
        branches: [branch("br1", "a", "c", "s3", "branch")],
      });
      const conn = m.connectors[0];
      expect(conn.fromY).toBe(laneY(0)); // a のホーム行
      expect(conn.toY).toBe(laneY(2)); // c のホーム行
    });
  });

  describe("コネクタ端点の生存（両端が帯へ届く / span 延長）", () => {
    it("branch は from/to 双方を at 列で生存させる（マーカーが to 側だけでも from が届く）", () => {
      // A(親) は s1,s2 に beat。B は at=s3 のみに beat（D&D branch でマーカーは to=B へ）。
      const m = buildPlotLaneModel({
        threads: [thread("A", "a0"), thread("B", "a1")],
        links: [
          link("la1", "A", "s1", "introduce"),
          link("la2", "A", "s2", "develop"),
          link("lb", "B", "s3", "develop"),
        ],
        sceneX,
        branches: [branch("br1", "A", "B", "s3", "branch")],
      });
      const A = m.lanes.find((l) => l.thread.id === "A")!;
      const B = m.lanes.find((l) => l.thread.id === "B")!;
      // at=s3=col2。A はマーカー無しでも col2 まで生存。離脱列なので帯は rampOutEnd（右端を
      // ランプ始端で締める）として col2 まで届く。
      expect(A.yByColumn.has(2)).toBe(true);
      expect(B.yByColumn.has(2)).toBe(true);
      expect(A.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 2, y2: laneY(0), rampOutEnd: true },
      ]);
      // 分岐点（離脱列）で線がいきなり完結したように見えないよう終端ノブは付けない。
      expect(A.terminusX).toBeNull();
    });

    it("merge は from を at 列まで生存させ帯を畳む（マーカーが to 側でも from 端が届く）", () => {
      // B(畳まれる側) は s1,s2、at=s3 で A へ merge。マーカーは to=A 側（B に s3 beat 無し）。
      const m = buildPlotLaneModel({
        threads: [thread("A", "a0"), thread("B", "a1")],
        links: [
          link("lb1", "B", "s1", "introduce"),
          link("lb2", "B", "s2", "develop"),
          link("la", "A", "s3", "develop"),
        ],
        sceneX,
        branches: [branch("m1", "B", "A", "s3", "merge")],
      });
      const A = m.lanes.find((l) => l.thread.id === "A")!;
      const B = m.lanes.find((l) => l.thread.id === "B")!;
      // at=s3=col2。B はマーカー無しでも col2 まで生存し、離脱列で帯が rampOut で締まる。
      expect(B.yByColumn.has(2)).toBe(true);
      expect(A.yByColumn.has(2)).toBe(true);
      expect(B.lineSegments).toEqual([
        { x1: 0, y1: laneY(1), x2: 2, y2: laneY(1), rampOutEnd: true },
      ]);
      expect(B.terminusX).toBeNull();
    });

    it("マーカーの無いスレッドもエッジ列で生存する", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [],
        sceneX,
        branches: [branch("br1", "a", "b", "s2", "branch")],
      });
      // s2=col1。a,b とも col1 で生存（マーカー皆無でもコネクタ端点に帯のアンカー）。
      expect(m.lanes[0].yByColumn.has(1)).toBe(true);
      expect(m.lanes[1].yByColumn.has(1)).toBe(true);
    });

    it("branch して別レーンを走り merge で戻る: 元レーンの帯は分岐点で切れ、合流点は新たな始点（橋渡ししない）", () => {
      // バトンリレー: blue→(branch s3)→red→(merge s5)→blue。
      // blue: s1, s5(合流で乗る)。red: s3(分岐で乗る)。
      const m = buildPlotLaneModel({
        threads: [thread("blue", "a0"), thread("red", "a1")],
        links: [
          link("lb1", "blue", "s1", "introduce"),
          link("lr", "red", "s3", "develop"),
          link("lb2", "blue", "s5", "resolve"),
        ],
        sceneX,
        branches: [
          branch("br", "blue", "red", "s3", "branch"),
          branch("mg", "red", "blue", "s5", "merge"),
        ],
      });
      const blue = m.lanes.find((l) => l.thread.id === "blue")!;
      const red = m.lanes.find((l) => l.thread.id === "red")!;
      // blue: [s1..s3] で分岐離脱(rampOut)。s3〜s5 は別レーン(red)なので帯は無し。
      // s5 は合流で乗った新たな始点 → 単独マーカー（帯セグメント無し）。橋渡ししない。
      expect(blue.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 2, y2: laneY(0), rampOutEnd: true },
      ]);
      expect(blue.markers.map((mk) => mk.x).sort((a, b) => a - b)).toEqual([
        0, 4,
      ]);
      expect(blue.terminusX).toBeNull();
      // red: [s3..s5] を走り s5 で合流離脱(rampOut)。
      expect(red.lineSegments).toEqual([
        { x1: 2, y1: laneY(1), x2: 4, y2: laneY(1), rampOutEnd: true },
      ]);
      expect(red.terminusX).toBeNull();
      // コネクタは 2 本（branch@s3 / merge@s5）。
      expect(m.connectors.map((c) => c.kind).sort()).toEqual([
        "branch",
        "merge",
      ]);
    });
  });

  describe("始端/終端 override", () => {
    it("start override で前方へ伸びる", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { startNodeId: "s1" })],
        links: [
          link("l1", "a", "s3", "develop"),
          link("l2", "a", "s4", "climax"),
        ],
        sceneX,
      });
      const a = m.lanes[0];
      expect([...a.yByColumn.keys()].sort((x, y) => x - y)).toEqual([
        0, 1, 2, 3,
      ]);
    });

    it("start がマーカーより後でもマーカーを切り捨てない", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { startNodeId: "s3" })],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s5", "climax"),
        ],
        sceneX,
      });
      const a = m.lanes[0];
      expect(a.yByColumn.has(0)).toBe(true);
      expect(a.markers.map((mk) => mk.x)).toEqual([0, 4]);
    });

    it("end override で terminus が end 列", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { endNodeId: "s5" })],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s2", "develop"),
        ],
        sceneX,
      });
      expect(m.lanes[0].terminusX).toBe(4);
    });

    it("scheduledCount 外の override は無視", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { endNodeId: "s5" })],
        links: [link("l1", "a", "s1", "introduce")],
        sceneX,
        scheduledCount: 3,
      });
      expect(m.lanes[0].yByColumn.has(4)).toBe(false);
      expect(m.lanes[0].terminusX).toBeNull();
    });
  });

  describe("scheduledCount 除外", () => {
    it("x>=scheduledCount のマーカー・収束・コネクタを外す", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s3", "climax"),
          link("l3", "b", "s3", "introduce"),
        ],
        sceneX,
        scheduledCount: 2,
        branches: [branch("br1", "a", "b", "s3", "branch")],
      });
      expect(m.lanes[0].markers.map((mk) => mk.x)).toEqual([0]);
      expect(m.lanes[1].markers).toHaveLength(0);
      expect(m.convergences).toEqual([]);
      expect(m.connectors).toHaveLength(0);
    });
  });

  describe("決定性", () => {
    const buildArgs = () => ({
      threads: [thread("c", "a2"), thread("a", "a0"), thread("b", "a1")],
      links: [
        link("la1", "a", "s1", "introduce"),
        link("la2", "a", "s2", "develop"),
        link("la3", "a", "s3", "climax"),
        link("lb1", "b", "s1", "introduce"),
        link("lb2", "b", "s2", "develop"),
        link("lc1", "c", "s3", "introduce"),
        link("lc2", "c", "s4", "develop"),
      ],
      sceneX,
      branches: [
        branch("br2", "b", "c", "s3", "merge"),
        branch("br1", "a", "c", "s3", "branch"),
      ],
    });

    it("同一入力で byte 一致", () => {
      expect(serialize(buildPlotLaneModel(buildArgs()))).toEqual(
        serialize(buildPlotLaneModel(buildArgs())),
      );
    });

    it("threads/links/branches の配列順をシャッフルしても同じ", () => {
      const base = buildArgs();
      const shuffled = {
        ...base,
        threads: [...base.threads].reverse(),
        links: [...base.links].reverse(),
        branches: [...base.branches].reverse(),
      };
      expect(serialize(buildPlotLaneModel(shuffled))).toEqual(
        serialize(buildPlotLaneModel(base)),
      );
    });
  });
});

describe("laneY / 定数", () => {
  it("laneY は LANE_TOP + index*LANE_HEIGHT", () => {
    expect(laneY(0)).toBe(LANE_TOP);
    expect(laneY(2)).toBe(LANE_TOP + 2 * LANE_HEIGHT);
  });
});
