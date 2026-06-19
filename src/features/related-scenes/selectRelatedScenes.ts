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
  /**
   * 相対標準化による「クエリ内で際立つ」シーンの救済 (browse UI 向けの recall 追加)。
   * ruri は無関係散文でも cosine が高く座る (団子) ため絶対床だけだと取りこぼす一方、
   * 単純に床を下げると団子を巻き込む。そこで **二段ガード** で床下を救済する:
   *   (a) 絶対近傍: cosine >= `minScore - nearFloorMargin`
   *   (b) 明確な勝者: pool 最大 cosine >= `minScore` (勝者不在クエリでは発動しない)
   *   (c) 相対標準化: cosine が pool 中央値より `gap` 以上際立つ
   * 3 条件全てで初めて床下シーンを admit する。絶対床を撤廃しないので「勝者不在の団子
   * 最上位を過大評価」する副作用を避ける ([[grimodex-ruri-cosine-baseline]] の二段方式)。
   * パラメータ (特に gap) は実ログでの較正前提。省略で無効 (= 従来挙動)。
   * 注入用途では使わない (precision 優先)。related-scenes は誤検出コストの低い browse UI
   * なので recall 寄りのこの救済を許容する。
   */
  relativeRescue?: { gap: number; nearFloorMargin?: number };
}

function toRelatedScene(h: SemanticSearchHit): RelatedScene {
  return {
    sceneId: h.sceneId,
    sceneTitle: h.sceneTitle,
    chunkText: h.chunkText,
    score: h.score,
  };
}

/** 数値列の中央値 (偶数長は中央 2 値の平均)。空は 0。 */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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
 *   決定的にする。
 * - 並び順: hybrid (sparse/relative 関与) のときは RRF 降順。ただし dense 勝者
 *   (pool 最大 cosine) が confident (床=gate 以上) なら rank1 に固定する (dense 勝者
 *   アンカー)。RRF が語彙一致の弱関連を意味的最近傍の上に押す browse トレードオフを
 *   先頭 1 件だけ打ち消し、2 位以降は RRF のまま (sparse recall 補強を維持) する。
 *   純 dense (sparse/relative 無し) のときは cosine 降順 (従来挙動)。同点は sceneId 安定化。
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
  const hasSparse = sparseIds.length > 0;
  const rel = opts.relativeRescue;
  const rescueMargin = opts.rescueMargin ?? SEMANTIC_RECALL_RESCUE_MARGIN;
  const rescueFloor = minScore - rescueMargin;
  const cap = Math.max(0, maxScenes);

  // scene ごとの最良チャンクを残す (現在シーン / 未読 / 順序外 / 非有限スコアを除外)。
  // ここでは床で切らない: sparse / relative 救済が「床ぎりぎり下」の best チャンクを
  // 必要とし、相対標準化の中央値も pool 全体から取るため。admit 判定は下の二段で行う。
  const bestByScene = new Map<string, SemanticSearchHit>();
  for (const h of hits) {
    if (h.sceneId === currentSceneId) continue;
    if (!Number.isFinite(h.score)) continue;
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

  const pool = [...bestByScene.values()];
  if (pool.length === 0) return [];

  // dense 順位 (cosine 降順, sceneId 安定化)。
  const denseSorted = pool
    .slice()
    .sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId));
  const denseRank = new Map<string, number>();
  denseSorted.forEach((h, i) => denseRank.set(h.sceneId, i));

  const sparseRank = new Map<string, number>();
  for (const id of sparseIds) {
    if (sparseRank.has(id)) continue;
    sparseRank.set(id, sparseRank.size);
  }

  // 相対救済 (二段ガード) の前提値。
  const relNearFloor = minScore - (rel?.nearFloorMargin ?? rescueMargin);
  const background = rel ? median(pool.map((h) => h.score)) : 0;
  const hasWinner = rel ? denseSorted[0].score >= minScore : false;

  const admitted: { hit: SemanticSearchHit; rrf: number }[] = [];
  for (const h of pool) {
    const sRank = sparseRank.get(h.sceneId);
    const inSparse = sRank !== undefined;
    const denseConfident = h.score >= minScore;
    const sparseRescue = hasSparse && inSparse && h.score >= rescueFloor;
    const relativeRescue =
      !!rel &&
      hasWinner &&
      h.score >= relNearFloor &&
      h.score - background >= rel.gap;
    if (!denseConfident && !sparseRescue && !relativeRescue) continue;
    const dRank = denseRank.get(h.sceneId)!;
    const rrf = 1 / (RRF_K + dRank) + (inSparse ? 1 / (RRF_K + sRank) : 0);
    admitted.push({ hit: h, rrf });
  }
  if (admitted.length === 0) return [];

  // ランキング: sparse / relative が関与するなら RRF (sparse 寄与込み)、純 dense のみなら
  // cosine 降順 (従来挙動を保つ)。
  const fused = hasSparse || !!rel;
  admitted.sort((a, b) =>
    fused
      ? b.rrf - a.rrf ||
        b.hit.score - a.hit.score ||
        a.hit.sceneId.localeCompare(b.hit.sceneId)
      : b.hit.score - a.hit.score || a.hit.sceneId.localeCompare(b.hit.sceneId),
  );

  // dense 勝者アンカー (hybrid 時のみ): RRF は語彙一致の弱関連を「意味的に最も近い
  // 既読シーン」(= dense 勝者) の上へ押し上げてしまい、browse パネルの先頭が体験的に
  // 劣化する (R@1/MRR ↓)。そこで pool 最大 cosine のシーンが confident (床=gate 以上)
  // なら rank1 に固定する。固定するのは先頭 1 件だけで、2 位以降は RRF 並びのまま残す
  // ので、固有名詞 recall を補う sparse 救済 (R@3/recall の伸び) は維持される。
  // 勝者不在 (rescue-only regime: 最大 cosine が床未満) では固定しない — 守るべき dense
  // 勝者がいないので RRF の語彙順を尊重する。
  // 実測 (liveEval): R@1 0.29→0.40 / MRR 0.60→0.73 回復、R@3 0.54・recall 1.00 維持。
  if (fused && denseSorted[0].score >= minScore) {
    const anchorId = denseSorted[0].sceneId;
    const idx = admitted.findIndex((e) => e.hit.sceneId === anchorId);
    if (idx > 0) {
      const [anchor] = admitted.splice(idx, 1);
      admitted.unshift(anchor);
    }
  }
  return admitted.slice(0, cap).map((e) => toRelatedScene(e.hit));
}
