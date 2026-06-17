import { semanticSearch, type SemanticSearchHit } from "../semantic-search/api";
import { invoke } from "@/lib/tauri";
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
 * ハイブリッド検索 (dense + sparse/BM25) 用パラメータ。
 *
 * dense 単独の意味検索は 256/384 次元の密ベクトルで語彙完全一致を過小評価しがちで、
 * 小説で強い手がかりになる固有名詞 (人名・地名) の recall を落としやすい。既存の
 * FTS5 (trigram tokenizer, scene 本文を index) を sparse ランカーとして併用し、
 * Reciprocal Rank Fusion (RRF) で順位融合することで固有名詞 recall を補う。
 * 設計: docs/Grimodex_セマンティック検索の閾値とモデル特性.md (Q5 改善策 #4)。
 */
/** RRF の定数 k。順位 r のスコア寄与は 1/(k+r)。情報検索の慣例値 60。 */
export const RRF_K = 60;
/**
 * sparse 救済の床マージン。sparse top-N に居るシーンは、cosine が床 (minScore) を
 * 割っても `floor - margin` までなら注入を許す。語彙一致だが意味的には無関係な
 * 偶発ヒット (低 cosine) を弾く precision ガード — bm25 の IDF が共通語を下げる効果と
 * 二段で効かせる。
 */
export const SEMANTIC_RECALL_RESCUE_MARGIN = 0.05;
/**
 * ハイブリッド時の dense 取得件数。sparse で一致した「ゲートぎりぎり下」のシーンが
 * cosine とチャンク本文を伴って候補に乗るよう、dense 単独 (12) より広く取る。
 * dense pool に居ないシーンは本文・cosine を持たないため救済対象外 (MVP 制約)。
 */
export const SEMANTIC_RECALL_HYBRID_FETCH_LIMIT = 30;
/** sparse (FTS5) 側で考慮する scene 上位件数。bm25 rank 上位のみを救済対象にする。 */
export const SEMANTIC_RECALL_SPARSE_LIMIT = 10;

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
 * シーンが無いクエリは空)。届いた時だけ `minScore` (床) 以上を拾う。
 * 件数 cap 内では distinct シーンを優先し、枠が余ったら同一シーンの二番手チャンクで
 * 埋める (backfill): 別シーンという多様な選択肢がある時だけ二番手パッセージを譲るので、
 * 関連シーンが少ないときは同一シーンの別内容チャンクを取りこぼさない。
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

  // 除外シーンを除き、床 (minScore) 以上だけをスコア降順に。
  const sorted = hits
    .filter((h) => !excluded.has(h.sceneId) && h.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // top-1 ゲート: 最良候補がゲートに届かなければ何も注入しない (precision)。
  if (sorted.length === 0 || sorted[0].score < gateScore) return [];

  // distinct シーン優先 + backfill: まず各シーンの最良チャンク (distinct) を集め、
  // 枠が余ったら同一シーンの二番手チャンク (leftover) で埋める。これにより
  // 「別シーンという多様な選択肢がある時だけ」二番手パッセージを譲る — 関連シーンが
  // 少ないときは同一シーンの別チャンク (別内容) を取りこぼさない。
  const seenScenes = new Set<string>();
  const distinct: SemanticSearchHit[] = [];
  const leftover: SemanticSearchHit[] = [];
  for (const h of sorted) {
    if (seenScenes.has(h.sceneId)) {
      leftover.push(h);
    } else {
      seenScenes.add(h.sceneId);
      distinct.push(h);
    }
  }
  const chosen = [...distinct, ...leftover]
    .slice(0, maxChunks)
    .sort((a, b) => b.score - a.score);

  return chosen.map((h) => ({
    sceneId: h.sceneId,
    sceneTitle: h.sceneTitle,
    chunkText: truncateChunk(h.chunkText, maxChunkChars),
    score: h.score,
  }));
}

function truncateChunk(text: string, maxChunkChars: number): string {
  return text.length > maxChunkChars
    ? `${text.slice(0, maxChunkChars)}…`
    : text;
}

