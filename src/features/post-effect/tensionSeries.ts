import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
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

/**
 * シーンを読了順（DFS pre-order）でソートして返す。
 * `computeGlobalSceneOrder` はフォルダノードが nodes に含まれていないと
 * DFS が root からたどれずに空 Map を返す場合がある。
 * その場合は parentId グループ内の sortOrder 順でフォールバックする。
 */
function sortScenesByReadingOrder(nodes: TreeNodeData[]): TreeNodeData[] {
  const order = computeGlobalSceneOrder(nodes);
  const scenes = nodes.filter((n) => n.nodeType === "scene");

  // 全シーンが order に含まれていれば DFS 順を使う
  if (scenes.every((n) => order.has(n.id))) {
    return scenes.slice().sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  // フォールバック: parentId でグループ化して各グループ内を sortOrder 順に並べ、
  // グループ同士は出現した最小 sortOrder で比較する（フォルダ不在の場合）。
  const groups = new Map<string | null, TreeNodeData[]>();
  for (const n of scenes) {
    const key = n.parentId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  }
  // グループ順: 各グループの最小 sortOrder で比較
  const groupEntries = [...groups.entries()].sort(([, a], [, b]) =>
    cmpKeys(a[0].sortOrder, b[0].sortOrder),
  );
  return groupEntries.flatMap(([, arr]) => arr);
}

export function buildTensionSeries(
  nodes: TreeNodeData[],
  bySceneId: Map<string, SceneLensRecord[]>,
): TensionPoint[] {
  const scenes = sortScenesByReadingOrder(nodes);

  const points: TensionPoint[] = scenes.map((n) => {
    const lenses = bySceneId.get(n.id) ?? [];
    const ps = lenses.find((l) => l.lensType === "plot_structure");
    const raw = ps?.metrics?.tension;
    const tension =
      typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : null;
    return { sceneId: n.id, title: n.title, tension, parentId: n.parentId, isChapterEnd: false };
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
