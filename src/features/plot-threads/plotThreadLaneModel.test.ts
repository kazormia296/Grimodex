import { describe, it, expect } from "vitest";
import {
  buildPlotLaneModel,
  laneY,
  LANE_HEIGHT,
  LANE_TOP,
  MIN_BUNDLE_SPAN,
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

/** Map を含むモデルを決定的に比較するためのシリアライザ。 */
function serialize(m: PlotLaneModel) {
  return {
    lanes: m.lanes.map((l) => ({
      id: l.thread.id,
      y: l.y,
      bundleId: l.bundleId,
      terminusX: l.terminusX,
      markers: l.markers,
      lineSegments: l.lineSegments,
      slots: [...l.slotByColumn.entries()].sort((a, b) => a[0] - b[0]),
    })),
    contentWidth: m.contentWidth,
    contentHeight: m.contentHeight,
    convergences: m.convergences,
    connectors: m.connectors,
    bundles: m.bundles,
  };
}

/** モデルの slotByColumn から隣接列の線交差数を数える（≤ 初期で gate するため）。 */
function crossingsOf(m: PlotLaneModel): number {
  const cols = new Set<number>();
  for (const l of m.lanes) for (const c of l.slotByColumn.keys()) cols.add(c);
  let total = 0;
  for (const c of cols) {
    if (!cols.has(c + 1)) continue;
    const pairs = m.lanes
      .filter((l) => l.slotByColumn.has(c) && l.slotByColumn.has(c + 1))
      .map((l) => ({
        a: l.slotByColumn.get(c)!,
        b: l.slotByColumn.get(c + 1)!,
      }));
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const p = pairs[i];
        const q = pairs[j];
        if ((p.a - q.a) * (p.b - q.b) < 0) total++;
      }
    }
  }
  return total;
}

