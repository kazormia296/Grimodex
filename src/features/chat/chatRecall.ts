import {
  chatMessageSearch,
  type ChatMessageSearchHit,
  type SemanticSearchHit,
} from "../semantic-search/api";
import { invoke } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  recallParamsForLang,
  selectSemanticRecallChunks,
  selectHybridRecallChunks,
  SEMANTIC_RECALL_FETCH_LIMIT,
  SEMANTIC_RECALL_HYBRID_FETCH_LIMIT,
  SEMANTIC_RECALL_SPARSE_LIMIT,
  type SemanticRecallChunk,
} from "./semanticRecall";

/**
 * Chat episodic recall (エピソード記憶): 過去セッションを含むチャットを、シーンと
 * 同じ意味検索経路で recall し、プロンプトに注入するための取得・選別ロジック。
 *
 * 設計の核 (ユーザー合意):
 * - 「状態 (いま何が真実か)」は Codex (事実) + シーン recall が既に押さえている。
 *   ここが補うのは「エピソード (いつ何を話し・決め・捨てたか = 過程)」。
 * - recall に徹する柔らかい層。canon 化 (恒久的事実への固定) は従来どおり人が確認する
 *   Codex (硬い層) に残す。ここでは何も自動で書かない。
 * - チャットはシーンより雑多なので「実際に効いた発話」を重み付けする:
 *   weight = cos × roleBase × (1 + α·insertedToEditor + β·min(extractedCount, k))。
 *   素の assistant 散文 (信号なし) は基底重みを下げ、モデル自身の過去の憶測が
 *   「記憶」として等倍で戻る self-reference を抑える。
 * - 順序は Codex(always) > chat RAG (contextBuilder 側で担保)。古い対話が正典を
 *   上書きできない。
 *
 * gate/floor は scene recall と同じ `recallParamsForLang` を流用 (ja: gate0.85/floor0.80,
 * en: 0.51)。weight は cosine にかけてから gate に通すので「効いた発話」はゲートを
 * 越えやすくなる (ユーザー合意の挙動)。閾値較正は live eval で後追い。
 */

export interface ChatRecallMessage {
  messageId: string;
  sessionId: string;
  role: string;
  /** プロンプト表示用ラベル (役割ベース)。 */
  label: string;
  text: string;
  /** 重み付け後スコア (cosine × weight)。 */
  score: number;
}

/** insertedToEditor 信号の加点 α。 */
export const CHAT_RECALL_INSERTED_BOOST = 0.15;
/** extractedCodex/Snippet 1 件あたりの加点 β。 */
export const CHAT_RECALL_EXTRACTED_BOOST = 0.1;
/** extracted 加点の上限件数 k (青天井防止)。 */
export const CHAT_RECALL_EXTRACTED_CAP = 3;
/**
 * 効果信号を持たない素の assistant 散文の基底重み (< 1)。モデル自身の過去の憶測が
 * 等倍で「記憶」として戻る self-reference / ハルシネーション増幅を抑えるための減点。
 * user 発話・信号付き assistant は 1.0 (減点なし)。
 */
export const CHAT_RECALL_ASSISTANT_PLAIN_BASE = 0.8;

/**
 * 重み係数のチューナブルパラメータ。既定は上の定数。calibration ハーネス
 * (chatRecallCalibration.eval) が実埋め込みでこれを sweep して較正値を出すため、
 * 本番選別関数にそのまま注入できるよう options 化している (eval と本番のロジック
 * ドリフトを避ける)。
 */
export interface ChatRecallWeights {
  insertedBoost: number;
  extractedBoost: number;
  extractedCap: number;
  assistantPlainBase: number;
}

export const DEFAULT_CHAT_RECALL_WEIGHTS: ChatRecallWeights = {
  insertedBoost: CHAT_RECALL_INSERTED_BOOST,
  extractedBoost: CHAT_RECALL_EXTRACTED_BOOST,
  extractedCap: CHAT_RECALL_EXTRACTED_CAP,
  assistantPlainBase: CHAT_RECALL_ASSISTANT_PLAIN_BASE,
};

/**
 * 1 ヒットの重み係数を返す。cosine にこれを掛けたものを score として gate/sort に使う。
 * `weights` 省略時は本番既定 (DEFAULT_CHAT_RECALL_WEIGHTS)。
 */
export function chatRecallWeight(
  hit: {
    role: string;
    insertedToEditor: boolean;
    extractedCount: number;
  },
  weights: ChatRecallWeights = DEFAULT_CHAT_RECALL_WEIGHTS,
): number {
  const signalBoost =
    1 +
    (hit.insertedToEditor ? weights.insertedBoost : 0) +
    weights.extractedBoost *
      Math.min(Math.max(hit.extractedCount, 0), weights.extractedCap);
  const hasSignal = hit.insertedToEditor || hit.extractedCount > 0;
  const roleBase =
    hit.role === "assistant" && !hasSignal ? weights.assistantPlainBase : 1;
  return roleBase * signalBoost;
}

