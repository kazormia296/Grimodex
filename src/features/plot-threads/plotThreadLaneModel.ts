import { cmpKeys } from "@/features/tree/fractionalIndex";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";

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
export interface PlotLane {
  thread: PlotThreadRow;
  y: number;
  markers: PlotLaneMarker[];
}
export interface PlotLaneModel {
  lanes: PlotLane[];
  /** 最大シーン index（px 変換は viewport 側）。 */
  contentWidth: number;
  contentHeight: number;
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
 */
export function buildPlotLaneModel(args: {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  sceneX: Map<string, number>;
}): PlotLaneModel {
  const { threads, links, sceneX } = args;

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

  let maxX = 0;
  const lanes: PlotLane[] = orderedThreads.map((thread, index) => {
    const raw = linksByThread.get(thread.id) ?? [];
    const markers: PlotLaneMarker[] = raw
      .filter((l) => sceneX.has(l.nodeId)) // シーンが存在しないマーカーは描かない
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
    return { thread, y: laneY(index), markers };
  });

  return {
    lanes,
    contentWidth: maxX,
    contentHeight: laneY(orderedThreads.length),
  };
}
