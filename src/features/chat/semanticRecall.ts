import { semanticSearch, type SemanticSearchHit } from "../semantic-search/api";
import { debugLog, errorDetail } from "@/lib/debugLog";

/**
 * Layer4 RAG (semantic recall): drafting チャットの文脈に、意味検索で見つけた
 * 過去シーンの抜粋を自動注入するための取得・選別ロジック。
 *
 * - クエリ seed = 直近ユーザー発話 + 現在シーン本文の末尾 (DB 保存値ベース)。
 *   eco モード等で本文が空でもユーザー発話だけで成立する。
 * - 結果はクエリ毎に変わるため、注入先は cacheSegments (prompt cache 安定領域)
 *   ではなく prompt + volatileTail (contextBuilder の semanticRecall 入力)。
 * - semantic_search は Cargo feature `semantic-embedding` ゲート内。無効ビルド
 *   や未 index プロジェクトでは静かに空配列へフォールバックする。
 */

export interface SemanticRecallChunk {
  sceneId: string;
  sceneTitle: string;
  chunkText: string;
  score: number;
}

/** スコア下限。ruri-v3 の正規化内積 [-1,1] で無関係チャンクは 0 近傍に集まる。 */
export const SEMANTIC_RECALL_MIN_SCORE = 0.5;
/** プロンプトに注入する抜粋の上限件数。 */
export const SEMANTIC_RECALL_MAX_CHUNKS = 3;
/** 現在シーン・@mention シーン・低スコアの間引きを見込んだ取得件数。 */
export const SEMANTIC_RECALL_FETCH_LIMIT = 12;
/** クエリ seed に含めるシーン本文末尾の文字数。 */
export const SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS = 500;
/** 1 チャンクあたりの注入文字数上限 (超過分は切り詰めて省略記号を付す)。 */
export const SEMANTIC_RECALL_MAX_CHUNK_CHARS = 600;

/**
 * 検索クエリ seed を組み立てる。ユーザー発話が「何を書こうとしているか」、
 * 本文末尾が「物語上の現在地」を表す。両方空なら空文字 (= 検索スキップ)。
 */
export function buildSemanticRecallQuery(args: {
  userMessage: string;
  sceneBody?: string;
}): string {
  const message = args.userMessage.trim();
  const body = (args.sceneBody ?? "").trim();
  const tail =
    body.length > SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS
      ? body.slice(-SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS)
      : body;
  return [message, tail].filter((s) => s.length > 0).join("\n");
}

/**
 * 検索ヒットを注入用チャンクに選別する。
 * スコア下限 → 除外シーン (現在シーン / @mention で全文注入済みのシーン) →
 * スコア降順 → 件数 cap → 文字数 cap の順。
 */
export function selectSemanticRecallChunks(
  hits: SemanticSearchHit[],
  opts: {
    excludeSceneIds: string[];
    minScore?: number;
    maxChunks?: number;
    maxChunkChars?: number;
  },
): SemanticRecallChunk[] {
  const minScore = opts.minScore ?? SEMANTIC_RECALL_MIN_SCORE;
  const maxChunks = opts.maxChunks ?? SEMANTIC_RECALL_MAX_CHUNKS;
  const maxChunkChars = opts.maxChunkChars ?? SEMANTIC_RECALL_MAX_CHUNK_CHARS;
  const excluded = new Set(opts.excludeSceneIds);

  return hits
    .filter((h) => h.score >= minScore && !excluded.has(h.sceneId))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .map((h) => ({
      sceneId: h.sceneId,
      sceneTitle: h.sceneTitle,
      chunkText:
        h.chunkText.length > maxChunkChars
          ? `${h.chunkText.slice(0, maxChunkChars)}…`
          : h.chunkText,
      score: h.score,
    }));
}

/**
 * semantic 検索を実行して注入用チャンクを返す。失敗 (feature 無効ビルド /
 * モデル不在 / 未 index) は全て空配列フォールバック — 通常文脈での送信を
 * 妨げないことが契約。
 */
export async function fetchSemanticRecall(args: {
  projectId: string;
  query: string;
  excludeSceneIds: string[];
}): Promise<SemanticRecallChunk[]> {
  if (!args.query.trim()) return [];
  const hits = await semanticSearch({
    projectId: args.projectId,
    query: args.query,
    limit: SEMANTIC_RECALL_FETCH_LIMIT,
  }).catch((e) => {
    // 空配列フォールバック (送信を妨げない契約) は維持しつつ、原因を
    // デバッグログに残す — 無言だと「未 index / feature 無効 / IPC timeout」
    // のどれで注入されないのか切り分け不能になる。
    debugLog.warn(
      "SemanticRecall",
      "search failed (empty fallback)",
      errorDetail(e),
    );
    return [] as SemanticSearchHit[];
  });
  const selected = selectSemanticRecallChunks(hits, {
    excludeSceneIds: args.excludeSceneIds,
  });
  // 注入判定の可観測性: 生ヒット数 / 足切り(スコア下限・除外シーン)後の
  // 注入数 / トップスコア。閾値が実データに合っているかはこの行で見る。
  const topScore =
    hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
  debugLog.info(
    "SemanticRecall",
    `hits=${hits.length} injected=${selected.length} minScore=${SEMANTIC_RECALL_MIN_SCORE}`,
    topScore !== null ? `topScore=${topScore.toFixed(3)}` : "no hits",
  );
  return selected;
}
