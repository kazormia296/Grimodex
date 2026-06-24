import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  PLOT_PHASE_TYPES,
  type PlotPhaseType,
  type PlotBranchKind,
} from "@/db/schema";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
  PlotThreadBranchRow,
} from "./api";

/** TimelineViewport の LANE_Y(=60) と整合する scheduled ベースライン。 */
export const LANE_TOP = 60;
export const LANE_HEIGHT = 56;

export function laneY(index: number): number {
  return LANE_TOP + index * LANE_HEIGHT;
}

export interface PlotLaneMarker {
  linkId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  /** シーン x インデックス（px 変換は viewport の xOf に委ねる）。 */
  x: number;
  /** その列でのスレッド Y（px）。出会い列では中心へ寄った値、それ以外はホーム行 Y。 */
  y: number;
}
/** スレッド線の連続セグメント。x はシーン index（xOf 変換）、y は px。
 *  ホーム行を走る区間は y1===y2（水平）。出会いへ寄る/戻る所は斜め。 */
export interface PlotLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface PlotLane {
  thread: PlotThreadRow;
  /** ホーム行 Y（左ガター・ラベル・背景線アンカー。線形状は端点で駆動）。 */
  y: number;
  markers: PlotLaneMarker[];
  /** 連続線セグメント（隣接列の連なり。merge/branch の継ぎ目で切れる）。 */
  lineSegments: PlotLineSegment[];
  /** 「完結」終端の x（線が自走で終わる＝最後のビートが merge でないとき）。 */
  terminusX: number | null;
  /** 生存列ごとの実 Y(px)。ホーム行 or 出会いで寄った値。 */
  yByColumn: Map<number, number>;
}
/** 分岐 / 合流のコネクタ。あるシーン x で fromY↔toY のレーン間を繋ぐ。
 *  fromY/toY は at 列の実 Y から取る（#5 = ホーム行固定値ではなく寄った後の Y）。 */
export interface PlotConnector {
  id: string;
  x: number;
  fromY: number;
  toY: number;
  kind: PlotBranchKind;
  color: string | null;
}
export interface PlotLaneModel {
  lanes: PlotLane[];
  /** 最大シーン index（px 変換は viewport 側）。 */
  contentWidth: number;
  contentHeight: number;
  /** 2 本以上のスレッドがマーカーを持つシーン x（昇順・出会い列）。 */
  convergences: number[];
  /** 分岐 / 合流コネクタ（from/to スレッドと at シーンが揃うものだけ）。 */
  connectors: PlotConnector[];
}

const PHASE_ORDER: Record<PlotPhaseType, number> = PLOT_PHASE_TYPES.reduce(
  (acc, p, i) => {
    acc[p] = i;
    return acc;
  },
  {} as Record<PlotPhaseType, number>,
);

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * プロットスレッドの「ストーリーライン図」レイアウト（Plottr 型）を生成する純関数。
 *
 * モデル: 各スレッドは sortOrder 順の **固定ホーム行** を真っ直ぐ走る（畳まない＝重ねない）。
 * 出会い（収束＝複数スレッドが同列にマーカー）は線を寄せず、convergences の淡い縦バンドで表す。
 *
 * 決定性: 乱数/Date.now 禁止。順序 = (sortOrder,id)。全比較子に id 最終タイブレーク。
 */
