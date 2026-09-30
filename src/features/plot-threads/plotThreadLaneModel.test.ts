import { describe, it, expect } from "vitest";
import {
  buildPlotLaneModel,
  computeLaneDragTargets,
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
  semanticKey: "",
  version: 0,
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

  describe("subwaySort（重要度＋center-out 行割り当て）", () => {
    it("subwaySort=true で重要度(列数)降順を中央寄せの行に割り当てる", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
        links: [
          link("la1", "a", "s1", "introduce"),
          link("la2", "a", "s2", "develop"),
          link("la3", "a", "s3", "climax"), // a: 3 列 = 最重要
          link("lb", "b", "s1", "introduce"), // b: 1 列
          link("lc", "c", "s2", "develop"), // c: 1 列
        ],
        sceneX,
        subwaySort: true,
      });
      const y = (id: string) => m.lanes.find((l) => l.thread.id === id)!.y;
      // ranked=[a,b,c]、centerOutRows(3)=[1,2,0] → a:row1(中央) / b:row2 / c:row0。
      expect(y("a")).toBe(laneY(1));
      expect(y("b")).toBe(laneY(2));
      expect(y("c")).toBe(laneY(0));
    });

    it("subwaySort=false（既定）は sortOrder の線形ホーム行", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
        links: [
          link("la1", "a", "s1", "introduce"),
          link("la2", "a", "s2", "develop"),
          link("la3", "a", "s3", "climax"),
          link("lb", "b", "s1", "introduce"),
          link("lc", "c", "s2", "develop"),
        ],
        sceneX,
      });
      const y = (id: string) => m.lanes.find((l) => l.thread.id === id)!.y;
      expect(y("a")).toBe(laneY(0));
      expect(y("b")).toBe(laneY(1));
      expect(y("c")).toBe(laneY(2));
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

    it("branch する列に自分のマーカーがあれば親線は連続する（並列走行）", () => {
      // blue は s1, s3, s5 に自走 beat を持つ。s3 で red へ branch するが、その列(s3)に
      // blue 自身のマーカーがあるので blue は切れず連続（red が脇へ分岐するだけ）。
      const m = buildPlotLaneModel({
        threads: [thread("blue", "a0"), thread("red", "a1")],
        links: [
          link("lb1", "blue", "s1", "introduce"),
          link("lb2", "blue", "s3", "develop"),
          link("lb3", "blue", "s5", "resolve"),
          link("lr", "red", "s4", "develop"),
        ],
        sceneX,
        branches: [branch("br", "blue", "red", "s3", "branch")],
      });
      const blue = m.lanes.find((l) => l.thread.id === "blue")!;
      // s1=0 .. s5=4 を連続（分岐 s3=col2 に自分のマーカーがあるので切れない）。
      expect(blue.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 4, y2: laneY(0) },
      ]);
      expect(blue.terminusX).toBe(4);
    });

    it("branch する列に自分のマーカーが無ければ離脱する（バトン・橋渡ししない）", () => {
      // blue は s1, s5 のみ。s3 で branch するがその列に blue のマーカーが無いので離脱、
      // s5 は merge で戻ってくる新たな始点（[[grimodex-plot-thread-timeline]] と同型）。
      const m = buildPlotLaneModel({
        threads: [thread("blue", "a0"), thread("red", "a1")],
        links: [
          link("lb1", "blue", "s1", "introduce"),
          link("lb2", "blue", "s5", "resolve"),
          link("lr", "red", "s3", "develop"),
        ],
        sceneX,
        branches: [
          branch("br", "blue", "red", "s3", "branch"),
          branch("mg", "red", "blue", "s5", "merge"),
        ],
      });
      const blue = m.lanes.find((l) => l.thread.id === "blue")!;
      expect(blue.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 2, y2: laneY(0), rampOutEnd: true },
      ]);
      expect(blue.terminusX).toBeNull();
    });

    it("ジグザグ: branch 列に自分のマーカーがあれば連続・無ければ離脱（実機スクショ再現）", () => {
      // 実機データを縮約: BLUE が本線、RED が 2回だけ枝へ出て戻る。
      //  branch BLUE→RED@s2 (BLUE にマーカー有→連続) / merge RED→BLUE@s3
      //  branch BLUE→RED@s4 (BLUE にマーカー無→離脱) / merge RED→BLUE@s5
      const m = buildPlotLaneModel({
        threads: [thread("BLUE", "a0"), thread("RED", "a1")],
        links: [
          link("b1", "BLUE", "s1", "introduce"),
          link("b2", "BLUE", "s2", "develop"), // branch 列に自分のマーカー
          link("b3", "BLUE", "s3", "develop"), // merge 戻り
          link("b4", "BLUE", "s5", "resolve"), // 2回目 merge 戻り
          link("r1", "RED", "s2", "develop"),
          link("r2", "RED", "s4", "develop"),
        ],
        sceneX,
        branches: [
          branch("e1", "BLUE", "RED", "s2", "branch"),
          branch("e2", "RED", "BLUE", "s3", "merge"),
          branch("e3", "BLUE", "RED", "s4", "branch"),
          branch("e4", "RED", "BLUE", "s5", "merge"),
        ],
      });
      const BLUE = m.lanes.find((l) => l.thread.id === "BLUE")!;
      const RED = m.lanes.find((l) => l.thread.id === "RED")!;
      // BLUE: s2(col1) は自分のマーカー有→連続、s4(col3) は無→離脱。よって [0→3] 連続
      // （= s2-s3 が繋がる）＋ merge 戻りの s5(col4) は単独点。
      expect(BLUE.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 3, y2: laneY(0), rampOutEnd: true },
      ]);
      // RED: 2本の枝 [s2→s3 で離脱] [s4→s5 で離脱]。
      expect(RED.lineSegments).toEqual([
        { x1: 1, y1: laneY(1), x2: 2, y2: laneY(1), rampOutEnd: true },
        { x1: 3, y1: laneY(1), x2: 4, y2: laneY(1), rampOutEnd: true },
      ]);
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