/** 役割からプロンプト表示ラベルを決める。 */
export function chatRecallLabel(role: string): string {
  return role === "assistant" ? "過去のAIの応答" : "過去のあなたの発言";
}

/**
 * en (bge-small-en-v1.5) のチャット用 gate/floor。scene の 0.51 はチャットの無関連
 * クエリ(bge は短い無関連でも raw cosine が 0.5〜0.64 に座る)を弾けず、実埋め込み
 * 較正で fpRate≈0.8 だった。gate を 0.66 へ引き上げると無関連を弾き fpRate=0 / R@1 0.71
 * / recall 0.64 になる(seed+LLM拡張コーパス・各言語の no-match=programming/tax/sports)。
 * ja(ruri)は raw-gate 化だけで scene 既定 0.85/0.80 が fpRate=0 になるため据え置き。
 * 値は小コーパス由来の暫定。詳細: docs/Grimodex_チャット履歴RAG_較正ハーネス.md。
 */
export const CHAT_RECALL_GATE_EN = 0.66;
export const CHAT_RECALL_FLOOR_EN = 0.6;

/**
 * chat episodic recall の閾値。scene の `recallParamsForLang` を土台に、較正で判明した
 * チャット固有の差分(en の gate/floor 引き上げ)だけ上書きする。gate は RAW cosine に
 * かかる(weighting はゲートに使わない)。
 */
export function chatRecallParamsForLang(lang?: string): {
  minScore: number;
  maxChunkChars: number;
  gateScore: number;
} {
  const base = recallParamsForLang(lang);
  const resolved =
    lang ??
    (typeof document !== "undefined" ? document.documentElement.lang : "ja");
  if (resolved.startsWith("en")) {
    return {
      ...base,
      gateScore: CHAT_RECALL_GATE_EN,
      minScore: CHAT_RECALL_FLOOR_EN,
    };
  }
  return base;
}

/**
 * chat ヒットを RAW cosine を score に持つ SemanticSearchHit 形にする
 * (sceneId↔messageId, sceneTitle↔役割ラベル)。**gate/floor/RRF は RAW cosine で行う**
 * ので scene recall の選別関数をそのまま再利用でき、precision 保証(団子・無関連の
 * 排除)も scene と同等になる。重み付けは選別後の並べ替えにのみ使う(下記)。
 */
function toRawHit(hit: ChatMessageSearchHit): SemanticSearchHit {
  return {
    sceneId: hit.messageId,
    sceneTitle: chatRecallLabel(hit.role),
    chunkText: hit.text,
    charStart: 0,
    charEnd: 0,
    score: hit.score, // RAW cosine
    dialogueRatio: 0,
  };
}

/**
 * dense (+ 任意 sparse) のチャットヒットを注入用に選別する純ロジック。
 *
 * - 現在進行中のターン (excludeSessionIds = 現セッション) は生ヒット段階で除外し、
 *   モデルが「いま話している内容」を記憶として引き戻すのを防ぐ。
 * - **gate/floor/選別は RAW cosine** で scene recall の選別を流用(precision 規律を
 *   scene と同一に保つ)。sparse があれば RRF 融合。
 * - **重み付け (効いた発話の加点・素 assistant の減点) は選別後の並べ替えにのみ使う**。
 *   重み付きスコアを gate にかけると、信号付きメッセージ (cos×1.15) が無関連クエリで
 *   ゲートを突破して precision を壊す — 実埋め込み較正で確認(ja 無関連クエリ raw≈0.78
 *   だが weighted≈0.98 で gate0.85 を突破)。よって gate は raw、重みは順位付けに限定。
 *   詳細: docs/Grimodex_チャット履歴RAG_較正ハーネス.md。
 */