/**
 * dense (意味検索) と sparse (FTS5/bm25) の順位を RRF で融合して注入用チャンクを
 * 選別する。dense pool を土台にし (本文・cosine を持つのはこちらだけ)、sparse は
 * 順位の押し上げと「ゲート下の語彙一致シーン」の救済に使う。
 *
 * precision 設計 (docs の「迷ったら何も注入しない」を保つ):
 *  - densePass = 明確な勝者 (cosine >= gate) が居る。
 *  - eligible(scene) = sparseRescue || (densePass && denseConfident)
 *      - denseConfident: cosine >= floor (従来の recall 床)。
 *      - sparseRescue: sparse top-N に居て cosine >= floor-margin。
 *    勝者が居ない時 (densePass=false) は救済シーンだけを注入し、団子
 *    (床は超えるが勝者でない無関係シーン) を巻き込まない。救済も無ければ空。
 *  - 並びは RRF 降順 (タイブレーク cosine→sceneId)。余り枠は勝者がいる時だけ
 *    床以上シーンの二番手チャンクで埋める (従来 backfill の踏襲)。
 *
 * sparse 側で一致しても dense pool (HYBRID_FETCH_LIMIT 件) に居ないシーンは
 * 本文・cosine が無いため注入しない (MVP 制約)。
 */
export function selectHybridRecallChunks(
  denseHits: SemanticSearchHit[],
  sparseSceneIdsRanked: string[],
  opts: {
    excludeSceneIds: string[];
    minScore?: number;
    gateScore?: number;
    maxChunks?: number;
    maxChunkChars?: number;
    rescueMargin?: number;
  },
): SemanticRecallChunk[] {
  const minScore = opts.minScore ?? SEMANTIC_RECALL_MIN_SCORE;
  const gateScore = opts.gateScore ?? SEMANTIC_RECALL_TOP1_GATE;
  const maxChunks = opts.maxChunks ?? SEMANTIC_RECALL_MAX_CHUNKS;
  const maxChunkChars = opts.maxChunkChars ?? SEMANTIC_RECALL_MAX_CHUNK_CHARS;
  const rescueMargin = opts.rescueMargin ?? SEMANTIC_RECALL_RESCUE_MARGIN;
  const rescueFloor = minScore - rescueMargin;
  const excluded = new Set(opts.excludeSceneIds);

  // sparse 順位 map (除外シーンを除いた連番)。値が小さいほど上位。
  const sparseRank = new Map<string, number>();
  for (const id of sparseSceneIdsRanked) {
    if (excluded.has(id) || sparseRank.has(id)) continue;
    sparseRank.set(id, sparseRank.size);
  }

  // dense pool: 除外を除き、scene ごとの最良チャンクと二番手以降 (backfill 用) に分ける。
  const byScoreDesc = denseHits
    .filter((h) => !excluded.has(h.sceneId))
    .sort((a, b) => b.score - a.score);
  const bestByScene = new Map<string, SemanticSearchHit>();
  const leftover: SemanticSearchHit[] = [];
  for (const h of byScoreDesc) {
    if (bestByScene.has(h.sceneId)) leftover.push(h);
    else bestByScene.set(h.sceneId, h);
  }

  // dense 順位 = 最良チャンクの cosine 降順。値が小さいほど上位。
  const denseScenes = [...bestByScene.values()].sort(
    (a, b) => b.score - a.score,
  );
  const denseRank = new Map<string, number>();
  denseScenes.forEach((h, i) => denseRank.set(h.sceneId, i));
  const densePass = denseScenes.length > 0 && denseScenes[0].score >= gateScore;

  const eligible: { hit: SemanticSearchHit; rrf: number }[] = [];
  for (const h of denseScenes) {
    const dRank = denseRank.get(h.sceneId)!;
    const sRank = sparseRank.get(h.sceneId);
    const inSparse = sRank !== undefined;
    const sparseRescue = inSparse && h.score >= rescueFloor;
    const denseConfident = h.score >= minScore;
    if (!sparseRescue && !(densePass && denseConfident)) continue;
    const rrf = 1 / (RRF_K + dRank) + (inSparse ? 1 / (RRF_K + sRank) : 0);
    eligible.push({ hit: h, rrf });
  }
  if (eligible.length === 0) return [];

  eligible.sort(
    (a, b) =>
      b.rrf - a.rrf ||
      b.hit.score - a.hit.score ||
      a.hit.sceneId.localeCompare(b.hit.sceneId),
  );
  const chosen: SemanticSearchHit[] = eligible
    .slice(0, maxChunks)
    .map((e) => e.hit);

  // backfill: 勝者がいる時だけ、余り枠を床以上シーンの二番手チャンクで埋める。
  // rescue-only regime では団子混入を避けるため埋めない。
  if (densePass && chosen.length < maxChunks) {
    const room = maxChunks - chosen.length;
    const fillers = leftover.filter((h) => h.score >= minScore).slice(0, room);
    chosen.push(...fillers);
  }

  return chosen.map((h) => ({
    sceneId: h.sceneId,
    sceneTitle: h.sceneTitle,
    chunkText: truncateChunk(h.chunkText, maxChunkChars),
    score: h.score,
  }));
}