describe("buildPlotLaneModel: laneYByThread 上書き（アニメーション用）", () => {
  it("帯・マーカー・終端・コネクタの Y がすべて override 値に追従する", () => {
    const threads = [thread("a", "a0"), thread("b", "a1")];
    const links = [
      link("la1", "a", "s1", "introduce"),
      link("la2", "a", "s3", "develop"),
      link("lb1", "b", "s2", "introduce"),
    ];
    const branches = [branch("br1", "a", "b", "s2", "branch")];
    // a を 1000、b を 2000 に置く（線形ホームとは無関係な任意 Y）。
    const laneYByThread = new Map([
      ["a", 1000],
      ["b", 2000],
    ]);
    const m = buildPlotLaneModel({
      threads,
      links,
      sceneX,
      branches,
      laneYByThread,
    });
    const a = m.lanes.find((l) => l.thread.id === "a")!;
    const b = m.lanes.find((l) => l.thread.id === "b")!;
    expect(a.y).toBe(1000);
    expect(b.y).toBe(2000);
    // 帯セグメント・マーカー・yByColumn もすべて override 値。
    for (const seg of a.lineSegments) {
      expect(seg.y1).toBe(1000);
      expect(seg.y2).toBe(1000);
    }
    expect(a.markers.every((mk) => mk.y === 1000)).toBe(true);
    expect(b.markers.every((mk) => mk.y === 2000)).toBe(true);
    // コネクタ端点も override 値（a→b の branch）。
    const conn = m.connectors.find((c) => c.id === "br1")!;
    expect(conn.fromY).toBe(1000);
    expect(conn.toY).toBe(2000);
  });

  it("override に無いスレッドはホーム行 Y にフォールバック", () => {
    const threads = [thread("a", "a0"), thread("b", "a1")];
    const links = [link("la1", "a", "s1", "introduce")];
    const m = buildPlotLaneModel({
      threads,
      links,
      sceneX,
      laneYByThread: new Map([["a", 999]]),
    });
    expect(m.lanes.find((l) => l.thread.id === "a")!.y).toBe(999);
    // b は線形ホーム（index 1）。
    expect(m.lanes.find((l) => l.thread.id === "b")!.y).toBe(laneY(1));
  });

  it("構造（順序・セグメント有無）は override で変わらない＝Y だけ動く", () => {
    const threads = [thread("a", "a0"), thread("b", "a1")];
    const links = [
      link("la1", "a", "s1", "introduce"),
      link("la2", "a", "s3", "develop"),
      link("lb1", "b", "s2", "introduce"),
    ];
    const base = buildPlotLaneModel({ threads, links, sceneX });
    const moved = buildPlotLaneModel({
      threads,
      links,
      sceneX,
      laneYByThread: new Map([
        ["a", 500],
        ["b", 700],
      ]),
    });
    // セグメント本数・lanes 順序は不変（Y のみ差し替え）。
    expect(moved.lanes.map((l) => l.thread.id)).toEqual(
      base.lanes.map((l) => l.thread.id),
    );
    moved.lanes.forEach((l, i) => {
      expect(l.lineSegments.length).toBe(base.lanes[i].lineSegments.length);
    });
  });
});