describe("plotThreadLaneModel (束ねレイアウト)", () => {
  describe("基本配置", () => {
    it("マーカー無しスレッドは sortOrder 順に積まれ y が増える", () => {
      const m = buildPlotLaneModel({
        threads: [thread("b", "a1"), thread("a", "a0")],
        links: [],
        sceneX,
      });
      expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]);
      expect(m.lanes[0].y).toBe(laneY(0));
      expect(m.lanes[1].y).toBe(laneY(1));
      expect(m.contentHeight).toBe(laneY(2));
      expect(m.bundles).toEqual([]);
    });

    it("同一 sortOrder は thread.id で決定化する", () => {
      const m = buildPlotLaneModel({
        threads: [thread("b", "a0"), thread("a", "a0")],
        links: [],
        sceneX,
      });
      expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]);
    });

    it("threads が空ならゼロ寸法の空モデル", () => {
      const m = buildPlotLaneModel({ threads: [], links: [], sceneX });
      expect(m.lanes).toEqual([]);
      expect(m.contentWidth).toBe(0);
      expect(m.contentHeight).toBe(laneY(0));
      expect(m.bundles).toEqual([]);
    });

    it("マーカーをシーン x に置き、存在しないシーンは捨てる。y はスロット由来", () => {
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
      expect(m.lanes[0].markers[0].y).toBe(laneY(0));
      expect(m.contentWidth).toBe(1);
    });

    it("同シーンの複数マーカーは phase 正準順→id で決定化する", () => {
      const m = buildPlotLaneModel({
        threads: [thread("t1", "a0")],
        links: [
          link("l2", "t1", "s1", "develop"),
          link("l1", "t1", "s1", "introduce"),
        ],
        sceneX,
      });
      expect(m.lanes[0].markers.map((mk) => mk.linkId)).toEqual(["l1", "l2"]);
    });

    it("laneTop を下げるとレーン y と contentHeight がそのぶん下がる", () => {
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

  describe("線セグメント（{x1,y1,x2,y2}）", () => {
    it("branch/merge が無ければ全生存列を 1 本の水平帯に繋ぐ", () => {
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
    });

    it("単独マーカーはセグメントを持たない（点のみ）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [link("l1", "a", "s1", "introduce")],
        sceneX,
      });
      expect(m.lanes[0].lineSegments).toEqual([]);
      expect(m.lanes[0].terminusX).toBeNull();
    });

    it("merge 点で線が終わり branch 点で始まる（継ぎ目で分割）", () => {
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
  });

  describe("終端キャップ (terminusX)", () => {
    it("自走で終わるスレッドは最後のビートを terminusX にする", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s3", "climax"),
        ],
        sceneX,
      });
      expect(m.lanes[0].terminusX).toBe(2);
    });

    it("最後のビートが merge なら terminusX は null", () => {
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

  describe("収束 (convergences)", () => {
    it("2 本以上が同じ列にマーカーを持つ列を検出する", () => {
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

    it("同一スレッドが同シーンに複数段階を置いても収束扱いしない", () => {
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

  describe("コネクタ (connectors) — #5 スロット由来の着地", () => {
    it("from/to と at が揃うエッジだけ採用し、Y は at 列のスロットから取る", () => {
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
      expect(m.connectors[0]).toMatchObject({
        id: "br1",
        x: 1,
        kind: "branch",
        color: null,
      });
    });

    it("コネクタ端点 Y はその列のレーンスロット Y と一致する（グローバル行から読まない）", () => {
      // a,b,c が同列 s3 でマーカーを持ち、a→c の branch。
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
      const a = m.lanes.find((l) => l.thread.id === "a")!;
      const c = m.lanes.find((l) => l.thread.id === "c")!;
      const conn = m.connectors[0];
      expect(conn.fromY).toBe(laneY(a.slotByColumn.get(2)!));
      expect(conn.toY).toBe(laneY(c.slotByColumn.get(2)!));
    });
  });

  describe("#7 carry-forward（マーカー間の空白を埋める）", () => {
    it("マーカーが飛んでも生存スパン全列にスロットがあり、線は直線で跨ぐ", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0")],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s4", "climax"),
        ],
        sceneX,
      });
      const a = m.lanes[0];
      // 生存列 0,1,2,3 すべてにスロットがある（carry-forward）。
      expect([...a.slotByColumn.keys()].sort((x, y) => x - y)).toEqual([
        0, 1, 2, 3,
      ]);
      // 単一スロットなので 1 本の水平帯 0→3。
      expect(a.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 3, y2: laneY(0) },
      ]);
    });
  });

  describe("束ね (bundles) — エッジ + 連続共起 ≥ MIN_BUNDLE_SPAN", () => {
    it("連続 3 列以上の共起は 1 トラックへ束ね、同一スロットを共有して高さが縮む", () => {
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
      expect(m.bundles).toHaveLength(1);
      expect(m.bundles[0]).toMatchObject({
        threadIds: ["a", "b"],
        enterX: 0,
        exitX: 2,
        collapsed: true,
      });
      const a = m.lanes.find((l) => l.thread.id === "a")!;
      const b = m.lanes.find((l) => l.thread.id === "b")!;
      expect(a.bundleId).toBe(b.bundleId);
      expect(a.bundleId).not.toBeNull();
      // 束ね区間では同一スロット。
      for (let c = 0; c <= 2; c++) {
        expect(a.slotByColumn.get(c)).toBe(b.slotByColumn.get(c));
      }
      // 束ねで 1 スロット → 高さは 1 レーン分。
      expect(m.contentHeight).toBe(laneY(1));
    });

    it("共起が MIN_BUNDLE_SPAN 未満なら束ねず別スロット", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1")],
        links: [
          link("la1", "a", "s1", "introduce"),
          link("la2", "a", "s2", "develop"),
          link("lb1", "b", "s2", "develop"),
          link("lb2", "b", "s3", "climax"),
        ],
        sceneX, // overlap = s2 のみ（1 列 < 3）
      });
      expect(m.bundles).toEqual([]);
      const a = m.lanes.find((l) => l.thread.id === "a")!;
      const b = m.lanes.find((l) => l.thread.id === "b")!;
      expect(a.slotByColumn.get(1)).not.toBe(b.slotByColumn.get(1));
      expect(MIN_BUNDLE_SPAN).toBe(3);
    });
  });

  describe("始端/終端 override（生存スパン）", () => {
    it("start_node_id でスパンが前方に伸び、線・スロットがそこから始まる", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { startNodeId: "s1" })],
        links: [
          link("l1", "a", "s3", "develop"),
          link("l2", "a", "s4", "climax"),
        ],
        sceneX, // start=s1(0)。マーカーは s3(2),s4(3)。
      });
      const a = m.lanes[0];
      expect([...a.slotByColumn.keys()].sort((x, y) => x - y)).toEqual([
        0, 1, 2, 3,
      ]);
      expect(a.lineSegments).toEqual([
        { x1: 0, y1: laneY(0), x2: 3, y2: laneY(0) },
      ]);
    });

    it("end_node_id でスパンが後方に伸び、terminus は end 列になる", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { endNodeId: "s5" })],
        links: [
          link("l1", "a", "s1", "introduce"),
          link("l2", "a", "s2", "develop"),
        ],
        sceneX, // end=s5(4)。マーカーは s1(0),s2(1)。
      });
      const a = m.lanes[0];
      expect(a.slotByColumn.has(4)).toBe(true);
      expect(a.terminusX).toBe(4);
    });

    it("start override がマーカーより後でも実ビートを切り捨てない（延長扱い）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { startNodeId: "s3" })],
        links: [
          link("l1", "a", "s1", "introduce"), // x=0（start=s3(2) より前）
          link("l2", "a", "s5", "climax"), // x=4
        ],
        sceneX,
      });
      const a = m.lanes[0];
      // start が s3 でも s1(0) のマーカーはスパン内に残る（lo=min(0,2)=0）。
      expect(a.slotByColumn.has(0)).toBe(true);
      expect(a.markers.map((mk) => mk.x)).toEqual([0, 4]);
      expect(a.markers.every((mk) => mk.y === laneY(0))).toBe(true);
    });

    it("scheduledCount 外の override 列は無視する", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0", { endNodeId: "s5" })],
        links: [link("l1", "a", "s1", "introduce")],
        sceneX,
        scheduledCount: 3, // s5(4) は範囲外 → 無視 → 単独マーカー扱い
      });
      const a = m.lanes[0];
      expect(a.slotByColumn.has(4)).toBe(false);
      expect(a.terminusX).toBeNull();
    });
  });

  describe("scheduledCount による未配置の除外", () => {
    it("x >= scheduledCount のマーカー・収束・コネクタを外す", () => {
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

  describe("決定性 (determinism)", () => {
    const buildArgs = () => ({
      threads: [thread("c", "a2"), thread("a", "a0"), thread("b", "a1")],
      links: [
        link("la1", "a", "s1", "introduce"),
        link("la2", "a", "s2", "develop"),
        link("la3", "a", "s3", "climax"),
        link("lb1", "b", "s1", "introduce"),
        link("lb2", "b", "s2", "develop"),
        link("lb3", "b", "s3", "develop"),
        link("lc1", "c", "s3", "introduce"),
        link("lc2", "c", "s4", "develop"),
        link("lc3", "c", "s5", "climax"),
      ],
      sceneX,
      // 複数 branch を入れて配列順シャッフルが connectors 順に影響しないことも検証する。
      branches: [
        branch("br2", "b", "c", "s3", "merge"),
        branch("br1", "a", "c", "s3", "branch"),
      ],
    });

    it("同一入力で再描画しても byte 一致（Map 含む）", () => {
      const a = serialize(buildPlotLaneModel(buildArgs()));
      const b = serialize(buildPlotLaneModel(buildArgs()));
      expect(a).toEqual(b);
    });

    it("threads / links / branches の配列順をシャッフルしても同じ出力", () => {
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

  describe("交差 (crossing) サニティ", () => {
    it("並走スレッドは交差ゼロ（後から入るスレッドも割り込まない）", () => {
      const m = buildPlotLaneModel({
        threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
        links: [
          link("la1", "a", "s1", "introduce"),
          link("la2", "a", "s4", "climax"),
          link("lb1", "b", "s1", "introduce"),
          link("lb2", "b", "s4", "climax"),
          link("lc1", "c", "s3", "introduce"),
          link("lc2", "c", "s4", "climax"),
        ],
        sceneX,
      });
      expect(crossingsOf(m)).toBe(0);
    });
  });
});

describe("laneY / 定数", () => {
  it("laneY は LANE_TOP + index*LANE_HEIGHT", () => {
    expect(laneY(0)).toBe(LANE_TOP);
    expect(laneY(2)).toBe(LANE_TOP + 2 * LANE_HEIGHT);
  });
});
