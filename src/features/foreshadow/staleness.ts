import type { ForeshadowSetupRow } from "./types";

/**
 * Setup の AI 強度評価が stale かどうかを判定する。
 * 次のいずれかで true:
 * - lastEvaluatedAt が null（未評価）
 * - シーンの更新時刻が評価時刻より新しい
 * - リンク先 Codex の変更時刻 (codexLinkDirtyAt) が評価時刻より新しい
 *   （impact-review: Codex 変更で伏線の再評価を促す）
 * treeNodes.updatedAt は ISO text 文字列。
 */
export function isSetupEvaluationStale(
  setup: ForeshadowSetupRow,
  sceneUpdatedAt: string,
  codexLinkDirtyAt?: Date | null,
): boolean {
  if (!setup.lastEvaluatedAt) return true;
  if (new Date(sceneUpdatedAt) > setup.lastEvaluatedAt) return true;
  if (codexLinkDirtyAt && codexLinkDirtyAt > setup.lastEvaluatedAt) return true;
  return false;
}