interface FtsSceneRow {
  sourceType: string;
  id: string;
  title: string;
  excerpt: string;
}

/**
 * FTS5 で scene を bm25 順に引き、上位の sceneId を順位どおり返す。
 * `fts_search` は生クエリを Rust 側 `to_fts_match` で sanitize するので、
 * ここでは整形せず recall クエリをそのまま渡す (二重 quote 化を避ける)。
 */
async function fetchSparseSceneIds(args: {
  projectId: string;
  query: string;
}): Promise<string[]> {
  const rows = await invoke<FtsSceneRow[]>("fts_search", {
    projectId: args.projectId,
    query: args.query,
    scope: "scenes",
    limit: SEMANTIC_RECALL_SPARSE_LIMIT,
  });
  return rows.filter((r) => r.sourceType === "scene").map((r) => r.id);
}

/**
 * semantic 検索を実行して注入用チャンクを返す。失敗 (feature 無効ビルド /
 * モデル不在 / 未 index) は全て空配列フォールバック — 通常文脈での送信を
 * 妨げないことが契約。
 *
 * `hybrid` 指定時は dense と sparse (FTS5/bm25) を並列取得し RRF 融合する。
 * sparse が空 / 失敗なら dense 単独の選別へグレースフルに退避する (= 従来挙動)。
 */
export async function fetchSemanticRecall(args: {
  projectId: string;
  query: string;
  excludeSceneIds: string[];
  hybrid?: boolean;
}): Promise<SemanticRecallChunk[]> {
  if (!args.query.trim()) return [];
  const params = recallParamsForLang();
  const fetchLimit = args.hybrid
    ? SEMANTIC_RECALL_HYBRID_FETCH_LIMIT
    : SEMANTIC_RECALL_FETCH_LIMIT;

  const densePromise = semanticSearch({
    projectId: args.projectId,
    query: args.query,
    limit: fetchLimit,
  }).catch((e) => {
    // 空配列フォールバック (送信を妨げない契約) は維持しつつ、原因を
    // デバッグログに残す — 無言だと「未 index / feature 無効 / IPC timeout」
    // のどれで注入されないのか切り分け不能になる。
    debugLog.warn(
      "SemanticRecall",
      "dense search failed (empty fallback)",
      errorDetail(e),
    );
    return [] as SemanticSearchHit[];
  });

  // sparse は失敗しても dense 単独へ退避する (注入ゼロにしない)。
  const sparsePromise: Promise<string[]> = args.hybrid
    ? fetchSparseSceneIds({
        projectId: args.projectId,
        query: args.query,
      }).catch((e) => {
        debugLog.warn(
          "SemanticRecall",
          "sparse search failed (dense-only fallback)",
          errorDetail(e),
        );
        return [] as string[];
      })
    : Promise.resolve([] as string[]);

  const [hits, sparseSceneIds] = await Promise.all([
    densePromise,
    sparsePromise,
  ]);

  const selected =
    args.hybrid && sparseSceneIds.length > 0
      ? selectHybridRecallChunks(hits, sparseSceneIds, {
          excludeSceneIds: args.excludeSceneIds,
          minScore: params.minScore,
          gateScore: params.gateScore,
          maxChunkChars: params.maxChunkChars,
        })
      : selectSemanticRecallChunks(hits, {
          excludeSceneIds: args.excludeSceneIds,
          minScore: params.minScore,
          gateScore: params.gateScore,
          maxChunkChars: params.maxChunkChars,
        });
  // 注入判定の可観測性: 取得モード / 生ヒット数 / sparse 件数 / 注入数 / トップスコア。
  // 閾値・融合が実データに合っているかはこの行で見る。
  const topScore =
    hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
  debugLog.info(
    "SemanticRecall",
    `mode=${args.hybrid ? "hybrid" : "dense"} hits=${hits.length} ` +
      `sparse=${sparseSceneIds.length} injected=${selected.length} ` +
      `gate=${params.gateScore} floor=${params.minScore}`,
    topScore !== null ? `topScore=${topScore.toFixed(3)}` : "no hits",
  );
  return selected;
}
