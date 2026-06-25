import { describe, it, expect } from "vitest";
import {
  buildPlotSubwayModel,
  centerOutRows,
  roundedPath,
  type PlotSubwayModel,
} from "./subwayModel";
import { LANE_TOP, LANE_HEIGHT } from "./plotThreadLaneModel";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";
import type { PlotPhaseType } from "@/db/schema";

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
  phaseType: PlotPhaseType = "develop",
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

/** s1..s8 → 0..7 */
const sceneX = new Map(
  Array.from({ length: 8 }, (_, i) => [`s${i + 1}`, i] as [string, number]),
);

const rowY = (rowIndex: number) => LANE_TOP + rowIndex * LANE_HEIGHT;

function serialize(m: PlotSubwayModel) {
  return {
    tracks: m.tracks.map((t) => ({
      id: t.threadId,
      rowIndex: t.rowIndex,
      homeY: t.homeY,
      importance: t.importance,
      points: t.points,
    })),
    nodes: m.nodes.map((nd) => ({
      nodeId: nd.nodeId,
      x: nd.x,
      y: nd.y,
      trackIds: nd.trackIds,
      multi: nd.multi,
      hostThreadId: nd.hostThreadId,
    })),
    contentWidth: m.contentWidth,
    contentHeight: m.contentHeight,
    rowCount: m.rowCount,
  };
}

describe("centerOutRows", () => {
  it("n=1 は [0]", () => {
    expect(centerOutRows(1)).toEqual([0]);
  });
  it("奇数本は中央起点で外へ交互", () => {
    // n=3, mid=1 → 距離 0,1,1 → [1, 2, 0]（同距離は下優先）
    expect(centerOutRows(3)).toEqual([1, 2, 0]);
  });
  it("偶数本は中央2行(下優先)から外へ", () => {
    // n=4, mid=1.5 → 距離 1.5,0.5,0.5,1.5 → [2,1,3,0]
    expect(centerOutRows(4)).toEqual([2, 1, 3, 0]);
  });
  it("各行 index がちょうど1回ずつ現れる(置換)", () => {
    for (const n of [1, 2, 5, 6, 7]) {
      expect([...centerOutRows(n)].sort((a, b) => a - b)).toEqual(
        Array.from({ length: n }, (_, i) => i),
      );
    }
  });
});

describe("buildPlotSubwayModel – 行割り当て(center-out by importance)", () => {
  it("重要度(distinct列数)が高いトラックほど中央寄りの行", () => {
    // a: 3駅, b: 2駅, c: 1駅 → rank a<b<c → centerOutRows(3)=[1,2,0]
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
      links: [
        link("la1", "a", "s1"),
        link("la2", "a", "s2"),
        link("la3", "a", "s3"),
        link("lb1", "b", "s1"),
        link("lb2", "b", "s2"),
        link("lc1", "c", "s1"),
      ],
      sceneX,
    });
    const byId = new Map(m.tracks.map((t) => [t.threadId, t]));
    expect(byId.get("a")!.rowIndex).toBe(1); // 最重要 = 中央
    expect(byId.get("b")!.rowIndex).toBe(2);
    expect(byId.get("c")!.rowIndex).toBe(0);
    // tracks は rowIndex 昇順
    expect(m.tracks.map((t) => t.threadId)).toEqual(["c", "a", "b"]);
  });

  it("同一列の複数linkは重要度1カウント", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0")],
      links: [
        link("l1", "a", "s1", "introduce"),
        link("l2", "a", "s1", "develop"),
      ],
      sceneX,
    });
    expect(m.tracks[0].importance).toBe(1);
  });

  it("重要度同点は sortOrder→id で決定化", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("b", "a1"), thread("a", "a0")],
      links: [link("l1", "a", "s1"), link("l2", "b", "s2")],
      sceneX,
    });
    // 同重要度(1)→ sortOrder a0<a1 → a が rank0。n=2: centerOutRows(2)=[1,0]
    const byId = new Map(m.tracks.map((t) => [t.threadId, t]));
    expect(byId.get("a")!.rowIndex).toBe(1);
    expect(byId.get("b")!.rowIndex).toBe(0);
  });

  it("イベント0のトラックも行を持つ(label用)", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("empty", "a1")],
      links: [link("l1", "a", "s1")],
      sceneX,
    });
    const e = m.tracks.find((t) => t.threadId === "empty")!;
    expect(e.importance).toBe(0);
    expect(e.points).toEqual([]);
    expect(m.rowCount).toBe(2);
    expect(m.contentHeight).toBe(LANE_TOP + 2 * LANE_HEIGHT);
  });
});

