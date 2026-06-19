import type { SemanticSearchHit } from "@/features/semantic-search/api";

/**
 * 「関連する過去シーン」パネルの 1 行ぶんのデータ。
 * 1 シーン = 1 行 (最良スコアのチャンクを代表に集約)。
 */
export interface RelatedScene {
  sceneId: string;
  sceneTitle: string;
  /** 代表チャンク本文 (一致箇所)。ジャンプ時に findChunkInDoc へ渡す。 */
  chunkText: string;
  score: number;
}

export interface SelectRelatedScenesOptions {
  /** 現在編集中のシーン ID。null/空 のときは「過去」を定義できないため空配列。 */
  currentSceneId: string | null;
  /**
   * 読書順 (computeGlobalSceneOrder の結果)。scene id → 0-based index。
   * 「既読 = 現在シーンより前」を判定する正準ソース。
   */
  sceneOrder: Map<string, number>;
  /** これ未満のスコアは除外する床。言語別 (recallParamsForLang().gateScore) を渡す。 */
  minScore: number;
  /** 返す最大シーン数。 */
  maxScenes: number;
}

/**
 * 意味検索ヒットから「現在シーンより読書順で前にある関連シーン」
 * (= 既読の関連過去シーン) を選別する純関数。
 *
 * - 現在シーン自身と、読書順で現在以降 (= 未読) のシーンは除外する。
 * - 読書順 (sceneOrder) に存在しないシーン (folder/削除済) も除外する。
 * - スコア床 (minScore) 未満、および非有限スコア (NaN/Infinity) は除外。チャット注入の
 *   top-1 ゲートは使わない: 人間が関連性を判断できるパネルなので「明確な勝者がいなければ
 *   全部隠す」は不要。団子混入を避けるための per-scene 床の引き上げ (言語別 gate 値を渡す)
 *   は呼び出し側の責務。
 * - 1 シーン 1 行に集約 (最良スコアのチャンクを代表に)。同一シーン内で同スコアの
 *   チャンクが複数あるときは charStart が小さい (本文で先に出る) チャンクを代表にして
 *   決定的にする。行はスコア降順、同点は sceneId で安定化。
 */
export function selectRelatedPastScenes(
  hits: SemanticSearchHit[],
  opts: SelectRelatedScenesOptions,
): RelatedScene[] {
  const { currentSceneId, sceneOrder, minScore, maxScenes } = opts;
  if (!currentSceneId) return [];
  const currentOrder = sceneOrder.get(currentSceneId);
  if (currentOrder === undefined) return [];

  // scene ごとの最良チャンクだけを残す。
  const bestByScene = new Map<string, SemanticSearchHit>();
  for (const h of hits) {
    if (h.sceneId === currentSceneId) continue;
    // 非有限スコア (NaN/Infinity) は床比較が当てにならないので明示的に弾く。
    if (!Number.isFinite(h.score) || h.score < minScore) continue;
    const sceneRank = sceneOrder.get(h.sceneId);
    // 順序外 (folder/削除済) と、現在以降 (未読) を除外。
    if (sceneRank === undefined || sceneRank >= currentOrder) continue;
    const prev = bestByScene.get(h.sceneId);
    // 最良スコアを採用。同スコアは charStart が小さい (先に出る) チャンクで決定化。
    if (
      !prev ||
      h.score > prev.score ||
      (h.score === prev.score && h.charStart < prev.charStart)
    ) {
      bestByScene.set(h.sceneId, h);
    }
  }

  return [...bestByScene.values()]
    .sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId))
    .slice(0, Math.max(0, maxScenes))
    .map((h) => ({
      sceneId: h.sceneId,
      sceneTitle: h.sceneTitle,
      chunkText: h.chunkText,
      score: h.score,
    }));
}