export function selectChatRecallMessages(
  denseHits: ChatMessageSearchHit[],
  sparseMessageIdsRanked: string[],
  opts: {
    excludeSessionIds: string[];
    minScore?: number;
    gateScore?: number;
    maxChunks?: number;
    maxChunkChars?: number;
    rescueMargin?: number;
    /** 重み係数。省略時は本番既定。calibration sweep のみ非既定を渡す。 */
    weights?: ChatRecallWeights;
  },
): ChatRecallMessage[] {
  const excludedSessions = new Set(opts.excludeSessionIds);
  const weights = opts.weights ?? DEFAULT_CHAT_RECALL_WEIGHTS;

  const byId = new Map<string, ChatMessageSearchHit>();
  const rawDense: SemanticSearchHit[] = [];
  for (const h of denseHits) {
    if (excludedSessions.has(h.sessionId)) continue;
    byId.set(h.messageId, h);
    rawDense.push(toRawHit(h));
  }

  // sparse: 除外セッションの messageId を落とす。dense pool 外の id は hybrid 側で
  // 本文・cosine 無しとして自然に drop される (MVP 制約と同じ)。
  const sparseFiltered = sparseMessageIdsRanked.filter((id) => {
    const h = byId.get(id);
    return h ? !excludedSessions.has(h.sessionId) : true;
  });

  const selectOpts = {
    excludeSceneIds: [] as string[],
    minScore: opts.minScore,
    gateScore: opts.gateScore,
    maxChunks: opts.maxChunks,
    maxChunkChars: opts.maxChunkChars,
  };

  // gate/floor/選別は RAW cosine で行う(precision 保証)。
  const chunks: SemanticRecallChunk[] =
    sparseFiltered.length > 0
      ? selectHybridRecallChunks(rawDense, sparseFiltered, {
          ...selectOpts,
          rescueMargin: opts.rescueMargin,
        })
      : selectSemanticRecallChunks(rawDense, selectOpts);

  // 注入が確定したメッセージのみ、重み付きスコア (= raw×weight) で並べ替える。
  // 「効いた発話」を上位に・素の assistant 散文を下位に置く(self-reference 抑制)が、
  // どれを注入するかは raw が決めるのでゲート突破による無関連混入は起きない。
  return chunks
    .map((c) => {
      const hit = byId.get(c.sceneId);
      const weight = hit ? chatRecallWeight(hit, weights) : 1;
      return {
        messageId: c.sceneId,
        sessionId: hit?.sessionId ?? "",
        role: hit?.role ?? "user",
        label: c.sceneTitle,
        text: c.chunkText,
        rawScore: c.score,
        score: c.score * weight, // 重み付きスコア(順位付け用)
      };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ rawScore: _rawScore, ...m }) => m);
}

interface FtsChatRow {
  sourceType: string;
  id: string;
  title: string;
  excerpt: string;
}

/**
 * FTS5 (chat_messages_fts) で過去メッセージを bm25 順に引き、上位 messageId を順位
 * どおり返す。`fts_search` の `scope: "chat"` を使う。生クエリは Rust 側で sanitize
 * されるのでここでは整形しない。失敗は呼び出し側で空配列フォールバック。
 */
export async function fetchSparseChatMessageIds(args: {
  projectId: string;
  query: string;
  limit?: number;
}): Promise<string[]> {
  const rows = await invoke<FtsChatRow[]>("fts_search", {
    projectId: args.projectId,
    query: args.query,
    scope: "chat",
    limit: args.limit ?? SEMANTIC_RECALL_SPARSE_LIMIT,
  });
  return rows.filter((r) => r.sourceType === "chat").map((r) => r.id);
}

/**
 * episodic recall を実行して注入用メッセージを返す。失敗 (feature 無効 / モデル不在 /
 * 未 index) は全て空配列フォールバック — 通常送信を妨げないのが契約 (scene recall と同じ)。
 *
 * `hybrid` 指定時は dense と sparse (chat FTS5) を並列取得し RRF 融合。sparse が空 /
 * 失敗なら dense 単独へグレースフルに退避。
 */
export async function fetchChatRecall(args: {
  projectId: string;
  query: string;
  excludeSessionIds: string[];
  hybrid?: boolean;
}): Promise<ChatRecallMessage[]> {
  if (!args.query.trim()) return [];
  const params = chatRecallParamsForLang();
  const fetchLimit = args.hybrid
    ? SEMANTIC_RECALL_HYBRID_FETCH_LIMIT
    : SEMANTIC_RECALL_FETCH_LIMIT;

  const densePromise = chatMessageSearch({
    projectId: args.projectId,
    query: args.query,
    limit: fetchLimit,
  }).catch((e) => {
    debugLog.warn(
      "ChatRecall",
      "dense search failed (empty fallback)",
      errorDetail(e),
    );
    return [] as ChatMessageSearchHit[];
  });

  const sparsePromise: Promise<string[]> = args.hybrid
    ? fetchSparseChatMessageIds({
        projectId: args.projectId,
        query: args.query,
      }).catch((e) => {
        debugLog.warn(
          "ChatRecall",
          "sparse search failed (dense-only fallback)",
          errorDetail(e),
        );
        return [] as string[];
      })
    : Promise.resolve([] as string[]);

  const [hits, sparseMessageIds] = await Promise.all([
    densePromise,
    sparsePromise,
  ]);

  const selected = selectChatRecallMessages(hits, sparseMessageIds, {
    excludeSessionIds: args.excludeSessionIds,
    minScore: params.minScore,
    gateScore: params.gateScore,
    maxChunkChars: params.maxChunkChars,
  });

  const topRaw = hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
  debugLog.info(
    "ChatRecall",
    `mode=${args.hybrid ? "hybrid" : "dense"} hits=${hits.length} ` +
      `sparse=${sparseMessageIds.length} injected=${selected.length} ` +
      `gate=${params.gateScore} floor=${params.minScore}`,
    topRaw !== null ? `topRawCos=${topRaw.toFixed(3)}` : "no hits",
  );
  return selected;
}
