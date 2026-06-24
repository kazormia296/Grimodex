import type { PlotBranchKind } from "@/db/schema";

/** マーカーをドラッグして離した時の解決済みアクション（Model A: ドロップ先で自動判定）。 */
export type MarkerDropAction =
  | { type: "none" }
  | { type: "move-scene"; nodeId: string }
  | {
      type: "branch";
      fromThreadId: string;
      toThreadId: string;
      atNodeId: string;
      kind: PlotBranchKind;
    };

interface LaneLite {
  threadId: string;
  /** レーン中心 y（マーカーの cy）。 */
  y: number;
}

/**
 * マーカードラッグのドロップ先からアクションを決める純関数。
 * - 同レーン内 → シーン移動（move-scene）
 * - 別レーン → その列（最寄り scheduled シーン）で分岐/合流（branch）。
 *   下のレーン=branch / 上のレーン=merge。コミット側で「両スレッドのその場所に
 *   ポイントを打ち、エッジを張る」処理を行う。
 * 幾何（最寄りシーン）は呼び出し側の純関数で渡し、ここはロジックのみ。
 */
export function resolveMarkerDrop(args: {
  dropX: number;
  dropY: number;
  sourceThreadId: string;
  lanes: LaneLite[];
  laneHeight: number;
  /** ドロップ x に最寄りの scheduled シーン id（無ければ undefined）。 */
  nearestSceneId: (dropX: number) => string | undefined;
}): MarkerDropAction {
  const { dropX, dropY, sourceThreadId, lanes, laneHeight, nearestSceneId } =
    args;
  if (lanes.length === 0) return { type: "none" };

  const sourceLaneIndex = lanes.findIndex((l) => l.threadId === sourceThreadId);
  // ドロップ y → 最寄りレーン index（lanes[0].y を基準に laneHeight 刻み）。
  const rawIdx = Math.round((dropY - lanes[0].y) / laneHeight);
  const targetLaneIndex = Math.max(0, Math.min(lanes.length - 1, rawIdx));
  const targetLane = lanes[targetLaneIndex];

  const nodeId = nearestSceneId(dropX);
  if (!nodeId) return { type: "none" };

  // 同レーン → シーン移動
  if (targetLane.threadId === sourceThreadId) {
    return { type: "move-scene", nodeId };
  }

  // 別レーン → その列で分岐/合流（下=branch / 上=merge）
  const kind: PlotBranchKind =
    targetLaneIndex > sourceLaneIndex ? "branch" : "merge";
  return {
    type: "branch",
    fromThreadId: sourceThreadId,
    toThreadId: targetLane.threadId,
    atNodeId: nodeId,
    kind,
  };
}
