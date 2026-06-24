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

/**
 * マーカードラッグのドロップ先からアクションを決める純関数。
 * - 同レーン（ドロップ列で最寄りスロットが自スレッド）→ シーン移動（move-scene）
 * - 別レーン → その列で分岐/合流（branch）。下のレーン=branch / 上のレーン=merge。
 *
 * 束ねレイアウトでは「固定 sortOrder の上下」ではなく **ドロップ列のライブスロット順**
 * （再配置後の実 Y）で方向を判定する。さもないとテスト緑・アプリで方向反転になる。
 * 呼び出し側が「ドロップ列に存在する各レーンのライブスロット Y(px)」を columnSlots で渡す。
 */
export function resolveMarkerDrop(args: {
  dropY: number;
  sourceThreadId: string;
  /** ドロップ x に最寄りの scheduled シーン id（無ければ undefined）。 */
  nodeId: string | undefined;
  /** ドロップ列の各レーンのライブスロット Y(px)。順序は問わない（y で判定）。 */
  columnSlots: Array<{ threadId: string; y: number }>;
}): MarkerDropAction {
  const { dropY, sourceThreadId, nodeId, columnSlots } = args;
  if (!nodeId || columnSlots.length === 0) return { type: "none" };

  // ドロップ y に最も近いスロットのスレッドが対象。タイは先頭（呼び出し側の決定的順）。
  let target = columnSlots[0];
  let targetDist = Math.abs(target.y - dropY);
  for (const s of columnSlots) {
    const d = Math.abs(s.y - dropY);
    if (d < targetDist) {
      target = s;
      targetDist = d;
    }
  }

  // 同レーン → シーン移動
  if (target.threadId === sourceThreadId) {
    return { type: "move-scene", nodeId };
  }

  // 別レーン → その列で分岐/合流。ライブスロット Y で対象が下(=y 大)なら branch / 上なら merge。
  const source = columnSlots.find((s) => s.threadId === sourceThreadId);
  const sourceY = source ? source.y : dropY;
  const kind: PlotBranchKind = target.y > sourceY ? "branch" : "merge";
  return {
    type: "branch",
    fromThreadId: sourceThreadId,
    toThreadId: target.threadId,
    atNodeId: nodeId,
    kind,
  };
}
