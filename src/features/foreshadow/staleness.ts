import type { ForeshadowSetupRow } from "./types";

/**
 * Setup の AI 強度評価が stale かどうかを判定する。
 * 次のいずれかで true:
 * - lastEvaluatedAt が null（未評価）
 * - シーンの更新時刻が評価時刻より新しい
 * - リンク先 Codex の変更時刻 (codexLinkDirtyAt) が評価時刻より新しい
 *   （impact-review: Codex 変更で伏線の再評価を促す）
 * treeNodes.updatedAt は ISO text 文字列。
 *
 * NOTE: この timestamp 比較は暫定実装。Narrative Maintenance の
 * Dependency digest（`src/features/narrative-extraction/maintenance/`）が
 * 導入され次第、digest 比較ベースの判定に置き換える予定。
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

/**
 * `isSetupEvaluationStale` の別名。既存呼び出し元の挙動を変えないための
 * 互換ラッパー — 新規コードは `isSetupEvaluationStale` を直接使うこと。
 */
export function isSetupEvaluationStaleCompat(
  setup: ForeshadowSetupRow,
  sceneUpdatedAt: string,
  codexLinkDirtyAt?: Date | null,
): boolean {
  return isSetupEvaluationStale(setup, sceneUpdatedAt, codexLinkDirtyAt);
}

export type SetupStaleReason =
  | "never-evaluated"
  | "scene-updated"
  | "codex-link-dirty"
  | "fresh";

/**
 * Soft bridge: timestamp stale remains until Dependency digest cutover.
 * `isSetupEvaluationStale` が true を返す理由（またはそもそも stale
 * ではないこと）を、UI で表示できる粒度で説明する。
 */
export function describeSetupStaleReason(
  setup: ForeshadowSetupRow,
  sceneUpdatedAt: string,
  codexLinkDirtyAt?: Date | null,
): SetupStaleReason {
  if (!setup.lastEvaluatedAt) return "never-evaluated";
  if (new Date(sceneUpdatedAt) > setup.lastEvaluatedAt) return "scene-updated";
  if (codexLinkDirtyAt && codexLinkDirtyAt > setup.lastEvaluatedAt) {
    return "codex-link-dirty";
  }
  return "fresh";
}
