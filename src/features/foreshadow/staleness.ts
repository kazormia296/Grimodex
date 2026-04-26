import type { ForeshadowSetupRow } from "./types";

/**
 * Setup の AI 強度評価が stale かどうかを判定する。
 * lastEvaluatedAt が null、またはシーンの更新時刻が評価時刻より新しい場合に true を返す。
 * treeNodes.updatedAt は ISO text 文字列。
 */
export function isSetupEvaluationStale(
  setup: ForeshadowSetupRow,
  sceneUpdatedAt: string,
): boolean {
  if (!setup.lastEvaluatedAt) return true;
  return new Date(sceneUpdatedAt) > setup.lastEvaluatedAt;
}
