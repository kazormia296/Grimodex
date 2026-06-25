import type { TreeNodeData } from "@/features/tree/treeStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { AxisMode, SpacingMode } from "./timelineStore";

export interface TimelineSceneOrder {
  /** 軸順に並んだ scene ノード（story では scheduled→unscheduled）。 */
  scenes: TreeNodeData[];
  /** proportional spacing 用の比率（0..1）。uniform / reading では null。 */
  weights: number[] | null;
  /** story モードでの scheduled 数（= unscheduled 開始 index）。他軸では undefined。 */
  scheduledCount?: number;
}

/**
 * Timeline x 軸のシーン並びを `axisMode` 別に算出する単一正本。
 * TimelinePanel 描画と構造分析パネル（休眠/Markdown 行順）が同一順序を共有するため、
 * 並び替えロジックはここに集約する（軸一致の生命線）。
 */
export function computeTimelineSceneOrder(
  nodes: TreeNodeData[],
  axisMode: AxisMode,
  spacingMode: SpacingMode,
): TimelineSceneOrder {
  const sceneNodes = nodes.filter((n) => n.nodeType === "scene");

  if (axisMode === "reading") {
    const order = computeGlobalSceneOrder(nodes);
    const sorted = [...sceneNodes].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
    return { scenes: sorted, weights: null };
  }

  if (axisMode === "story") {
    const scheduled = sceneNodes.filter((n) => n.storyTimeOrder !== null);
    const unscheduled = sceneNodes.filter((n) => n.storyTimeOrder === null);
    scheduled.sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!));
    // reading-order fallback for unscheduled
    const readOrder = computeGlobalSceneOrder(nodes);
    unscheduled.sort(
      (a, b) => (readOrder.get(a.id) ?? 0) - (readOrder.get(b.id) ?? 0),
    );
    const sorted = [...scheduled, ...unscheduled];
    // For proportional spacing: use index within scheduled portion
    const ws =
      spacingMode === "proportional" && scheduled.length > 1
        ? scheduled.map((_, i) => i / (scheduled.length - 1))
        : null;
    return { scenes: sorted, weights: ws, scheduledCount: scheduled.length };
  }

  // write-order: sort by createdAt
  const sorted = [...sceneNodes].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const ws =
    spacingMode === "proportional" && sorted.length > 1
      ? (() => {
          const t0 = Date.parse(sorted[0].createdAt);
          const t1 = Date.parse(sorted[sorted.length - 1].createdAt);
          const span = t1 - t0 || 1;
          return sorted.map((n) => (Date.parse(n.createdAt) - t0) / span);
        })()
      : null;
  return { scenes: sorted, weights: ws };
}

/** 軸順 scene 配列を `nodeId → 0-based 軸 index` の Map に変換する。 */
export function sceneIndexById(scenes: TreeNodeData[]): Map<string, number> {
  const m = new Map<string, number>();
  scenes.forEach((s, i) => m.set(s.id, i));
  return m;
}