describe("buildPlotSubwayModel – ノード(駅)", () => {
  it("単一トラックノードは multi=false、複数は multi=true", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1")],
      links: [
        link("la1", "a", "s1"), // a単独
        link("la2", "a", "s2"),
        link("lb1", "b", "s2"), // s2 で a,b 共有
      ],
      sceneX,
    });
    const byNode = new Map(m.nodes.map((nd) => [nd.nodeId, nd]));
    expect(byNode.get("s1")!.multi).toBe(false);
    expect(byNode.get("s2")!.multi).toBe(true);
    expect(byNode.get("s2")!.trackIds).toHaveLength(2);
  });

  it("共有ノードのホスト = 最重要(rank最小)トラックの行", () => {
    // a: 2駅(重要), b: 1駅。s2 を共有。host=a → ノードは a の行に乗る。
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1")],
      links: [
        link("la1", "a", "s1"),
        link("la2", "a", "s2"),
        link("lb", "b", "s2"),
      ],
      sceneX,
    });
    const byId = new Map(m.tracks.map((t) => [t.threadId, t]));
    const s2 = m.nodes.find((nd) => nd.nodeId === "s2")!;
    expect(s2.hostThreadId).toBe("a");
    expect(s2.y).toBe(byId.get("a")!.homeY);
    expect(s2.trackIds[0]).toBe("a"); // 先頭 = host
  });

  it("ノードは x昇順→y昇順→nodeId昇順", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1")],
      links: [link("la", "a", "s3"), link("lb", "b", "s1")],
      sceneX,
    });
    expect(m.nodes.map((nd) => nd.nodeId)).toEqual(["s1", "s3"]);
  });

  it("markers はホスト→phase→linkId 順で全トラックぶん持つ", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1")],
      links: [
        link("la1", "a", "s1"),
        link("la2", "a", "s2"),
        link("lb", "b", "s2", "climax"),
      ],
      sceneX,
    });
    const s2 = m.nodes.find((nd) => nd.nodeId === "s2")!;
    // host a が先頭
    expect(s2.markers.map((mk) => mk.threadId)).toEqual(["a", "b"]);
  });
});

describe("buildPlotSubwayModel – ルーティング", () => {
  it("単独自行・全ホーム・複数駅は水平線1本(両端ホーム)", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0")],
      links: [link("l1", "a", "s1"), link("l2", "a", "s3")],
      sceneX,
    });
    const a = m.tracks[0];
    // n=1, row0 → homeY=LANE_TOP。点列は [s1,s3] の水平（両端とも実駅＝anchor false）。
    expect(a.points).toEqual([
      { x: 0, y: rowY(0), anchor: false },
      { x: 2, y: rowY(0), anchor: false },
    ]);
  });

  it("単独1駅のみは線なし(駅のみ)", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0")],
      links: [link("l1", "a", "s1")],
      sceneX,
    });
    expect(m.tracks[0].points).toEqual([]);
  });

  it("先頭駅が別行なら進入アンカー(homeY)を頭に置く", () => {
    // a: 2駅(重要,row1中央) b:1駅(row0/row2外)。共有 s1,s2 は host=a 行。
    // b の唯一駅 s2 が host=a 行 → b は進入アンカー(homeY_b) → s2(host_a行)
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
      links: [
        link("la1", "a", "s1"),
        link("la2", "a", "s2"),
        link("la3", "a", "s3"),
        link("lb", "b", "s2"), // b単独駅だが host=a 行へ寄る
      ],
      sceneX,
    });
    const byId = new Map(m.tracks.map((t) => [t.threadId, t]));
    const b = byId.get("b")!;
    const a = byId.get("a")!;
    // s2 は列1。b.points: [ {1, homeY_b, anchor}, {1, homeY_a, 駅}, {1, homeY_b, anchor} ]
    // = 進入アンカー(homeY_b) → 駅(host_a 行) → 退出アンカー(homeY_b)。
    expect(b.points[0]).toEqual({ x: 1, y: b.homeY, anchor: true });
    expect(b.points).toContainEqual({ x: 1, y: a.homeY, anchor: false });
    // 末尾も homeY_b に戻る(退出アンカー)
    expect(b.points[b.points.length - 1]).toEqual({
      x: 1,
      y: b.homeY,
      anchor: true,
    });
  });

  it("ホーム行に乗った実駅は anchor=false（スタブ対象にしない＝線と駅が分離しない）", () => {
    // a 重要(中央)。b = s1(b単独・bホーム行) → s2(a と共有・a行へ寄る)。
    // b.points 先頭 {s1, bHome} は実駅であって進入アンカーではない（anchor=false）。
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
      links: [
        link("la1", "a", "s2"),
        link("la2", "a", "s3"),
        link("la3", "a", "s4"),
        link("lb1", "b", "s1"), // b 単独・b ホーム行（実駅）
        link("lb2", "b", "s2"), // a と共有 → a 行へ寄る
      ],
      sceneX,
    });
    const b = m.tracks.find((t) => t.threadId === "b")!;
    // 先頭は実駅 s1（列0, bHome）で anchor=false。次が共有駅 s2（a行）。
    expect(b.points[0]).toMatchObject({ x: 0, y: b.homeY, anchor: false });
    // 末尾は a 行へ寄った後ホーム行へ戻る退出アンカー（anchor=true）。
    expect(b.points[b.points.length - 1].anchor).toBe(true);
  });

  it("共有駅が連続すると同host行で水平(2駅連続を水平に通る)", () => {
    // a重要(中央), b が s1,s2 連続で a と共有 → b は a 行で s1→s2 水平
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0"), thread("b", "a1"), thread("c", "a2")],
      links: [
        link("la1", "a", "s1"),
        link("la2", "a", "s2"),
        link("la3", "a", "s3"),
        link("lb1", "b", "s1"),
        link("lb2", "b", "s2"),
      ],
      sceneX,
    });
    const byId = new Map(m.tracks.map((t) => [t.threadId, t]));
    const a = byId.get("a")!;
    const b = byId.get("b")!;
    // b の s1,s2 は host=a 行で連続 → 同じ y の水平セグメント（実駅 anchor false）
    const atA = b.points.filter((p) => p.y === a.homeY);
    expect(atA).toEqual([
      { x: 0, y: a.homeY, anchor: false },
      { x: 1, y: a.homeY, anchor: false },
    ]);
  });
});