describe("computeLaneDragTargets（ヘッダー縦ドラッグの目標 Y）", () => {
  // 3 行、ホーム = laneTop + i*H（laneTop=100, H=56 → 100,156,212）。
  const order = [
    { id: "a", homeY: 100 },
    { id: "b", homeY: 156 },
    { id: "c", homeY: 212 },
  ];
  const opts = { laneTop: 100, laneHeight: 56 };

  it("ドラッグ点はカーソル Y に一致する", () => {
    const t = computeLaneDragTargets({
      order,
      draggedId: "a",
      currentY: 175,
      ...opts,
    });
    expect(t.get("a")).toBe(175);
  });

  it("下方向（行0→行2）: 間の行が 1 段ずつ上へ退避する", () => {
    // currentY=212 → targetRow=round((212-100)/56)=2。a を行2へ。
    const t = computeLaneDragTargets({
      order,
      draggedId: "a",
      currentY: 212,
      ...opts,
    });
    expect(t.get("a")).toBe(212); // カーソル
    expect(t.get("b")).toBe(156 - 56); // 上へ 1 段
    expect(t.get("c")).toBe(212 - 56); // 上へ 1 段
  });

  it("上方向（行2→行0）: 間の行が 1 段ずつ下へ退避する", () => {
    // currentY=100 → targetRow=0。c を行0へ。
    const t = computeLaneDragTargets({
      order,
      draggedId: "c",
      currentY: 100,
      ...opts,
    });
    expect(t.get("c")).toBe(100); // カーソル
    expect(t.get("a")).toBe(100 + 56); // 下へ 1 段
    expect(t.get("b")).toBe(156 + 56); // 下へ 1 段
  });

  it("同じ行内（移動なし）では他行は退避しない", () => {
    // currentY=110 → targetRow=0 = dragIndex。シフト 0。
    const t = computeLaneDragTargets({
      order,
      draggedId: "a",
      currentY: 110,
      ...opts,
    });
    expect(t.get("b")).toBe(156);
    expect(t.get("c")).toBe(212);
  });

  it("カーソルが端を超えても targetRow は [0, n-1] にクランプされる", () => {
    const t = computeLaneDragTargets({
      order,
      draggedId: "a",
      currentY: 99999,
      ...opts,
    });
    // 最下行へ。b,c は上へ 1 段。
    expect(t.get("b")).toBe(156 - 56);
    expect(t.get("c")).toBe(212 - 56);
  });
});

describe("buildPlotLaneModel gapCols (抜けシーン検出)", () => {
  const gapsOf = (model: PlotLaneModel, threadId: string) =>
    model.lanes.find((l) => l.thread.id === threadId)?.gapCols ?? null;

  it("マーカー間の空き列を gap として返す", () => {
    const model = buildPlotLaneModel({
      threads: [thread("a", "a0")],
      links: [
        link("l1", "a", "s1", "introduce"), // col 0
        link("l2", "a", "s4", "resolve"), // col 3
      ],
      sceneX,
    });
    expect(gapsOf(model, "a")).toEqual([1, 2]);
  });

  it("単独マーカーは gap を生まない", () => {
    const model = buildPlotLaneModel({
      threads: [thread("a", "a0")],
      links: [link("l1", "a", "s3", "develop")], // col 2
      sceneX,
    });
    expect(gapsOf(model, "a")).toEqual([]);
  });

  it("全列にマーカーがあれば gap は無い", () => {
    const model = buildPlotLaneModel({
      threads: [thread("a", "a0")],
      links: [
        link("l1", "a", "s1", "introduce"),
        link("l2", "a", "s2", "develop"),
        link("l3", "a", "s3", "resolve"),
      ],
      sceneX,
    });
    expect(gapsOf(model, "a")).toEqual([]);
  });

  it("branch 離脱列は gap に含めない", () => {
    // a: marker@col0、col2 で b へ分岐（col2 に a のマーカー無し→離脱）
    const model = buildPlotLaneModel({
      threads: [thread("a", "a0"), thread("b", "a1")],
      links: [
        link("l1", "a", "s1", "introduce"), // col 0
        link("l2", "b", "s3", "develop"), // col 2 (b)
      ],
      branches: [branch("br1", "a", "b", "s3", "branch")], // at col 2
      sceneX,
    });
    // a の生存 run = [0,2]、col1 のみ gap（col2 は離脱列なので除外）
    expect(gapsOf(model, "a")).toEqual([1]);
  });

  it("merge 流入列は gap に含めない", () => {
    // a が col1 で b へ合流（b の流入列=col1）。b: marker@col3
    const model = buildPlotLaneModel({
      threads: [thread("a", "a0"), thread("b", "a1")],
      links: [
        link("l1", "a", "s1", "introduce"), // col 0 (a)
        link("l2", "b", "s4", "resolve"), // col 3 (b)
      ],
      branches: [branch("mg1", "a", "b", "s2", "merge")], // at col 1
      sceneX,
    });
    // b の生存 run = [1,3]、col1=流入(除外) / col2=gap / col3=marker
    expect(gapsOf(model, "b")).toEqual([2]);
  });

  it("マーカーが無いスレッドは gapCols=[]", () => {
    const model = buildPlotLaneModel({
      threads: [thread("a", "a0")],
      links: [],
      sceneX,
    });
    expect(gapsOf(model, "a")).toEqual([]);
  });
});
