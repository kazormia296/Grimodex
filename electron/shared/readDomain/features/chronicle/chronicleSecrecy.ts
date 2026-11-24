import type { EventRow, SceneEventRow } from "./eventRows.js";

/**
 * 出来事の秘匿判定は廃止済み。ここには、残る読む順の位置と開示アンカーの helper を置く。
 */

/** sceneId → 読む順 index(0-based・小さいほど前方)。computeGlobalSceneOrder の出力。 */
export type ReadingOrder = Map<string, number>;

/** 開示アンカー算出に必要な最小イベント形（EventRow も満たす）。 */
type RevealEvent = Pick<EventRow, "id" | "revealSceneId">;

/** 読む順 index。未知シーンは +Infinity(fail-safe で「前方」扱いされない)。 */
export function readingPos(order: ReadingOrder, sceneId: string): number {
  return order.get(sceneId) ?? Number.POSITIVE_INFINITY;
}

/**
 * 開示アンカーの effective 値(動的算出)。
 *  - 明示 `revealSceneId` があればそれ(作者上書き)。
 *  - 無ければ「読む順 index が最小のスタンプ済シーン」(初出シーン)。
 *    scene_events の INSERT 順ではなく readingOrder 上の最小を取る。
 *  - スタンプ無し / すべて order 外 → null(開示アンカーを導出できない)。
 */
export function effectiveRevealSceneId(
  event: RevealEvent,
  sceneEvents: SceneEventRow[],
  readingOrder: ReadingOrder,
): string | null {
  if (event.revealSceneId != null) return event.revealSceneId;
  let best: string | null = null;
  let bestPos = Number.POSITIVE_INFINITY;
  for (const se of sceneEvents) {
    if (se.eventId !== event.id) continue;
    const pos = readingPos(readingOrder, se.sceneId);
    if (pos < bestPos) {
      bestPos = pos;
      best = se.sceneId;
    }
  }
  return best;
}
