import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { SceneLensRecord } from "./types";

export interface TensionPoint {
  sceneId: string;
  title: string;
  tension: number | null;
  parentId: string | null;
  isChapterEnd: boolean;
}

export interface SaggyRun {
  startIdx: number;
  endIdx: number;
}

const SAG_THRESHOLD = 0.35;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function buildTensionSeries(
  nodes: TreeNodeData[],
  bySceneId: Map<string, SceneLensRecord[]>,
): TensionPoint[] {
  // 読了順は既存の正準関数を流用（フォルダを含む全ツリーが前提＝実データは常に満たす）。
  const order = computeGlobalSceneOrder(nodes);
  const scenes = nodes
    .filter((n) => n.nodeType === "scene" && order.has(n.id))
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  const points: TensionPoint[] = scenes.map((n) => {
    const lenses = bySceneId.get(n.id) ?? [];
    const ps = lenses.find((l) => l.lensType === "plot_structure");
    const raw = ps?.metrics?.tension;
    const tension =
      typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : null;
    return {
      sceneId: n.id,
      title: n.title,
      tension,
      parentId: n.parentId,
      isChapterEnd: false,
    };
  });

  for (let i = 0; i < points.length; i++) {
    points[i].isChapterEnd =
      i === points.length - 1 || points[i + 1].parentId !== points[i].parentId;
  }
  return points;
}

export function detectSaggyRuns(
  series: TensionPoint[],
  threshold: number = SAG_THRESHOLD,
): SaggyRun[] {
  const runs: SaggyRun[] = [];
  let start = -1;
  const flush = (endExclusive: number) => {
    if (start !== -1) {
      const endIdx = endExclusive - 1;
      if (endIdx - start >= 1) runs.push({ startIdx: start, endIdx });
      start = -1;
    }
  };
  for (let i = 0; i < series.length; i++) {
    const t = series[i].tension;
    const low = t !== null && t <= threshold;
    if (low) {
      if (start === -1) start = i;
    } else {
      flush(i);
    }
  }
  flush(series.length);
  return runs;
}