export function buildPlotLaneModel(args: {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  sceneX: Map<string, number>;
  laneTop?: number;
  branches?: PlotThreadBranchRow[];
  /** scheduled シーン数。これ以上の x（story-time の未配置）は描かない。既定 Infinity。 */
  scheduledCount?: number;
}): PlotLaneModel {
  const {
    threads,
    links,
    sceneX,
    laneTop = LANE_TOP,
    branches = [],
    scheduledCount = Infinity,
  } = args;

  // ───────── PREP: 順序・ホーム行 ─────────
  const orderedThreads = [...threads].sort((a, b) => {
    const c = cmpKeys(a.sortOrder, b.sortOrder);
    return c !== 0 ? c : cmpId(a.id, b.id);
  });
  const homeRow = new Map<string, number>(
    orderedThreads.map((t, i) => [t.id, i]),
  );
  const homeY = (threadId: string) =>
    laneTop + (homeRow.get(threadId) ?? 0) * LANE_HEIGHT;

  const linksByThread = new Map<string, PlotThreadLinkRow[]>();
  for (const l of links) {
    const arr = linksByThread.get(l.threadId);
    if (arr) arr.push(l);
    else linksByThread.set(l.threadId, [l]);
  }

  // merge(from→to)@X = from が X で畳まれる / branch(from→to)@X = to が X で生まれる。
  // 線の継ぎ目（run 分割）に使うため、スレッド別に「列番号」の集合へ落とす。
  const mergeColsByThread = new Map<string, Set<number>>();
  const branchColsByThread = new Map<string, Set<number>>();
  const addCol = (m: Map<string, Set<number>>, k: string, v: number) => {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  for (const b of branches) {
    const x = sceneX.get(b.atNodeId);
    if (x === undefined || x >= scheduledCount) continue;
    if (b.kind === "merge") addCol(mergeColsByThread, b.fromThreadId, x);
    else addCol(branchColsByThread, b.toThreadId, x);
  }

  interface Prep {
    thread: PlotThreadRow;
    markers: PlotLaneMarker[]; // y は後で埋める
    markerCols: Set<number>; // マーカーを持つ列（出会い判定用）
    lo: number; // 生存スパン開始列（override 反映）
    hi: number; // 生存スパン終了列
    living: boolean;
  }

  let maxX = 0;
  const preps: Prep[] = orderedThreads.map((thread) => {
    const raw = linksByThread.get(thread.id) ?? [];
    const markers: PlotLaneMarker[] = raw
      .filter((l) => {
        const x = sceneX.get(l.nodeId);
        return x !== undefined && x < scheduledCount;
      })
      .map((l) => {
        const x = sceneX.get(l.nodeId)!;
        if (x > maxX) maxX = x;
        return {
          linkId: l.id,
          nodeId: l.nodeId,
          phaseType: l.phaseType,
          x,
          y: 0,
        };
      })
      .sort((a, b) => {
        if (a.x !== b.x) return a.x - b.x;
        const p =
          (PHASE_ORDER[a.phaseType] ?? 0) - (PHASE_ORDER[b.phaseType] ?? 0);
        return p !== 0 ? p : cmpId(a.linkId, b.linkId);
      });
    const markerCols = new Set(markers.map((m) => m.x));

    // 生存スパン = [min(firstMarkerX,start), max(lastMarkerX,end)]。override は延長であり
    // マーカーを切り捨てない。override は scheduled 内のみ採用。
    const validOverride = (id: string | null): number | undefined => {
      if (!id) return undefined;
      const x = sceneX.get(id);
      return x !== undefined && x < scheduledCount ? x : undefined;
    };
    const startX = validOverride(thread.startNodeId ?? null);
    const endX = validOverride(thread.endNodeId ?? null);
    const firstMarkerX = markers.length ? markers[0].x : undefined;
    const lastMarkerX = markers.length
      ? markers[markers.length - 1].x
      : undefined;
    const loCands = [firstMarkerX, startX].filter(
      (v): v is number => v !== undefined,
    );
    const hiCands = [lastMarkerX, endX].filter(
      (v): v is number => v !== undefined,
    );
    let lo = loCands.length ? Math.min(...loCands) : undefined;
    let hi = hiCands.length ? Math.max(...hiCands) : undefined;
    if (lo === undefined) lo = hi;
    if (hi === undefined) hi = lo;
    const living = lo !== undefined;
    if (living && (hi as number) < (lo as number)) hi = lo;
    if (living && (hi as number) > maxX) maxX = hi as number;

    return {
      thread,
      markers,
      markerCols,
      lo: lo ?? 0,
      hi: hi ?? 0,
      living,
    };
  });

  // ───────── 収束（出会い列）: ≥2 レーンがマーカーを持つ列 ─────────
  const threadsWithMarkerAt = new Map<number, string[]>();
  for (const p of preps) {
    for (const x of p.markerCols) {
      const arr = threadsWithMarkerAt.get(x);
      if (arr) arr.push(p.thread.id);
      else threadsWithMarkerAt.set(x, [p.thread.id]);
    }
  }
  const convergences = [...threadsWithMarkerAt.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([x]) => x)
    .sort((a, b) => a - b);

  // ───────── 列ごとの実 Y(px): 各スレッドは固定ホーム行を真っ直ぐ走る ─────────
  // （出会いで寄せる挙動はユーザー指定で無し。収束は convergences の淡い縦バンドのみで表す）。
  const yByColumnByThread = new Map<string, Map<number, number>>();
  for (const p of preps) {
    if (!p.living) continue;
    const m = new Map<number, number>();
    const y = homeY(p.thread.id);
    for (let c = p.lo; c <= p.hi; c++) m.set(c, y);
    yByColumnByThread.set(p.thread.id, m);
  }

  // ───────── 出力: レーン ─────────
  const lanes: PlotLane[] = preps.map((p) => {
    const thread = p.thread;
    const yHome = homeY(thread.id);
    if (!p.living) {
      return {
        thread,
        y: yHome,
        markers: [],
        lineSegments: [],
        terminusX: null,
        yByColumn: new Map(),
      };
    }
    const yByColumn = yByColumnByThread.get(thread.id)!;
    const markers = p.markers.map((mk) => ({
      ...mk,
      y: yByColumn.get(mk.x) ?? yHome,
    }));

    // run 分割（生存スパン上で merge-out 後 / branch-in 前に切る）。
    const mergeCols = mergeColsByThread.get(thread.id);
    const branchCols = branchColsByThread.get(thread.id);
    const runs: Array<[number, number]> = [];
    let runStart = p.lo;
    for (let c = p.lo; c <= p.hi; c++) {
      const isLast = c === p.hi;
      let breakHere = isLast;
      if (!isLast && (mergeCols?.has(c) || branchCols?.has(c + 1))) {
        breakHere = true;
      }
      if (breakHere) {
        runs.push([runStart, c]);
        runStart = c + 1;
      }
    }

    const lineSegments: PlotLineSegment[] = [];
    for (const [rs, re] of runs) {
      if (re === rs) continue; // 単一列 run は点（ゼロ長線は描かない）
      let i = rs;
      while (i < re) {
        const y = yByColumn.get(i) ?? yHome;
        let j = i;
        while (j + 1 <= re && (yByColumn.get(j + 1) ?? yHome) === y) j++;
        if (j > i) {
          lineSegments.push({ x1: i, y1: y, x2: j, y2: y });
        }
        if (j < re) {
          const yNext = yByColumn.get(j + 1) ?? yHome;
          lineSegments.push({ x1: j, y1: y, x2: j + 1, y2: yNext });
          i = j + 1;
        } else {
          i = j + 1;
        }
      }
    }

    // 終端キャップ: 最後の run が自走（merge でない）かつ長さを持つなら hi。
    const lastRun = runs[runs.length - 1];
    const terminusX =
      lastRun && lastRun[1] > lastRun[0] && !mergeCols?.has(lastRun[1])
        ? lastRun[1]
        : null;

    return {
      thread,
      y: yHome,
      markers,
      lineSegments,
      terminusX,
      yByColumn,
    };
  });
  const laneByThread = new Map(lanes.map((l) => [l.thread.id, l]));

  // ───────── 分岐 / 合流コネクタ（fromY/toY は at 列の実 Y）─────────
  const orderedBranches = [...branches].sort((a, b) => cmpId(a.id, b.id));
  const connectors: PlotConnector[] = orderedBranches.flatMap((b) => {
    const from = laneByThread.get(b.fromThreadId);
    const to = laneByThread.get(b.toThreadId);
    const x = sceneX.get(b.atNodeId);
    if (!from || !to || x === undefined || x >= scheduledCount) return [];
    const fromY = from.yByColumn.get(x) ?? from.y;
    const toY = to.yByColumn.get(x) ?? to.y;
    return [
      {
        id: b.id,
        x,
        fromY,
        toY,
        kind: b.kind,
        color: from.thread.color,
      },
    ];
  });

  return {
    lanes,
    contentWidth: maxX,
    contentHeight: laneTop + orderedThreads.length * LANE_HEIGHT,
    convergences,
    connectors,
  };
}
