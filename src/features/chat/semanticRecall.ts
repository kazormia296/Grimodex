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

/**
 * 日本語モデル (ruri-v3-30m) 用のスコア「床」。ここを下回るチャンクは注入しない。
 * 注入する/しないの判定は下の TOP1_GATE で行い、ゲートを通った時だけ二番手以降を
 * この床まで拾う (top-1 ゲート + runner-up 床方式)。
 * ruri は無関係な散文どうしでも cosine が 0.79 前後に座る高ベースライン特性のため、
 * この床を単独の閾値にすると無関係シーンの団子 (0.82〜0.84) を巻き込む。そこで
 * 「明確な勝者 (ゲート 0.85) がいる時だけ床 0.80 まで recall を取る」構成にする。
 * 値は calibrate-embedding-threshold.py(ja-calibration.jsonl)推奨 0.85 をゲートに、
 * その下 0.05 を recall 用の床に充てたもの。
 * 詳細: docs/Grimodex_セマンティック検索の閾値とモデル特性.md。
 */
export const SEMANTIC_RECALL_MIN_SCORE = 0.8;
/**
 * 日本語モデル用の top-1 ゲート。最良ヒットがこの値に届かない (= 明確に関連する
 * シーンが無い) クエリでは何も注入しない。届いた時だけ MIN_SCORE まで二番手を拾う。
 * これで「無関係シーンが団子状に並ぶだけ」のクエリでの誤注入を防ぐ。
 * 値は ja の校正推奨値 (calibrate RECOMMENDED 0.85) と一致。
 * 注意: ruri は winner↔団子のギャップが ~0.04 と狭く、この方式でも overlap を
 * 完全には分離できない (真の解は reranker)。実効は dev の Run search eval で計測可。
 */
export const SEMANTIC_RECALL_TOP1_GATE = 0.85;
/**
 * 英語モデル (bge-small-en-v1.5, CLS pooling) 用のスコア下限。
 * `scripts/calibrate-embedding-threshold.py`(36ペアコーパス)で確定した値:
 * t=0.51 で related 再現率 0.86 / unrelated 誤検出率 0.048 が (recall-fp) 最大点。
 * 同一作品内の散文は汎用英語モデルでもベースライン類似度が高いため、ja の
 * 0.5 とは別系統の絶対値になる。実プロジェクトのログで微調整余地あり。
 */
export const SEMANTIC_RECALL_MIN_SCORE_EN = 0.51;
/**
 * 英語モデル (bge-small-en-v1.5) は related↔unrelated の分離マージンが広く
 * (~0.18) ja のような団子問題が無いため、ゲート = 床 とし注入判定は床のみで行う
 * (= 従来どおりの単一閾値 0.51)。
 */
export const SEMANTIC_RECALL_TOP1_GATE_EN = SEMANTIC_RECALL_MIN_SCORE_EN;
/** プロンプトに注入する抜粋の上限件数。 */
export const SEMANTIC_RECALL_MAX_CHUNKS = 3;
/** 現在シーン・@mention シーン・低スコアの間引きを見込んだ取得件数。 */
export const SEMANTIC_RECALL_FETCH_LIMIT = 12;
/** クエリ seed に含めるシーン本文末尾の文字数。 */
export const SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS = 500;
/** 1 チャンクあたりの注入文字数上限 (超過分は切り詰めて省略記号を付す)。 */
export const SEMANTIC_RECALL_MAX_CHUNK_CHARS = 600;
/** 英語は文字あたり情報量が低いので 1 チャンクの注入上限を広げる。 */
export const SEMANTIC_RECALL_MAX_CHUNK_CHARS_EN = 900;

/**
 * 現在のプロジェクト言語に応じた recall パラメータ。言語は projectStore が
 * `document.documentElement.lang` に反映する (lint と同じソース)。
 */
export function recallParamsForLang(lang?: string): {
  minScore: number;
  maxChunkChars: number;
  gateScore: number;
} {
  const resolved =
    lang ??
    (typeof document !== "undefined" ? document.documentElement.lang : "ja");
  if (resolved.startsWith("en")) {
    return {
      minScore: SEMANTIC_RECALL_MIN_SCORE_EN,
      maxChunkChars: SEMANTIC_RECALL_MAX_CHUNK_CHARS_EN,
      gateScore: SEMANTIC_RECALL_TOP1_GATE_EN,
    };
  }
  return {
    minScore: SEMANTIC_RECALL_MIN_SCORE,
    maxChunkChars: SEMANTIC_RECALL_MAX_CHUNK_CHARS,
    gateScore: SEMANTIC_RECALL_TOP1_GATE,
  };
}

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
 *
 * top-1 ゲート + runner-up 床方式: 除外シーン (現在シーン / @mention で全文注入済み)
 * を除いた最良候補が `gateScore` に届かなければ何も注入しない (= 明確に関連する
 * シーンが無いクエリは空)。届いた時だけ `minScore` (床) 以上の二番手を拾い、
 * スコア降順 → 件数 cap → 文字数 cap の順で返す。
 *
 * ruri は無関係散文でも cosine が高く座る (団子) ため、単一閾値だと「勝者あり」と
 * 「団子だけ」を見分けにくい。ゲートで precision を、床で recall を分担する。
 * 設計: docs/Grimodex_セマンティック検索の閾値とモデル特性.md。
 */
export function selectSemanticRecallChunks(
  hits: SemanticSearchHit[],
  opts: {
    excludeSceneIds: string[];
    minScore?: number;
    gateScore?: number;
    maxChunks?: number;
    maxChunkChars?: number;
  },
): SemanticRecallChunk[] {
  const minScore = opts.minScore ?? SEMANTIC_RECALL_MIN_SCORE;
  const gateScore = opts.gateScore ?? SEMANTIC_RECALL_TOP1_GATE;
  const maxChunks = opts.maxChunks ?? SEMANTIC_RECALL_MAX_CHUNKS;
  const maxChunkChars = opts.maxChunkChars ?? SEMANTIC_RECALL_MAX_CHUNK_CHARS;
  const excluded = new Set(opts.excludeSceneIds);

  const candidates = hits
    .filter((h) => !excluded.has(h.sceneId))
    .sort((a, b) => b.score - a.score);

  // top-1 ゲート: 最良候補がゲートに届かなければ何も注入しない (precision)。
  if (candidates.length === 0 || candidates[0].score < gateScore) return [];

  // ゲート通過時のみ床まで二番手を拾う (recall)。candidates[0] はゲート >= 床 より常に通る。
  return candidates
    .filter((h) => h.score >= minScore)
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
  const params = recallParamsForLang();
  const selected = selectSemanticRecallChunks(hits, {
    excludeSceneIds: args.excludeSceneIds,
    minScore: params.minScore,
    gateScore: params.gateScore,
    maxChunkChars: params.maxChunkChars,
  });
  // 注入判定の可観測性: 生ヒット数 / 足切り(スコア下限・除外シーン)後の
  // 注入数 / トップスコア。閾値が実データに合っているかはこの行で見る。
  const topScore =
    hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
  debugLog.info(
    "SemanticRecall",
    `hits=${hits.length} injected=${selected.length} ` +
      `gate=${params.gateScore} floor=${params.minScore}`,
    topScore !== null ? `topScore=${topScore.toFixed(3)}` : "no hits",
  );
  return selected;
}
