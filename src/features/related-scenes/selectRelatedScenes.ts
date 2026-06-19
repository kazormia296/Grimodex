import type { SemanticSearchHit } from "@/features/semantic-search/api";
import {
  RRF_K,
  SEMANTIC_RECALL_RESCUE_MARGIN,
} from "@/features/chat/semanticRecall";

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
  /**
   * sparse (FTS5/bm25) で一致したシーン ID を bm25 順位どおりに並べたもの。渡すと
   * **hybrid モード**: dense (cosine) と sparse (語彙一致) の順位を Reciprocal Rank
   * Fusion で融合する。固有名詞 (人名・地名) は密ベクトルだと過小評価されがちなので、
   * sparse 上位に居るシーンは cosine が床ぎりぎり下 (`minScore - rescueMargin` まで) でも
   * 救済し、順位も押し上げる。dense pool に居ないシーン (本文・cosine を持たない) は
   * 救済対象外 (chat の selectHybridRecallChunks と同じ MVP 制約)。
   * 省略/空配列なら従来どおり dense 単独の選別 (完全後方互換)。
   * パネルは人間が判断する read-only なので、chat 注入の top-1 ゲートは持ち込まない
   * (床 + sparse 救済のみ)。
   */
  sparseSceneIds?: string[];
  /** sparse 救済の床マージン (hybrid 時のみ)。既定は chat と共通の正準値。 */
  rescueMargin?: number;
}

function toRelatedScene(h: SemanticSearchHit): RelatedScene {
  return {
    sceneId: h.sceneId,
    sceneTitle: h.sceneTitle,
    chunkText: h.chunkText,
    score: h.score,
  };
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

  const sparseIds = opts.sparseSceneIds ?? [];
  const hybrid = sparseIds.length > 0;
  const rescueMargin = opts.rescueMargin ?? SEMANTIC_RECALL_RESCUE_MARGIN;
  const rescueFloor = minScore - rescueMargin;
  // hybrid では sparse 救済の対象になりうる「床ぎりぎり下」シーンも候補に残す。
  // dense 単独では従来どおり床 (minScore) で切る。
  const candidateFloor = hybrid ? rescueFloor : minScore;
  const cap = Math.max(0, maxScenes);

  // scene ごとの最良チャンクだけを残す (現在シーン / 未読 / 順序外 / 候補床未満を除外)。
  const bestByScene = new Map<string, SemanticSearchHit>();
  for (const h of hits) {
    if (h.sceneId === currentSceneId) continue;
    // 非有限スコア (NaN/Infinity) は床比較が当てにならないので明示的に弾く。
    if (!Number.isFinite(h.score) || h.score < candidateFloor) continue;
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

  const candidates = [...bestByScene.values()];

  if (!hybrid) {
    // dense 単独 (従来挙動): 床以上をスコア降順、同点 sceneId 安定化。
    return candidates
      .sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId))
      .slice(0, cap)
      .map(toRelatedScene);
  }

  // hybrid: dense 順位 (cosine 降順) と sparse 順位 (bm25) を RRF 融合する。
  const denseRank = new Map<string, number>();
  candidates
    .slice()
    .sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId))
    .forEach((h, i) => denseRank.set(h.sceneId, i));

  const sparseRank = new Map<string, number>();
  for (const id of sparseIds) {
    if (sparseRank.has(id)) continue;
    sparseRank.set(id, sparseRank.size);
  }

  const eligible: { hit: SemanticSearchHit; rrf: number }[] = [];
  for (const h of candidates) {
    const sRank = sparseRank.get(h.sceneId);
    const inSparse = sRank !== undefined;
    const denseConfident = h.score >= minScore;
    // 候補は既に rescueFloor 以上なので、sparse に居れば救済成立。
    const sparseRescue = inSparse;
    if (!denseConfident && !sparseRescue) continue;
    const dRank = denseRank.get(h.sceneId)!;
    const rrf = 1 / (RRF_K + dRank) + (inSparse ? 1 / (RRF_K + sRank) : 0);
    eligible.push({ hit: h, rrf });
  }

  return eligible
    .sort(
      (a, b) =>
        b.rrf - a.rrf ||
        b.hit.score - a.hit.score ||
        a.hit.sceneId.localeCompare(b.hit.sceneId),
    )
    .slice(0, cap)
    .map((e) => toRelatedScene(e.hit));
}