describe("buildPlotSubwayModel – 除外/空", () => {
  it("scheduledCount 外のマーカーを除外", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0")],
      links: [link("l1", "a", "s1"), link("l2", "a", "s5")],
      sceneX,
      scheduledCount: 3,
    });
    expect(m.nodes.map((nd) => nd.nodeId)).toEqual(["s1"]);
    expect(m.tracks[0].importance).toBe(1);
  });

  it("sceneX に無い nodeId は捨てる", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0")],
      links: [link("l1", "a", "s1"), link("l2", "a", "GONE")],
      sceneX,
    });
    expect(m.nodes.map((nd) => nd.nodeId)).toEqual(["s1"]);
  });

  it("未知トラックの link は無視", () => {
    const m = buildPlotSubwayModel({
      threads: [thread("a", "a0")],
      links: [link("l1", "a", "s1"), link("lx", "ghost", "s2")],
      sceneX,
    });
    expect(m.nodes.map((nd) => nd.nodeId)).toEqual(["s1"]);
  });

  it("空入力はゼロ寸法", () => {
    const m = buildPlotSubwayModel({ threads: [], links: [], sceneX });
    expect(m.tracks).toEqual([]);
    expect(m.nodes).toEqual([]);
    expect(m.contentWidth).toBe(0);
    expect(m.contentHeight).toBe(LANE_TOP);
    expect(m.rowCount).toBe(0);
  });
});

describe("buildPlotSubwayModel – 決定性", () => {
  const buildArgs = () => ({
    threads: [thread("c", "a2"), thread("a", "a0"), thread("b", "a1")],
    links: [
      link("la1", "a", "s1"),
      link("la2", "a", "s2"),
      link("la3", "a", "s3"),
      link("lb1", "b", "s1"),
      link("lb2", "b", "s2"),
      link("lc1", "c", "s3"),
      link("lc2", "c", "s4"),
    ],
    sceneX,
  });

  it("同一入力で byte 一致", () => {
    expect(serialize(buildPlotSubwayModel(buildArgs()))).toEqual(
      serialize(buildPlotSubwayModel(buildArgs())),
    );
  });

  it("配列順をシャッフルしても同じ", () => {
    const base = buildArgs();
    const shuffled = {
      ...base,
      threads: [...base.threads].reverse(),
      links: [...base.links].reverse(),
    };
    expect(serialize(buildPlotSubwayModel(shuffled))).toEqual(
      serialize(buildPlotSubwayModel(base)),
    );
  });
});

describe("roundedPath", () => {
  it("空/1点/2点", () => {
    expect(roundedPath([], 10)).toBe("");
    expect(roundedPath([{ x: 1, y: 2 }], 10)).toBe("M 1 2");
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        10,
      ),
    ).toBe("M 0 0 L 10 0");
  });

  it("共線3点は丸めず直線", () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 20, y: 0 },
        ],
        4,
      ),
    ).toBe("M 0 0 L 10 0 L 20 0");
  });

  it("コーナーは二次ベジェで丸める(半径クランプ)", () => {
    // L字。半径4。各セグメント長20 → クランプ不要。
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
      ],
      4,
    );
    expect(d).toBe("M 0 0 L 16 0 Q 20 0 20 4 L 20 20");
  });

  it("連続重複点を除去", () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        4,
      ),
    ).toBe("M 0 0 L 10 0");
  });

  it("-0 を 0 に正規化", () => {
    expect(roundedPath([{ x: -0, y: -0 }], 4)).toBe("M 0 0");
  });
});
