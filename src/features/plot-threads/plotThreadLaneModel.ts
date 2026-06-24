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
}
/** スレッド線の連続セグメント（reading-order で xOf 変換して描画）。
 *  merge 点で終わり branch 点で始まるよう、継ぎ目で分割される。x はシーン index。 */
export interface PlotLineSegment {
  x1: number;
  x2: number;
}
export interface PlotLane {
  thread: PlotThreadRow;
  y: number;
  markers: PlotLaneMarker[];
  /** 連続線セグメント（隣接マーカーの連なり。merge/branch の継ぎ目で切れる）。 */
  lineSegments: PlotLineSegment[];
  /** 「完結」終端の x（線が自走で終わる＝最後のビートが merge でないとき）。
   *  merge で畳まれた終端や単独マーカーは null（終端キャップを出さない）。 */
  terminusX: number | null;
}
/** 分岐 / 合流のコネクタ。あるシーン x で fromY↔toY のレーン間を繋ぐ。 */
export interface PlotConnector {
  id: string;
  /** シーン x インデックス（px 変換は viewport の xOf に委ねる）。 */
  x: number;
  fromY: number;
  toY: number;
  kind: PlotBranchKind;
  /** from スレッドの色（コネクタ＝分岐元の色）。 */
  color: string | null;
}
export interface PlotLaneModel {
  lanes: PlotLane[];
  /** 最大シーン index（px 変換は viewport 側）。 */
  contentWidth: number;
  contentHeight: number;
  /** 2 本以上のスレッドがマーカーを持つシーン x（昇順・収束ハイライト用）。 */
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

/**
 * スレッド・リンク・シーン順序からレーン描画モデルを生成する純関数。
 * - レーンは sortOrder（fractional-index）昇順、同値は id で決定化。
 * - マーカーは存在するシーンのみ採用し、x 昇順 → phase 正準順 → id で決定化。
 * - laneTop はレーン群の開始 y（オーバーレイ時はシーン行の下に下げる）。既定 LANE_TOP。
 */
export function buildPlotLaneModel(args: {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  sceneX: Map<string, number>;
  laneTop?: number;
  branches?: PlotThreadBranchRow[];
  /** scheduled シーン数。これ以上の x（story-time の未配置シーン）は描かない。
   *  既定 Infinity（reading/write では全シーン scheduled なので無効）。
   *  未配置の xOf は scheduled 列へ折り重なるため、プロット側では弾く。 */
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

  const orderedThreads = [...threads].sort((a, b) => {
    const c = cmpKeys(a.sortOrder, b.sortOrder);
    if (c !== 0) return c;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const linksByThread = new Map<string, PlotThreadLinkRow[]>();
  for (const l of links) {
    const arr = linksByThread.get(l.threadId) ?? [];
    arr.push(l);
    linksByThread.set(l.threadId, arr);
  }

  // 線の継ぎ目: スレッドが merge で「畳まれる」シーン（線が終わる）と、
  // branch で「生まれる」シーン（線が始まる）。connectors と同じ向き定義:
  // branch = from→to(to が新規) / merge = from→to(from が畳まれる)。
  const mergeOutByThread = new Map<string, Set<string>>();
  const branchInByThread = new Map<string, Set<string>>();
  const addTo = (m: Map<string, Set<string>>, k: string, v: string) => {
    const s = m.get(k) ?? new Set<string>();
    s.add(v);
    m.set(k, s);
  };
  for (const b of branches) {
    if (b.kind === "merge") addTo(mergeOutByThread, b.fromThreadId, b.atNodeId);
    else addTo(branchInByThread, b.toThreadId, b.atNodeId);
  }

  let maxX = 0;
  const lanes: PlotLane[] = orderedThreads.map((thread, index) => {
    const raw = linksByThread.get(thread.id) ?? [];
    const markers: PlotLaneMarker[] = raw
      // シーンが存在しない / 未配置(x >= scheduledCount, story-time)のマーカーは描かない。
      // 未配置は xOf が scheduled 列へ折り重なり別シーンの列と衝突するため除外する。
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
        };
      })
      .sort((a, b) => {
        if (a.x !== b.x) return a.x - b.x;
        // 未知 phaseType でも NaN にならないよう ?? 0 で防御（CHECK で本来は不正値無し）。
        const p =
          (PHASE_ORDER[a.phaseType] ?? 0) - (PHASE_ORDER[b.phaseType] ?? 0);
        if (p !== 0) return p;
        return a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0;
      });

    // 線セグメント: 連続マーカーを繋ぐが、i が merge 点 / i+1 が branch 点なら
    // その間は切る（畳まれて→また分かれた、の継ぎ目を線で繋がない）。
    const mergeOut = mergeOutByThread.get(thread.id);
    const branchIn = branchInByThread.get(thread.id);
    const lineSegments: PlotLineSegment[] = [];
    let terminusX: number | null = null;
    let runStart = 0;
    for (let i = 0; i < markers.length; i++) {
      const isLast = i === markers.length - 1;
      let breakHere = isLast;
      if (!isLast) {
        const a = markers[i];
        const b = markers[i + 1];
        if (mergeOut?.has(a.nodeId) || branchIn?.has(b.nodeId))
          breakHere = true;
      }
      if (breakHere) {
        // 同一シーンに畳まれる run（全マーカーが同 x。例: 同シーン複数 phase）は
        // x1===x2 のゼロ長線になり round-cap で 20px の点塊が出るため描かない。
        if (markers[runStart].x !== markers[i].x) {
          lineSegments.push({ x1: markers[runStart].x, x2: markers[i].x });
          // 最後のセグメントが自走で終わる（merge でない）なら完結＝終端キャップ。
          if (isLast && !mergeOut?.has(markers[i].nodeId)) {
            terminusX = markers[i].x;
          }
        }
        runStart = i + 1;
      }
    }

    return {
      thread,
      y: laneTop + index * LANE_HEIGHT,
      markers,
      lineSegments,
      terminusX,
    };
  });

  // 収束: 2 本以上のレーンがマーカーを持つシーン x。各レーン内の重複 x は 1 回だけ
  // 数える（同一スレッドが同一シーンに複数段階を置いても 1 本扱い）。
  const xLaneCount = new Map<number, number>();
  for (const lane of lanes) {
    for (const x of new Set(lane.markers.map((m) => m.x))) {
      xLaneCount.set(x, (xLaneCount.get(x) ?? 0) + 1);
    }
  }
  const convergences = [...xLaneCount.entries()]
    .filter(([, c]) => c >= 2)
    .map(([x]) => x)
    .sort((a, b) => a - b);

  // 分岐 / 合流コネクタ: from/to スレッドと at シーンが全て存在するものだけ採用。
  const laneByThread = new Map(lanes.map((l) => [l.thread.id, l]));
  const connectors: PlotConnector[] = branches.flatMap((b) => {
    const from = laneByThread.get(b.fromThreadId);
    const to = laneByThread.get(b.toThreadId);
    const x = sceneX.get(b.atNodeId);
    // from/to レーン・at シーンが揃い、かつ at が scheduled 列のものだけ。
    if (!from || !to || x === undefined || x >= scheduledCount) return [];
    return [
      {
        id: b.id,
        x,
        fromY: from.y,
        toY: to.y,
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
