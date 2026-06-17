import type { Tiktoken } from "tiktoken/lite/init";
import i18next from "@/lib/i18n";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { L1TrimMarkers, L3TrimMarkers } from "@/prompts/shared/types";
import {
  JA_L1_TRIM_MARKERS,
  JA_L3_TRIM_MARKERS,
} from "@/prompts/ja/chatSystem";
import { getPromptCatalog } from "@/prompts/index";
import { recordMark } from "@/lib/perfLog";

export interface SceneContext {
  id: string;
  title: string;
  content: string;
  /** Raw ProseMirror JSON string (DB value). Used to extract Placed beats for context injection. */
  contentJson?: string;
  synopsis?: string;
  /** Story-time label for the current scene (e.g. "第3話・夕方"). Injected into L3 when set. */
  storyTimeLabel?: string | null;
}

export interface NoteContext {
  id: string;
  title: string;
  /** Plain text body (from prosemirrorToText). */
  content: string;
  aliases?: string[];
}

// ProjectContext は features/project/contextAtoms に切り出し、Chat と
// Map (AI Branch) で共有。互換のためここから re-export する。
export type { ProjectContext } from "@/features/project/contextAtoms";
import type { ProjectContext } from "@/features/project/contextAtoms";

export interface CodexContext {
  id: string;
  type: string;
  name: string;
  summary: string;
  /** エントリの別名 (JSON 配列). L4 にカンマ区切りで注入され、Agent が
   * 異なる呼称で言及されたエントリを再 fetch しなくて済むようにする。 */
  aliases?: string[];
  /** エントリのタグ名一覧。Spotlight 時のみ L4 に「タグ: ...」行として
   * 注入される (auto-detected には含めない)。Agent は `search_codex_by_tags`
   * でこの tag を起点に同タグの他エントリを発見できる。 */
  tags?: string[];
  contentFallback?: string; // G13: plain text from content if summary is empty
  fullContent?: string; // pinned entry: inject full content alongside summary
  childrenContext?: string; // pre-computed descendant summaries within budget
  customDetails?: Array<{ fieldName: string; value: string }>; // G14
  phaseLabel?: string; // フェーズラベル（フェーズ適用中のみ）
  /** Phase Cb: relation BFS 由来の注入。L4 trim pri = L4_PRI_RELATION */
  relationVia?: string;
}

export interface PinnedCodexContext extends CodexContext {
  withChildren?: boolean;
  children?: CodexContext[]; // full content children (budget ignored)
}

export interface PinnedSnippetContext {
  id: string;
  title: string;
  content: string; // plain text extracted from ProseMirror JSON
}

export interface PinnedStickyContext {
  id: string;
  title: string | null;
  content: string;
}

export interface TrimInput {
  baseText: string;
  l1Text: string;
  l2Text: string;
  l3Text: string;
  l4Text: string;
  l5Text: string;
  l6Text: string;
  /** semantic recall (Layer4 RAG) セクション。投機的文脈のため、予算超過時は
   * 既存レイヤーより先に削られる (trim 順の先頭)。未指定は空文字と等価。 */
  ragText?: string;
}

export interface TrimResult {
  trimmedTexts: TrimInput;
  trimmedLayers: string[];
  totalTokens: number;
}

export interface BuildSystemPromptInput {
  scene: SceneContext;
  project?: ProjectContext;
  storySoFar?: string;
  /** G11: 直前シーンのsynopsis（L3に追加） */
  previousScene?: { title: string; synopsis: string };
  codexEntries?: CodexContext[];
  pinnedCodexEntries?: PinnedCodexContext[];
  /** L6: /command で注入されるインストラクション（一回限り） */
  commandInstruction?: string;
  /** G8/G10: モデルのコンテキストウィンドウサイズ（比率ベース予算配分に使用） */
  contextWindow?: number;
  /**
   * モデル固有のハード出力上限（明確な制約があるモデルにのみ設定）。
   * 応答予約計算で min(maxOutputTokens, contextWindow*5%) のクランプに使用。
   */
  maxOutputTokens?: number;
  /** G9: 会話履歴のトークン数（trimToFit使用時に必要） */
  conversationTokens?: number;
  /** G25: トリムで除外するレイヤー（空文字に置換される） */
  excludeLayers?: string[];
  /** G17: 会話の要約テキスト（L5レイヤー） */
  conversationSummary?: string;
  /** G16: ピン留めされたSnippetエントリ (L4に注入) */
  pinnedSnippets?: PinnedSnippetContext[];
  /** Phase D: ピン留めされた Map Sticky (L4に注入) */
  pinnedStickies?: PinnedStickyContext[];
  /**
   * Map overlay: アクティブな Map board 全体を markdown 化したもの。
   * `<map>...</map>` で囲まれた 1 ブロック。pinnedStickies の直後に
   * L4_PRI_PINNED で追加され、stableLines にも積まれる。
   * 不要なら未指定 (undefined) で何もしない。
   */
  mapBoardMarkdown?: string;
  /** G19: アクティブタブのコンテンツ (L3に注入) */
  activeTabContent?: {
    type: "codex" | "snippet";
    title: string;
    content: string; // plain text
  };
  /**
   * スコープ対象 (Codex/Snippet スコープのアンカー)。`<focus_subject>` ブロックとして
   * L3 スロットの直後・L4 の前に注入し、「この会話の主題」を LLM へ明示する。
   * codex は Spotlight (pinned) 相当の構造化レンダリング (タグ/カスタム詳細/全文/子)
   * を行うため CodexContext をそのまま渡す。snippet は title + 抽出プレーンテキスト。
   * trim 対象外で常に注入されるため、呼び出し側は当該アンカーを L4 の pinned 配列
   * (pinnedCodexEntries / pinnedSnippets) から除外して重複させないこと。
   * 未指定なら何も注入しない。
   */
  focusSubject?:
    | { kind: "codex"; entry: CodexContext }
    | { kind: "snippet"; name: string; body: string };
  /** C-3: 「予定ビート」セクション文字列（buildPendingBeatsSection の結果）。Synopsis 後・本文前に注入。 */
  pendingBeatsSection?: string;
  /** Phase 1: 現在シーンに紐づくラベル名一覧。L3 のタイトル行に
   * `[ラベル1, ラベル2]` として注入される（Codex の phaseLabel と同じパターン）。
   * 空配列または undefined の場合は何も注入しない。 */
  sceneLabels?: string[];
  /** Phase 1: 現在シーンに紐づく伏線。Synopsis / Pending Beats の後、
   * シーン本文ヘッダの前に「### このシーンの伏線」として注入される。
   * setups は当シーンで仕込みが置かれた伏線、payoffs は当シーンで回収される伏線。
   * 両方が空の場合はセクションごと省略する。 */
  sceneForeshadow?: {
    setups: Array<{
      title: string;
      intent: string | null;
      derivedLabel?: string;
      strength?: string | null;
      excerpt?: string | null;
    }>;
    payoffs: Array<{
      title: string;
      intent: string | null;
      setupSceneTitle: string | null;
      derivedLabel?: string;
      strength?: string | null;
      excerpt?: string | null;
    }>;
  };
  /** Phase 2: プロジェクト全体の未回収伏線リスト。L2 storySoFar 末尾に
   * 「### 未回収の伏線」として追記される。loadBearing 優先度（critical →
   * supporting → optional → unspecified）でソート済みの想定。
   * 配列が空または undefined の場合はセクションごと省略する。 */
  openForeshadows?: Array<{
    title: string;
    intent: string | null;
    loadBearing: "critical" | "supporting" | "optional" | null;
    setupCount: number;
    derivedLabel?: string;
  }>;
  /** Phase 2: ストーリー時系列で 1 つ前のシーン。reading-order の
   * `previousScene` と異なる場合のみ注入される（呼び出し側で同一性判定済みを期待）。
   * `## 直前のシーン (ストーリー時系列)` ヘッダで `previousScene` の直後に配置。 */
  storyTimePreviousScene?: {
    title: string;
    synopsis: string;
    storyTimeLabel?: string | null;
  };
  /** Phase 4: プロジェクト全体の outline (著者手書き)。L2 の最先頭に
   * 「## プロジェクト Outline」として注入され、storySoFar より前に置く。
   * trim では outline は保持され、storySoFar が先に削られる挙動とする。 */
  projectOutline?: string;
  /** Phase 4: 現在シーンの祖先 folder の outline (= treeNodes.synopsis)。
   * outermost (root 近い) → innermost (現シーン直接親) 順。空配列 / undefined は省略。
   * L2 で projectOutline の直後・storySoFar の前に注入される。 */
  chapterOutlines?: Array<{
    title: string;
    outline: string;
  }>;
  /** Chat 入力で `@シーン名` メンションされた scene 本文を per-message pin
   * として L3 に注入する。folder/project スコープの eco モード等で本文が
   * 圧縮されていても、ここでメンションされた scene の本文は必ず注入される
   * (surgical override)。現在シーンと同一の id を含む場合は重複させない
   * (呼び出し側で除外済みを期待)。配列が空または undefined ならセクション省略。 */
  mentionedScenes?: Array<{
    id: string;
    title: string;
    content: string;
  }>;
  /** 執筆言語（project.language）。省略時は "ja" にフォールバック */
  lang?: string;
  /**
   * Agent モード（Tool Use ループ）として組み立てる場合 true。
   * baseText の直後に `agentInstruction` を挟み、
   * 「事前注入を起点にしてツールは深掘り用」という運用前提を LLM に明示する。
   */
  agentMode?: boolean;
  /**
   * ユーザーがプロジェクトごとに設定する、チャット用の追記カスタム指示
   * (project_settings: aiPrompt.custom.chat)。L0 baseText 末尾に追記され、
   * trim 対象外なので常に効く。空文字/未指定なら何も追記しない (byte-identical)。
   */
  customChatInstruction?: string;
  /** Codex entry IDs fixed at session start — L4 cache marker boundary. */
  sessionStableCodexIds?: string[];
  /** context_mode=always entries (L4 trim: lowest removal priority). */
  alwaysEntryIds?: string[];
  /** Note entries injected into L4 (mentioned / always). */
  noteEntries?: NoteContext[];
  /** context_mode=always note IDs (L4 trim: pri 4). */
  alwaysNoteIds?: string[];
  /** Phase Cb: Codex entries discovered via relation BFS (L4 pri 1). */
  relationCodexEntries?: CodexContext[];
  /**
   * semantic recall (Layer4 RAG): 意味検索で見つけた過去シーンの抜粋。
   * クエリ (直近ユーザー発話 + 現在シーン本文末尾) 依存で毎ターン変わるため、
   * cacheSegments には混ぜず prompt + volatileTail にのみ配置される。
   * trim では既存レイヤーより先に削られる。空配列 / undefined はセクション省略。
   */
  semanticRecall?: Array<{ sceneTitle: string; chunkText: string }>;
}

export interface LayerBudgets {
  responseReservation: number;
  l1: number;
  l2: number;
  l3: number;
  l4: number;
  l5: number;
  /**
   * 入力側 floor 合計 (4,500 tok) を満たせない極小コンテキストモデル
   * (例: AI のべりすと damsel = 2,400 tok) で発動する縮退モード。
   * L1/L2/L4 をゼロに圧縮し、L3 と L5 のみ確保する。
   */
  degraded: boolean;
}

/**
 * 応答予約トークン数の計算。
 * モデル固有の `maxOutputTokens` が定義されている場合はそれを上限としてクランプする。
 * undefined の場合はコンテキストウィンドウの 5%（最小 2,000）を採用。
 */
export function computeResponseReservation(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  const ratioBased = Math.max(Math.round(contextWindow * 0.05), 2000);
  return maxOutputTokens !== undefined
    ? Math.min(maxOutputTokens, ratioBased)
    : ratioBased;
}

/** 入力側 floor 合計 (応答予約を除く L1〜L5 の最小確保量の和) */
const INPUT_FLOOR_TOTAL = 4_500; // L1 500 + L2 500 + L3 2000 + L4 500 + L5 1000

/**
 * G8/G10: コンテキストウィンドウに対する比率ベース予算配分。
 * 応答予約を先に確保し、残りを各レイヤーに配分する。
 *
 * `available = contextWindow - responseReservation` が input floor 合計 (4,500 tok)
 * を割る場合は縮退モードに入り、L1/L2/L4 をゼロ、L3 と L5 のみ確保する。
 */
export function allocateLayerBudgets(
  contextWindow: number,
  opts?: { maxOutputTokens?: number },
): LayerBudgets {
  const responseReservation = computeResponseReservation(
    contextWindow,
    opts?.maxOutputTokens,
  );
  const available = Math.max(0, contextWindow - responseReservation);

  if (available < INPUT_FLOOR_TOTAL) {
    return {
      responseReservation,
      l1: 0,
      l2: 0,
      l3: Math.round(Math.min(2000, available * 0.6)),
      l4: 0,
      l5: Math.round(Math.min(1000, available * 0.3)),
      degraded: true,
    };
  }

  return {
    responseReservation,
    l1: Math.round(available * 0.02),
    l2: Math.round(available * 0.1),
    l3: Math.round(available * 0.4),
    l4: Math.round(available * 0.2),
    l5: Math.round(available * 0.2),
    degraded: false,
  };
}

export interface LayerBreakdown {
  layer: string; // "L1" ~ "L5"
  label: string; // "プロジェクト情報" 等
  used: number; // 実使用トークン数
}

export interface SystemPromptResult {
  prompt: string;
  totalTokens: number;
  layers: LayerBreakdown[];
  trimmedLayers?: string[];
  /** Anthropic cache_control segments (L1–L4 boundaries)。stable な内容のみ。 */
  cacheSegments?: string[];
  /**
   * cacheSegments の後ろに cache_control 無しで送る揮発層。
   * セッション途中で言及された non-stable L4 エントリ + semantic recall
   * (RAG / クエリ毎に変動) + L5 (会話要約) + L6 (コマンド指示)。
   * cacheSegments を使うプロバイダは system message 本文 (= prompt) を
   * 破棄するため、ここに乗せないと これらが届かない。
   */
  volatileTail?: string;
}

// tiktoken (WASM) を o200k_base ranks + lite ランタイムだけ動的 import する。
// 起動を遅らせないよう事前ロードはせず、`ensureTokenizer()` を chat フロー入口で await する。
let encoder: Tiktoken | null = null;
let encoderLoadingPromise: Promise<Tiktoken | null> | null = null;
let _heuristicWarned = false;

export async function ensureTokenizer(): Promise<void> {
  const __t0 = performance.now();
  if (encoder) {
    // Cached fast path. Records the cost of the async-call microtask hop
    // so we can distinguish "tokenizer init is slow" from "main thread is
    // backed up and the microtask is just queued behind sync work".
    recordMark("ensureTokenizer.cached", performance.now() - __t0, __t0);
    return;
  }
  if (!encoderLoadingPromise) {
    encoderLoadingPromise = (async () => {
      const __initStart = performance.now();
      try {
        const [liteInit, o200k, wasmUrl] = await Promise.all([
          import("tiktoken/lite/init"),
          import("tiktoken/encoders/o200k_base.json"),
          import("tiktoken/lite/tiktoken_bg.wasm?url"),
        ]);
        await liteInit.init((imports) =>
          WebAssembly.instantiateStreaming(fetch(wasmUrl.default), imports),
        );
        encoder = new liteInit.Tiktoken(
          o200k.default.bpe_ranks,
          o200k.default.special_tokens,
          o200k.default.pat_str,
        );
        recordMark(
          "ensureTokenizer.wasmInit",
          performance.now() - __initStart,
          __initStart,
        );
        return encoder;
      } catch (e) {
        // テスト環境 (happy-dom) や WASM サポート無し環境では heuristic にフォールバック。
        // countTokens() の `if (encoder)` 分岐で text.length / 2 が返る。
        console.warn(
          "[contextBuilder] tiktoken WASM init failed, falling back to heuristic",
          e,
        );
        recordMark(
          "ensureTokenizer.wasmInitFailed",
          performance.now() - __initStart,
          __initStart,
        );
        return null;
      }
    })();
  }
  await encoderLoadingPromise;
  recordMark("ensureTokenizer.awaitDone", performance.now() - __t0, __t0);
}

// Cache token counts to avoid redundant BPE encoding on the same text.
// Especially effective for repeated refreshContextLayers calls when scene
// content hasn't changed between typing events.
const _tokenCache = new Map<string, number>();
const _TOKEN_CACHE_MAX = 500;

/**
 * TipTap HTMLからAuthorshipMarkのspanタグ（data-authorship属性）を除去する。
 * ルビ・傍点等のHTMLタグは保持する。
 */
export function sanitizeSceneContent(html: string): string {
  // data-authorship属性を持つspanタグのみ除去（内容テキストは保持）
  return html.replace(
    /<span\b[^>]*\bdata-authorship\b[^>]*>([\s\S]*?)<\/span>/g,
    "$1",
  );
}

// ---------------------------------------------------------------------------
// Prompt-injection hardening: data-layer wrapper tags
// ---------------------------------------------------------------------------

/**
 * 各データレイヤーを包む予約タグ。baseText の「タグで囲まれたブロックは
 * 参照用の作品データ」宣言と対になる。L0/L6 は指示レイヤーなので包まない。
 * `##` 見出しはデータ内で偽装可能 (シーン本文/Codex content は Markdown) な
 * ため、セキュリティ境界はこのタグが担い、内部の `##` ヘッダは書式として温存する。
 * trim 関数群は `##` ヘッダ形式に依存するため、ラップは必ず trim 後に行うこと。
 */
export const PROMPT_DATA_TAGS = {
  l1: "project_info",
  l2: "story_so_far",
  l3: "current_scene",
  focus: "focus_subject",
  l4: "codex_entries",
  rag: "related_scenes",
  l5: "conversation_summary",
} as const;

// 予約タグ名の開閉タグ風文字列 (大文字小文字・空白変種を含む) を導く `<`。
// データ内に閉じタグが混入するとブロック境界の終了を偽装できるため、`<` の
// 直後に `\` を挿入して無害化する。挿入後は `<` の次が `\` になり再マッチ
// しない (冪等)。`<note>` `<sticky>` `<map>` は予約外なので素通しになる。
const RESERVED_TAG_RE =
  /<(?=\s*\/?\s*(?:project_info|story_so_far|current_scene|focus_subject|codex_entries|related_scenes|conversation_summary)\b)/gi;

/** データ内の予約タグ偽装をエスケープする (`</current_scene>` → `<\/current_scene>`)。 */
export function escapeReservedTags(text: string): string {
  return text.replace(RESERVED_TAG_RE, "<\\");
}

/**
 * trim 済みのレイヤーテキストを予約タグで包む。空白のみなら空文字を返し、
 * 空レイヤーに `<story_so_far></story_so_far>` のような空ブロックを出さない。
 */
export function wrapDataLayer(text: string, tag: string): string {
  if (!text.trim()) return "";
  const escaped = escapeReservedTags(text);
  const body = escaped.startsWith("\n") ? escaped.slice(1) : escaped;
  return `\n<${tag}>\n${body}\n</${tag}>`;
}

function deduplicateById(entries: CodexContext[]): CodexContext[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

// Re-export for backward compatibility
export type { L1TrimMarkers, L3TrimMarkers };

// ---------------------------------------------------------------------------
// Layer trim helpers
// ---------------------------------------------------------------------------

/**
 * L4 trim priority (v2.1 single-axis scale 0–4): lower = removed first.
 * Sequence reflects user-intent strength only; source type (Codex/Note/Sticky) is irrelevant.
 *
 * | pri | Category              | Blocks                                    |
 * | 0   | Auto-derived children | Codex children (children_budget)          |
 * | 1   | Auto-derived relation | Codex relations via BFS (Phase Cb)        |
 * | 2   | Mentioned             | Codex/Note mentioned; markerless default  |
 * | 3   | User-pinned           | Codex/Snippet/Sticky session pin          |
 * | 4   | User-marked-always    | Codex/Note context_mode=always            |
 */
export const L4_PRI_CHILD = 0;
export const L4_PRI_RELATION = 1;
export const L4_PRI_MENTIONED = 2;
export const L4_PRI_PINNED = 3;
export const L4_PRI_ALWAYS = 4;

export interface L4PriorityFlags {
  isChild: boolean;
  isAlways: boolean;
  isPinned: boolean;
  hasRelationVia: boolean;
}

export function computeL4Priority(flags: L4PriorityFlags): number {
  if (flags.isChild) return L4_PRI_CHILD;
  if (flags.isAlways) return L4_PRI_ALWAYS;
  if (flags.isPinned) return L4_PRI_PINNED;
  if (flags.hasRelationVia) return L4_PRI_RELATION;
  return L4_PRI_MENTIONED;
}

const L4_PRI_MARKER_RE = /<!-- l4pri:\d+ -->\n?/g;

/** trimL4Text 後に LLM へ渡す前で marker を除去。trim 内部 sort には marker が必要なので必ず trim 後に呼ぶこと。 */
function stripL4Markers(text: string): string {
  return text.replace(L4_PRI_MARKER_RE, "");
}

/** Max chars of a Note body injected into L4 to keep one Note from monopolizing the budget. */
export const NOTE_CONTENT_MAX_CHARS = 1500;

function truncateForL4(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** L4: remove lowest-priority entry blocks first. */
export function trimL4Text(text: string, targetTokens: number): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  const headerMatch = text.match(/^(\n## [^\n]+\n)/);
  const header = headerMatch ? headerMatch[1] : "";
  const body = header ? text.slice(header.length) : text;

  const parts = body.split(/(?=<!-- l4pri:\d -->)/).filter((b) => b.length > 0);
  if (parts.length === 0) {
    const entryBlocks = body.split(/(?=\n- \*\*)/).filter((b) => b.length > 0);
    let kept = [...entryBlocks];
    while (kept.length > 0) {
      const candidate = header + kept.join("");
      if (countTokens(candidate) <= targetTokens) return candidate;
      kept = kept.slice(0, kept.length - 1);
    }
    return header.trim() ? header : "";
  }

  const blocks = parts.map((block, index) => {
    const priMatch = block.match(/<!-- l4pri:(\d+) -->/);
    return {
      block,
      priority: priMatch ? Number(priMatch[1]) : L4_PRI_MENTIONED,
      index,
    };
  });

  const removed = new Set<number>();
  for (const item of [...blocks].sort(
    (a, b) => a.priority - b.priority || a.index - b.index,
  )) {
    const kept = blocks.filter((_, i) => !removed.has(i));
    const candidate = header + kept.map((b) => b.block).join("");
    if (countTokens(candidate) <= targetTokens) break;
    removed.add(item.index);
  }

  const kept = blocks.filter((_, i) => !removed.has(i));
  return header + kept.map((b) => b.block).join("");
}

/** L2: Story So Far のエントリを先頭から削除 */
function trimL2Text(text: string, targetTokens: number): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  // Format: "\n## これまでの物語\n\n" then "title\nsynopsis\n\ntitle\nsynopsis..."
  const headerMatch = text.match(/^(\n## [^\n]+\n\n)/);
  const header = headerMatch ? headerMatch[1] : "";
  const body = header ? text.slice(header.length) : text;

  // Split entries by double newline
  const entries = body.split(/\n\n/).filter((e) => e.trim().length > 0);

  // Remove from the front (oldest first)
  let kept = [...entries];
  while (kept.length > 0) {
    kept = kept.slice(1);
    if (kept.length === 0) return "";
    const candidate = header + kept.join("\n\n");
    if (countTokens(candidate) <= targetTokens) return candidate;
  }
  return "";
}

/** L3: シーン本文を先頭から切り詰め（ヘッダ保持、末尾保持） */
export function trimL3Text(
  text: string,
  targetTokens: number,
  markers: L3TrimMarkers = JA_L3_TRIM_MARKERS,
): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  const bodyHeaderMatch = text.match(markers.bodyHeaderRegex);
  if (!bodyHeaderMatch) return text;

  const sceneHeader = bodyHeaderMatch[1];
  const sceneBody = text.slice(sceneHeader.length);

  const headerTokens = countTokens(sceneHeader);
  if (headerTokens >= targetTokens) {
    // Can't fit even the header; return just the header
    return sceneHeader;
  }

  const bodyBudget = targetTokens - headerTokens;

  // Trim from the front of scene body, keeping the tail.
  // Array.from でコードポイント単位に分割する（split("") は UTF-16 コードユニット
  // 単位で astral 文字 = CJK 拡張B漢字・絵文字を境界でサロゲート分割し壊すため）。
  const words = Array.from(sceneBody);
  // Binary search for the cutoff point
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trimmed = words.slice(mid).join("");
    if (countTokens(trimmed) <= bodyBudget) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const trimmedBody = words.slice(lo).join("");
  return sceneHeader + trimmedBody;
}

/** L1: styleGuide → aiInstructions → genre/pov/tense の順で除去（タイトルは必ず保持） */
function trimL1Text(
  text: string,
  targetTokens: number,
  markers: L1TrimMarkers = JA_L1_TRIM_MARKERS,
): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  let current = text;
  for (const pattern of markers.removablePatterns) {
    current = current.replace(pattern, "");
    if (countTokens(current) <= targetTokens) return current;
  }
  return current;
}

/**
 * L5 (会話要約) の予算超過時トリム。古い要約ブロックから先頭削りし直近を残す。
 *
 * 段階的要約 (Progressive Summarization, G17) は上流 (chatApi / chatStore) が
 * 会話を要約して L5 を生成する。本関数はプロンプト組み上げ後に全体予算を超えた
 * 場合の最終手段トリムで、trimToFit の順序上 RAG の次・L4 より先に発動する。
 * 直近の要約ほど現在の執筆に有用なため、古い要約 (先頭) から落として末尾を残す。
 */
export function trimL5Text(text: string, targetTokens: number): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  // Format: "\n## これまでの会話の要約\n" then "summary1\n\nsummary2\n\n..."
  // (chatStore: summaries.map((s) => s.summary).join("\n\n"), 古い→新しい順)
  const headerMatch = text.match(/^(\n## [^\n]+\n)/);
  const header = headerMatch ? headerMatch[1] : "";
  const body = header ? text.slice(header.length) : text;

  const entries = body.split(/\n\n/).filter((e) => e.trim().length > 0);

  // Remove from the front (oldest summary first)
  let kept = [...entries];
  while (kept.length > 0) {
    kept = kept.slice(1);
    if (kept.length === 0) return "";
    const candidate = header + kept.join("\n\n");
    if (countTokens(candidate) <= targetTokens) return candidate;
  }
  return "";
}

/** semantic recall (RAG): 末尾 (低スコア側) の抜粋ブロックから丸ごと削る。
 * 抜粋が 1 つも残らない場合はヘッダだけ残しても無意味なので空にする。 */
function trimRagText(text: string, targetTokens: number): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  // 先頭ブロック = ヘッダ + intro、以降 = `### ` 始まりの各抜粋
  const blocks = text.split(/\n(?=### )/);
  let kept = blocks.slice(1);
  while (kept.length > 1) {
    kept = kept.slice(0, -1);
    const candidate = [blocks[0], ...kept].join("\n");
    if (countTokens(candidate) <= targetTokens) return candidate;
  }
  return "";
}

// ---------------------------------------------------------------------------
// trimToFit: budget超過時にRAG→L5→L4→L2→L3→L1の順でトリム
// ---------------------------------------------------------------------------

export function trimToFit(
  layers: TrimInput,
  budget: number,
  markers: { l1: L1TrimMarkers; l3: L3TrimMarkers } = {
    l1: JA_L1_TRIM_MARKERS,
    l3: JA_L3_TRIM_MARKERS,
  },
): TrimResult {
  const sumTokens = (t: TrimInput) =>
    countTokens(t.baseText) +
    countTokens(t.l1Text) +
    countTokens(t.l2Text) +
    countTokens(t.l3Text) +
    countTokens(t.l4Text) +
    countTokens(t.l5Text) +
    countTokens(t.l6Text) +
    countTokens(t.ragText ?? "");

  const total = sumTokens(layers);
  if (total <= budget) {
    return { trimmedTexts: layers, trimmedLayers: [], totalTokens: total };
  }

  const trimmedLayers: string[] = [];
  const texts = { ...layers };

  // Trim order: RAG → L5 → L4 → L2 → L3 → L1
  // RAG (semantic recall) は自動検索による投機的文脈なので、ユーザーが明示的に
  // 構成した既存レイヤーより先に犠牲にする。
  const trimOrder: Array<{
    key: keyof TrimInput;
    name: string;
    fn: (text: string, target: number) => string;
  }> = [
    { key: "ragText", name: "RAG", fn: trimRagText },
    { key: "l5Text", name: "L5", fn: trimL5Text },
    { key: "l4Text", name: "L4", fn: trimL4Text },
    { key: "l2Text", name: "L2", fn: trimL2Text },
    { key: "l3Text", name: "L3", fn: (t, n) => trimL3Text(t, n, markers.l3) },
    { key: "l1Text", name: "L1", fn: (t, n) => trimL1Text(t, n, markers.l1) },
  ];

  for (const { key, name, fn } of trimOrder) {
    const currentTotal = sumTokens(texts);
    if (currentTotal <= budget) break;

    const current = texts[key] ?? "";
    const excess = currentTotal - budget;
    const layerTokens = countTokens(current);
    const targetTokens = Math.max(0, layerTokens - excess);

    const trimmed = fn(current, targetTokens);
    if (trimmed !== current) {
      texts[key] = trimmed;
      trimmedLayers.push(name);
    }
  }

  return {
    trimmedTexts: texts,
    trimmedLayers,
    totalTokens: sumTokens(texts),
  };
}

export function buildSystemPrompt(
  input: BuildSystemPromptInput,
): SystemPromptResult {
  const s = getPromptCatalog(input.lang ?? "ja").chatSystem;
  // 伏線ブロックのラベルは catalog (lang 対応) だが、括弧/引用符/件 のタイポグラフィは
  // 従来ハードコード日本語だった。en では straight quote / 半角括弧 / 件なし にする
  // (ja は byte 不変 = 既存プロンプトキャッシュ温存)。
  const isEnLang = input.lang?.startsWith("en") ?? false;
  const fsQuote = (t: string) => (isEnLang ? `"${t}"` : `「${t}」`);
  const fsParen = (t: string) => (isEnLang ? `(${t})` : `（${t}）`);
  const fsCountSuffix = isEnLang ? "" : "件";
  const layers: LayerBreakdown[] = [];

  // Base instruction (L0)。Agent モード時は agentInstruction を付加。
  let baseText = input.agentMode
    ? `${s.baseText}\n\n${s.agentInstruction}`
    : s.baseText;
  // ユーザー定義のチャット追記指示 (口調・振る舞い・ペルソナ)。
  // bodyWriteDisabledInstruction と同様 L0 末尾に置くことで trim 免除され常に効く。
  // 空文字なら baseText は現行のまま (byte-identical / cache 非破壊)。
  // agentInstruction の後ろに置き、組み込みツール運用規約を上書きする印象を避ける。
  if (input.customChatInstruction?.trim()) {
    baseText += `\n\n${input.customChatInstruction.trim()}`;
  }
  // AiPolicy で本文書き込みが無効なプロジェクトでは、チャットからの本文代筆を
  // 抑止する指示を L0 に追加する (bodyWrite=ON のデフォルトでは何も足さない)。
  // L0 は trim 対象外なので、この hard constraint は常に残る。
  // ユーザー custom より後ろに置き、自由文で policy が弱まらない順序にする。
  if (input.project?.bodyWriteDisabled) {
    baseText += `\n\n${s.bodyWriteDisabledInstruction}`;
  }

  // L1: Project info
  let l1Text = "";
  if (input.project) {
    const p = input.project;
    const info: string[] = [`${s.labels.title}: ${p.title}`];
    if (p.genre) info.push(`${s.labels.genre}: ${p.genre}`);
    if (p.pov) info.push(`${s.labels.pov}: ${p.pov}`);
    if (p.tense) info.push(`${s.labels.tense}: ${p.tense}`);
    if (p.styleGuide) info.push(`${s.labels.styleGuide}:\n${p.styleGuide}`);
    if (p.aiInstructions)
      info.push(`${s.labels.aiInstructions}:\n${p.aiInstructions}`);
    l1Text = `${s.headers.projectInfo}\n${info.join("\n")}`;
  }

  // L2: Story so far (+ Phase 2: 未回収伏線、Phase 4: outline)
  // trimL2Text は \n\n でエントリ分割し先頭から削るため、保持優先度が高い
  // ものを末尾に配置する: storySoFar (古い順に削られる) → openForeshadows →
  // chapterOutlines → projectOutline。projectOutline は最後尾なので trim
  // 圧力に最も強い。
  let l2Text = input.storySoFar ? `\n${input.storySoFar}` : "";
  if (input.openForeshadows && input.openForeshadows.length > 0) {
    let openFs = input.openForeshadows;
    const formatOpenFs = (items: typeof openFs) => {
      const fsLines: string[] = [s.headers.openForeshadows];
      for (const fs of items) {
        const intentSuffix = fs.intent ? ` — ${fs.intent}` : "";
        const meta: string[] = [];
        if (fs.derivedLabel) meta.push(`label: ${fs.derivedLabel}`);
        if (fs.loadBearing === "critical")
          meta.push(s.labels.foreshadowCritical);
        else if (fs.loadBearing === "supporting")
          meta.push(s.labels.foreshadowSupporting);
        else if (fs.loadBearing === "optional")
          meta.push(s.labels.foreshadowOptional);
        if (fs.setupCount > 0)
          meta.push(
            `${s.labels.foreshadowSetup}: ${fs.setupCount}${fsCountSuffix}`,
          );
        const metaSuffix = meta.length > 0 ? fsParen(meta.join(", ")) : "";
        fsLines.push(`- ${fsQuote(fs.title)}${intentSuffix}${metaSuffix}`);
      }
      return fsLines.join("\n");
    };
    let fsBlock = formatOpenFs(openFs);
    const OPEN_FS_TOKEN_BUDGET = 1000;
    if (countTokens(fsBlock) > OPEN_FS_TOKEN_BUDGET) {
      openFs = openFs.filter((fs) => fs.loadBearing === "critical");
      fsBlock = formatOpenFs(openFs);
    }
    if (l2Text) {
      // storySoFar が存在する場合は \n\n 区切りで追記（trim 単位として独立）
      l2Text = `${l2Text}\n\n${fsBlock}`;
    } else {
      // storySoFar が空でも openForeshadows のみ表示する。L2 ヘッダをここでは
      // 付与しない（storySoFar 側が `## これまでの物語` を含むため）。代わりに
      // 物語全体セクションヘッダを fsBlock の前に付ける。
      l2Text = `\n${s.headers.storySoFar}${fsBlock}`;
    }
  }
  // Phase 4: Chapter outlines (祖先 folder の synopsis、outermost → innermost)。
  // 現在シーン直近の構造的役割を AI に伝える。openForeshadows の後に配置。
  if (input.chapterOutlines && input.chapterOutlines.length > 0) {
    const lines: string[] = [s.headers.chapterOutlines];
    for (const co of input.chapterOutlines) {
      lines.push(`- **${co.title}**: ${co.outline}`);
    }
    const block = lines.join("\n");
    l2Text = l2Text ? `${l2Text}\n\n${block}` : `\n${block}`;
  }
  // Phase 4: Project outline (著者手書きの全体意図)。L2 末尾に置くことで
  // trim 圧力に最も強くなり、最後まで AI から見える。
  if (input.projectOutline && input.projectOutline.trim().length > 0) {
    const block = `${s.headers.projectOutline}\n${input.projectOutline.trim()}`;
    l2Text = l2Text ? `${l2Text}\n\n${block}` : `\n${block}`;
  }

  // L3: Current scene (+ G11: preceding scene synopsis + G19: active tab content)
  let l3Text = "";
  if (input.previousScene) {
    l3Text += `${s.headers.previousScene}\n${s.labels.prevTitle}: ${input.previousScene.title}\n${s.labels.prevSummary}: ${input.previousScene.synopsis}`;
  }
  // Phase 2: ストーリー時系列の前シーン。reading-order の previousScene と
  // 異なる時のみ呼び出し側から渡される。ヘッダは別ブロックで明示する。
  if (input.storyTimePreviousScene) {
    const sts = input.storyTimePreviousScene;
    l3Text += `${s.headers.previousSceneStoryTime}\n${s.labels.prevTitle}: ${sts.title}`;
    if (sts.storyTimeLabel) {
      l3Text += `\n${s.labels.storyTimeLabel}: ${sts.storyTimeLabel}`;
    }
    l3Text += `\n${s.labels.prevSummary}: ${sts.synopsis}`;
  }
  // Phase 1: シーンラベルをタイトル行末尾に `[label1, label2]` として注入。
  // Codex エントリの phaseLabel と同じ視覚パターン。空配列なら何も付けない。
  const labelSuffix =
    input.sceneLabels && input.sceneLabels.length > 0
      ? ` [${input.sceneLabels.join(", ")}]`
      : "";
  // 現在シーンが実在するときのみ「## 現在のシーン」見出し + タイトル + 派生情報を注入。
  // codex/snippet スコープは scene={id:"",title:"",content:""} を渡すため、ここを
  // ガードしないと wrapDataLayer が非空白の見出し文字列を検出し、空の
  // <current_scene> ブロックを毎回出力してしまう。folder/project スコープの集約
  // 擬似シーンは非空の id+title を持つのでこのガードを通過し従来どおり保持される。
  const hasRealScene = Boolean(
    input.scene.id || input.scene.title.trim() || input.scene.content,
  );
  if (hasRealScene) {
    l3Text += `${s.headers.currentScene}\n${s.labels.title}: ${input.scene.title}${labelSuffix}`;
    if (input.scene.storyTimeLabel?.trim()) {
      l3Text += `\n${s.labels.storyTimeLabel}: ${input.scene.storyTimeLabel.trim()}`;
    }
    if (input.scene.synopsis) {
      l3Text += `\n${s.labels.synopsis}: ${input.scene.synopsis}`;
    }
  }
  // C-3: 「予定ビート」セクションを Synopsis 後・本文前に注入
  if (
    input.pendingBeatsSection &&
    input.pendingBeatsSection.trim().length > 0
  ) {
    l3Text += `\n${input.pendingBeatsSection.trim()}`;
  }
  // Phase 1: 当シーンの伏線（setup/payoff）を Pending Beats の後・本文前に注入。
  // L3 trim では `### シーン本文` ヘッダより前は保持されるため、本文が削られても
  // 伏線情報は残る。setup/payoff いずれも 0 件ならセクションごと省略。
  if (input.sceneForeshadow) {
    const fs = input.sceneForeshadow;
    if (fs.setups.length > 0 || fs.payoffs.length > 0) {
      const lines: string[] = [s.headers.sceneForeshadow];
      for (const setup of fs.setups) {
        const intentSuffix = setup.intent ? ` — ${setup.intent}` : "";
        const meta: string[] = [];
        if (setup.derivedLabel) meta.push(`label: ${setup.derivedLabel}`);
        if (setup.strength) meta.push(`strength: ${setup.strength}`);
        const metaSuffix = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
        lines.push(
          `- ${s.labels.foreshadowSetup}: ${fsQuote(setup.title)}${intentSuffix}${metaSuffix}`,
        );
        if (setup.excerpt?.trim()) {
          lines.push(`  excerpt: ${setup.excerpt.trim()}`);
        }
      }
      for (const payoff of fs.payoffs) {
        const intentSuffix = payoff.intent ? ` — ${payoff.intent}` : "";
        const setupSuffix = payoff.setupSceneTitle
          ? fsParen(
              `${s.labels.foreshadowSetup}: ${fsQuote(payoff.setupSceneTitle)}`,
            )
          : "";
        const meta: string[] = [];
        if (payoff.derivedLabel) meta.push(`label: ${payoff.derivedLabel}`);
        if (payoff.strength) meta.push(`strength: ${payoff.strength}`);
        const metaSuffix = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
        lines.push(
          `- ${s.labels.foreshadowPayoff}: ${fsQuote(payoff.title)}${intentSuffix}${setupSuffix}${metaSuffix}`,
        );
        if (payoff.excerpt?.trim()) {
          lines.push(`  excerpt: ${payoff.excerpt.trim()}`);
        }
      }
      l3Text += lines.join("\n");
    }
  }
  if (input.scene.content) {
    l3Text += `${s.headers.sceneBody}\n${sanitizeSceneContent(input.scene.content)}`;
  }
  // @scene メンションされたシーン本文を per-message pin として注入。
  // 現在シーンと同一 id は重複させないよう除外する (呼び出し側でも除外想定)。
  if (input.mentionedScenes && input.mentionedScenes.length > 0) {
    const blocks: string[] = [s.headers.mentionedScenes];
    for (const ms of input.mentionedScenes) {
      if (ms.id === input.scene.id) continue;
      const body = sanitizeSceneContent(ms.content ?? "");
      blocks.push(
        `${s.headers.mentionedSceneHeader}${ms.title}${s.headers.mentionedSceneBody}${body}`,
      );
    }
    // ヘッダ + 少なくとも 1 件のブロックが揃ったときのみ追記
    if (blocks.length > 1) {
      l3Text += blocks.join("\n\n");
    }
  }
  if (input.activeTabContent) {
    const typeLabel =
      input.activeTabContent.type === "codex" ? "Codex" : "Snippet";
    l3Text += `${s.headers.referencingContent}\n${s.labels.contentType}: ${typeLabel}\n${s.labels.contentTitle}: ${input.activeTabContent.title}\n${s.labels.contentBody}: ${input.activeTabContent.content}`;
  }

  // Codex エントリ 1 件分の本文行を組む共通ロジック。L4 (mentioned/pinned/always)
  // と <focus_subject> (codex スコープのアンカー = Spotlight 相当) の両方で使う。
  // includePinnedExtras=true で Spotlight 専用の追加情報 (タグ / カスタム詳細) も出す。
  const buildCodexEntryLines = (
    entry: CodexContext,
    includePinnedExtras: boolean,
  ): string[] => {
    const label = s.typeLabels[entry.type] ?? entry.type;
    // Phase Cb: relation-BFS で展開された相手 (relationVia 付き) は seed と異なり
    // フェーズ未解決の生 summary しか持たない。過去シーンに未来状態を漏らす
    // (時系列矛盾・ネタバレ) ため、展開ブロックは関係ラベルのみ注入し summary /
    // content 本体は出さない。相手の詳細が要るなら seed (言及/pin) にすれば
    // フェーズ解決された summary が通常経路で入る。
    const displaySummary = entry.relationVia
      ? ""
      : entry.summary.trim() || entry.contentFallback || "";
    const phaseSuffix = entry.phaseLabel ? ` [${entry.phaseLabel}]` : "";
    const out = [
      `- **${entry.name}**${phaseSuffix} (${label})`,
      `  ${s.labels.codexId}: ${entry.id}`,
    ];
    if (entry.relationVia) {
      out.push(`  ${s.labels.codexRelation}: ${entry.relationVia}`);
    }
    if (entry.aliases && entry.aliases.length > 0) {
      out.push(`  ${s.labels.codexAliases}: ${entry.aliases.join(", ")}`);
    }
    if (displaySummary) {
      out.push(`  ${s.labels.codexSummary}: ${displaySummary}`);
    }
    if (includePinnedExtras && entry.tags?.length) {
      out.push(`  ${s.labels.codexTags}: ${entry.tags.join(", ")}`);
    }
    if (includePinnedExtras && entry.customDetails?.length) {
      for (const detail of entry.customDetails) {
        out.push(`  - ${detail.fieldName}: ${detail.value}`);
      }
    }
    if (entry.fullContent) {
      out.push(`  ${s.labels.codexFullContent}:\n${entry.fullContent}`);
    }
    if (entry.childrenContext) {
      out.push(entry.childrenContext);
    }
    return out;
  };

  // L4: Codex entries
  // Build pinned entries with children injected (full content, budget ignored)
  const pinnedChildIds = new Set<string>();
  const pinnedWithChildren: CodexContext[] = [];
  for (const pinned of input.pinnedCodexEntries ?? []) {
    pinnedWithChildren.push(pinned);
    if (pinned.withChildren && pinned.children) {
      for (const child of pinned.children) {
        if (!pinnedChildIds.has(child.id)) {
          pinnedChildIds.add(child.id);
          pinnedWithChildren.push(child);
        }
      }
    }
  }

  const pinnedIds = new Set((input.pinnedCodexEntries ?? []).map((e) => e.id));
  const alwaysEntryIdSet = new Set(input.alwaysEntryIds ?? []);
  const allCodex = deduplicateById([
    ...(input.codexEntries ?? []).filter(
      (e) => !pinnedChildIds.has(e.id) && !pinnedIds.has(e.id),
    ),
    ...(input.relationCodexEntries ?? []),
    ...pinnedWithChildren,
  ]);
  let l4Text = "";
  const l4StableIds = new Set(input.sessionStableCodexIds ?? []);
  let l4StableSegment = "";
  const l4VolatileLines: string[] = [];
  const hasPinnedSnippets =
    input.pinnedSnippets && input.pinnedSnippets.length > 0;
  const hasPinnedStickies =
    input.pinnedStickies && input.pinnedStickies.length > 0;
  const hasNotes = input.noteEntries && input.noteEntries.length > 0;
  const hasMapBoard = Boolean(input.mapBoardMarkdown?.trim());
  if (
    allCodex.length > 0 ||
    hasPinnedSnippets ||
    hasPinnedStickies ||
    hasNotes ||
    hasMapBoard
  ) {
    const lines = [s.headers.codexSection];
    const stableLines = [s.headers.codexSection];
    for (const entry of allCodex) {
      const priority = computeL4Priority({
        isChild: pinnedChildIds.has(entry.id),
        isAlways: alwaysEntryIdSet.has(entry.id),
        isPinned: pinnedIds.has(entry.id),
        hasRelationVia: Boolean(entry.relationVia),
      });
      // relationVia は HTML コメントでなく通常行として可視注入する
      // (コメントを無視する LLM でも traversal 方向が届くように)。
      const blockLines = [
        `<!-- l4pri:${priority} -->`,
        ...buildCodexEntryLines(entry, pinnedIds.has(entry.id)),
      ];
      const blockText = blockLines.join("\n");
      lines.push(blockText);
      const isStable = l4StableIds.size === 0 || l4StableIds.has(entry.id);
      if (isStable) {
        stableLines.push(blockText);
      } else {
        l4VolatileLines.push(blockText);
      }
    }
    const alwaysNoteIdSet = new Set(input.alwaysNoteIds ?? []);
    for (const note of input.noteEntries ?? []) {
      const priority = alwaysNoteIdSet.has(note.id)
        ? L4_PRI_ALWAYS
        : L4_PRI_MENTIONED;
      const blockLines = [
        `<!-- l4pri:${priority} -->`,
        `<note>`,
        `- **${note.title}** (Note)`,
        `  ${s.labels.codexId}: ${note.id}`,
      ];
      if (note.aliases && note.aliases.length > 0) {
        blockLines.push(
          `  ${s.labels.codexAliases}: ${note.aliases.join(", ")}`,
        );
      }
      const trimmedContent = note.content.trim();
      if (trimmedContent) {
        blockLines.push(
          `  ${s.labels.contentBody}: ${truncateForL4(trimmedContent, NOTE_CONTENT_MAX_CHARS)}`,
        );
      }
      blockLines.push(`</note>`);
      const blockText = blockLines.join("\n");
      lines.push(blockText);
      if (l4StableIds.size === 0 || l4StableIds.has(note.id)) {
        stableLines.push(blockText);
      } else {
        l4VolatileLines.push(blockText);
      }
    }
    for (const snippet of input.pinnedSnippets ?? []) {
      const snippetBlock = `<!-- l4pri:${L4_PRI_PINNED} -->\n- **${snippet.title}** (Snippet): ${snippet.content}`;
      lines.push(snippetBlock);
      if (l4StableIds.size === 0 || l4StableIds.has(snippet.id)) {
        stableLines.push(snippetBlock);
      } else {
        l4VolatileLines.push(snippetBlock);
      }
    }
    for (const sticky of input.pinnedStickies ?? []) {
      const title = sticky.title?.trim() || "Sticky";
      const blockLines = [
        `<!-- l4pri:${L4_PRI_PINNED} -->`,
        `<sticky>`,
        `- **${title}** (Sticky)`,
        `  ${s.labels.codexId}: ${sticky.id}`,
        `  ${s.labels.contentBody}: ${sticky.content.trim()}`,
        `</sticky>`,
      ];
      const stickyBlock = blockLines.join("\n");
      lines.push(stickyBlock);
      if (l4StableIds.size === 0 || l4StableIds.has(sticky.id)) {
        stableLines.push(stickyBlock);
      } else {
        l4VolatileLines.push(stickyBlock);
      }
    }
    // Map overlay: board 全体を 1 ブロックとして L4 に注入（pri = PINNED）
    if (hasMapBoard) {
      const mapBlock = `<!-- l4pri:${L4_PRI_PINNED} -->\n${input.mapBoardMarkdown!.trim()}`;
      lines.push(mapBlock);
      stableLines.push(mapBlock);
    }
    l4Text = lines.join("\n");
    // stable segment は trimL4Text を通らないため、この時点で marker を strip して
    // cacheSegments (= LLM に届く content blocks) に marker が漏れないようにする。
    l4StableSegment = stripL4Markers(stableLines.join("\n"));
  }

  // semantic recall (Layer4 RAG): 意味検索による過去シーン抜粋。クエリ
  // (直近ユーザー発話 + 現在シーン本文末尾) 依存で毎ターン変わるため、
  // cacheSegments (byte 安定領域) には絶対に入れない。prompt (cache 非対応
  // プロバイダの fallback 用) と volatileTail (cache 対応プロバイダ用) の
  // 両方に配置することで全プロバイダに届ける。
  let ragText = "";
  if (input.semanticRecall && input.semanticRecall.length > 0) {
    const ragLines: string[] = [
      s.headers.semanticRecall,
      s.semanticRecallIntro,
    ];
    for (const chunk of input.semanticRecall) {
      ragLines.push(`${s.headers.semanticRecallScene}${chunk.sceneTitle}`);
      ragLines.push(chunk.chunkText);
    }
    ragText = ragLines.join("\n");
  }

  // L5: G17 会話要約（Progressive Summarization）
  const l5Text = input.conversationSummary
    ? `${s.headers.conversationSummary}\n${input.conversationSummary}`
    : "";

  // L6: Command instruction（一回限りのコマンド注入）
  const l6Text = input.commandInstruction
    ? `${s.headers.commandInstruction}\n${input.commandInstruction}`
    : "";

  // <focus_subject>: Codex/Snippet スコープのアンカー (= この会話の主題)。
  // L3 スロットの直後・L4 の前に置き、フル本文を持たせて主題を強く明示する。
  // L4 側からは当該アンカーを除外済みの前提 (呼び出し側責務) なので重複しない。
  // trim 対象外で常に注入されるため、予算は hardeningOverhead 側で予約する。
  let focusText = "";
  if (input.focusSubject) {
    const fs = input.focusSubject;
    if (fs.kind === "codex") {
      // Spotlight (pinned) 相当: 同じ codex エントリ描画 (タグ/カスタム詳細/全文/子) を
      // includePinnedExtras=true で出す。種別は名前行の `(キャラクター)` 等で伝わる。
      focusText = [
        s.headers.focusSubject,
        s.focusSubjectIntro,
        ...buildCodexEntryLines(fs.entry, true),
      ].join("\n");
    } else if (fs.name.trim() || fs.body.trim()) {
      const focusLines = [
        s.headers.focusSubject,
        s.focusSubjectIntro,
        `${s.labels.contentType}: Snippet`,
        `${s.labels.contentTitle}: ${fs.name}`,
      ];
      if (fs.body.trim()) {
        focusLines.push(`${s.labels.contentBody}:\n${fs.body.trim()}`);
      }
      focusText = focusLines.join("\n");
    }
  }

  // Apply excludeLayers: set specified layers to empty string
  let effectiveL1 = l1Text;
  let effectiveL2 = l2Text;
  let effectiveL3 = l3Text;
  let effectiveL4 = l4Text;
  let effectiveL5 = l5Text;
  let effectiveL6 = l6Text;
  let effectiveRag = ragText;
  const exclude = input.excludeLayers ?? [];
  if (exclude.includes("L1")) effectiveL1 = "";
  if (exclude.includes("L2")) effectiveL2 = "";
  if (exclude.includes("L3")) effectiveL3 = "";
  if (exclude.includes("L4")) {
    effectiveL4 = "";
    // stable segment は trim 前に構築済みのため、ここで空にしないと
    // cacheSegments (l4StableSegment || effectiveL4) 経由で L4 が残ってしまう
    l4StableSegment = "";
  }
  if (exclude.includes("L5")) effectiveL5 = "";
  if (exclude.includes("L6")) effectiveL6 = "";
  if (exclude.includes("RAG")) effectiveRag = "";

  let trimmedLayers: string[] | undefined;

  // Apply trimToFit if contextWindow and conversationTokens are both provided
  if (
    input.contextWindow !== undefined &&
    input.conversationTokens !== undefined
  ) {
    const responseReservation = computeResponseReservation(
      input.contextWindow,
      input.maxOutputTokens,
    );
    // タグラッパーと境界リマインダーは trim 後に付加されるため、その分を
    // 予算から先に差し引く。定数文字列なので countTokens はキャッシュヒットする。
    // 空レイヤーはラッパーを出さないので非空レイヤーぶんだけ予約する。
    // RAG は trim で最初に丸ごと消える投機的レイヤーなので予約しない
    // (生き残るのは予算に余裕がある時だけで、超過 ~10 tok は
    // responseReservation の余裕内に収まる)。
    const wrapperOverhead = (tag: string) =>
      countTokens(`\n<${tag}>\n\n</${tag}>`);
    let hardeningOverhead = countTokens(s.dataBoundaryReminder) + 1;
    if (effectiveL1.trim())
      hardeningOverhead += wrapperOverhead(PROMPT_DATA_TAGS.l1);
    if (effectiveL2.trim())
      hardeningOverhead += wrapperOverhead(PROMPT_DATA_TAGS.l2);
    if (effectiveL3.trim())
      hardeningOverhead += wrapperOverhead(PROMPT_DATA_TAGS.l3);
    // focus は trimToFit に渡さず常に注入するため、ラッパー + 本文ぶんを丸ごと
    // 予算から先取りして他レイヤーの trim 余地を確保する。
    if (focusText.trim())
      hardeningOverhead +=
        wrapperOverhead(PROMPT_DATA_TAGS.focus) + countTokens(focusText);
    if (effectiveL4.trim()) {
      hardeningOverhead += wrapperOverhead(PROMPT_DATA_TAGS.l4);
      // stable/volatile 分割時は codex_entries ブロックが 2 つになる
      if (l4VolatileLines.length > 0)
        hardeningOverhead += wrapperOverhead(PROMPT_DATA_TAGS.l4);
    }
    if (effectiveL5.trim())
      hardeningOverhead += wrapperOverhead(PROMPT_DATA_TAGS.l5);
    const budget =
      input.contextWindow -
      responseReservation -
      input.conversationTokens -
      hardeningOverhead;
    const trimInput: TrimInput = {
      baseText,
      l1Text: effectiveL1,
      l2Text: effectiveL2,
      l3Text: effectiveL3,
      l4Text: effectiveL4,
      l5Text: effectiveL5,
      l6Text: effectiveL6,
      ragText: effectiveRag,
    };
    // 言語別 trim マーカーを渡す: en では L1/L3 のヘッダが英語になるため、
    // ja 既定の regex では一致せず trim が効かない (s = lang の chatSystem)。
    const result = trimToFit(trimInput, budget, s.trimMarkers);
    effectiveL1 = result.trimmedTexts.l1Text;
    effectiveL2 = result.trimmedTexts.l2Text;
    effectiveL3 = result.trimmedTexts.l3Text;
    effectiveL4 = result.trimmedTexts.l4Text;
    effectiveL5 = result.trimmedTexts.l5Text;
    effectiveL6 = result.trimmedTexts.l6Text;
    effectiveRag = result.trimmedTexts.ragText ?? "";
    if (result.trimmedLayers.length > 0) {
      trimmedLayers = result.trimmedLayers;
    }
  }

  // 非 stable な L4 ブロック (セッション途中で言及された codex 等) のうち trim を
  // 生き残ったものを volatileTail 用に抽出する。stable segment は byte 安定性の
  // ため意図的に trim を通さないが、揮発側は予算を尊重して trim 後を正とする。
  let l4VolatileSegment = "";
  if (l4StableSegment && l4VolatileLines.length > 0) {
    const presentBlocks = new Set(
      effectiveL4.split(/(?=<!-- l4pri:\d+ -->)/).map((b) => b.trimEnd()),
    );
    const keptVolatile = l4VolatileLines.filter((b) =>
      presentBlocks.has(b.trimEnd()),
    );
    if (keptVolatile.length > 0) {
      l4VolatileSegment = stripL4Markers(keptVolatile.join("\n"));
    }
  }

  // trim 後 (or trim をスキップした場合の素の l4Text) から marker を strip。
  // ここで落とすことで l4Tokens / prompt / cacheSegments 全てが marker レスになる。
  effectiveL4 = stripL4Markers(effectiveL4);

  // インジェクション対策: trim と stable/volatile 抽出 (どちらも生文字列の照合・
  // regex に依存) が終わったこの時点で、各データレイヤーを予約タグで包み、
  // データ内の予約タグ偽装をエスケープする。以降のトークン計算・prompt・
  // cacheSegments・volatileTail はすべてタグ込みの実送信値になる。
  // L4 は stable/volatile が別位置に配置されるため、それぞれ完結したブロックとして包む。
  effectiveL1 = wrapDataLayer(effectiveL1, PROMPT_DATA_TAGS.l1);
  effectiveL2 = wrapDataLayer(effectiveL2, PROMPT_DATA_TAGS.l2);
  effectiveL3 = wrapDataLayer(effectiveL3, PROMPT_DATA_TAGS.l3);
  const effectiveFocus = wrapDataLayer(focusText, PROMPT_DATA_TAGS.focus);
  effectiveL4 = wrapDataLayer(effectiveL4, PROMPT_DATA_TAGS.l4);
  l4StableSegment = wrapDataLayer(l4StableSegment, PROMPT_DATA_TAGS.l4);
  l4VolatileSegment = wrapDataLayer(l4VolatileSegment, PROMPT_DATA_TAGS.l4);
  effectiveRag = wrapDataLayer(effectiveRag, PROMPT_DATA_TAGS.rag);
  effectiveL5 = wrapDataLayer(effectiveL5, PROMPT_DATA_TAGS.l5);

  // サンドイッチ: 全データレイヤーの直後・L6 (正当な指示) の前に境界リマインダー
  // を置く。データレイヤーが 1 つも無ければ付けない。l4StableSegment は trim を
  // 通らないため、effectiveL4 が trim で空になっても cache 経路にデータが残る
  // ケースを拾う。
  const hasDataLayers = [
    effectiveL1,
    effectiveL2,
    effectiveL3,
    effectiveFocus,
    effectiveL4,
    l4StableSegment,
    effectiveRag,
    effectiveL5,
  ].some((seg) => seg.trim().length > 0);
  const reminderText = hasDataLayers ? s.dataBoundaryReminder : "";

  // 各 layer のトークン数を 1 度だけ計算 (cache hit でも text 全長 hash コストを避ける)
  const baseTokens = countTokens(baseText);
  const l1Tokens = countTokens(effectiveL1);
  const l2Tokens = countTokens(effectiveL2);
  const l3Tokens = countTokens(effectiveL3);
  const focusTokens = effectiveFocus ? countTokens(effectiveFocus) : 0;
  const l4Tokens = countTokens(effectiveL4);
  const ragTokens = effectiveRag ? countTokens(effectiveRag) : 0;
  const l5Tokens = effectiveL5 ? countTokens(effectiveL5) : 0;
  const l6Tokens = effectiveL6 ? countTokens(effectiveL6) : 0;

  layers.push({
    layer: "L1",
    label: i18next.t("chat.context.layer.L1"),
    used: l1Tokens,
  });
  layers.push({
    layer: "L2",
    label: i18next.t("chat.context.layer.L2"),
    used: l2Tokens,
  });
  layers.push({
    layer: "L3",
    label: i18next.t("chat.context.layer.L3"),
    used: l3Tokens,
  });
  if (effectiveFocus) {
    layers.push({
      layer: "FOCUS",
      label: i18next.t("chat.context.layer.FOCUS"),
      used: focusTokens,
    });
  }
  layers.push({
    layer: "L4",
    label: i18next.t("chat.context.layer.L4"),
    used: l4Tokens,
  });
  if (effectiveRag) {
    layers.push({
      layer: "RAG",
      label: i18next.t("chat.context.layer.RAG"),
      used: ragTokens,
    });
  }
  if (effectiveL5) {
    layers.push({
      layer: "L5",
      label: i18next.t("chat.context.layer.L5"),
      used: l5Tokens,
    });
  }
  if (effectiveL6) {
    layers.push({
      layer: "L6",
      label: i18next.t("chat.context.layer.L6"),
      used: l6Tokens,
    });
  }

  const prompt = [
    baseText,
    effectiveL1,
    effectiveL2,
    effectiveL3,
    effectiveFocus,
    effectiveL4,
    effectiveRag,
    effectiveL5,
    ...(reminderText ? [reminderText] : []),
    effectiveL6,
  ].join("\n");

  // focus は L3 と同じ stable 領域。Rust 側は cache_control を 4 breakpoint まで
  // しか張れない (ai.rs build_system_payload) ため、別セグメントにせず L3 スロットへ
  // 統合する。実運用では effectiveL3 (scene スコープ) と effectiveFocus
  // (codex/snippet スコープ) は排他だが、両在しても 1 セグメントに収めて上限を守る。
  const l3CacheSegment = [effectiveL3, effectiveFocus]
    .filter((seg) => seg.trim().length > 0)
    .join("\n");
  const cacheSegments = [
    `${baseText}${effectiveL1}`,
    effectiveL2,
    l3CacheSegment,
    l4StableSegment || effectiveL4,
  ].filter((seg) => seg.trim().length > 0);

  // cacheSegments を使うプロバイダ向けの揮発層。cacheSegments の直後に
  // cache_control 無しブロックとして送られる (4 breakpoint 制限を消費しない)。
  // semantic recall (RAG) はクエリ依存で毎ターン変わるため必ずこちら側。
  const volatileTail = [
    l4VolatileSegment,
    effectiveRag,
    effectiveL5,
    reminderText,
    effectiveL6,
  ]
    .filter((seg) => seg.trim().length > 0)
    .join("\n");

  // 結合後の全文を再 tokenize しない: 各 layer 合計 + join した \n 分 (BPE で各 1 token)。
  // リマインダーが入ると join 要素が 1 つ増えるため \n も 1 個分加算する。
  const reminderTokens = reminderText ? countTokens(reminderText) : 0;
  const totalTokens =
    baseTokens +
    l1Tokens +
    l2Tokens +
    l3Tokens +
    focusTokens +
    l4Tokens +
    ragTokens +
    l5Tokens +
    l6Tokens +
    reminderTokens +
    // prompt 配列に effectiveFocus を 1 要素追加したぶん join の \n が 1 個増える。
    (reminderText ? 9 : 8);

  return {
    prompt,
    totalTokens,
    layers,
    ...(trimmedLayers ? { trimmedLayers } : {}),
    cacheSegments,
    ...(volatileTail ? { volatileTail } : {}),
  };
}

// CJK 全角記号・かな・統合漢字・互換漢字・Ext B 以降 (astral 面)。
// heuristic 専用: o200k で CJK はほぼ 1 文字 ≒ 1 トークンになるため、
// length/2 では日本語本文のトークン数を半分に過小評価し予算超過を招く。
const CJK_CHAR_RE =
  /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2ffff}]/gu;

export function countTokens(text: string): number {
  if (!text) return 0;
  const cached = _tokenCache.get(text);
  if (cached !== undefined) return cached;
  let result: number;
  if (encoder) {
    result = encoder.encode(text).length;
  } else {
    // ensureTokenizer() 未 await のフォールバック。Trim 計算が破綻しない程度の
    // 概算 (CJK ≒ 1 トークン/文字、それ以外 ≒ 1 トークン/3 文字)。過大評価側に
    // 倒し、heuristic 経路でコンテキスト窓を溢れさせない。
    if (!_heuristicWarned) {
      _heuristicWarned = true;
      console.warn(
        "[contextBuilder] countTokens called before ensureTokenizer(); using heuristic.",
      );
    }
    const cjkCount = text.match(CJK_CHAR_RE)?.length ?? 0;
    result = Math.ceil(cjkCount + (text.length - cjkCount) / 3);
  }
  if (_tokenCache.size >= _TOKEN_CACHE_MAX) {
    _tokenCache.delete(_tokenCache.keys().next().value!);
  }
  _tokenCache.set(text, result);
  return result;
}

export function buildStorySoFar(
  currentSceneId: string,
  allNodes: TreeNodeData[],
  tokenBudget: number,
  lang?: string,
): string {
  // Find the current scene's sortOrder
  const currentScene = allNodes.find((n) => n.id === currentSceneId);
  if (!currentScene) return "";

  // Find all scenes that come before the current scene in sortOrder
  const precedingScenes = allNodes
    .filter(
      (n) =>
        n.nodeType === "scene" &&
        n.id !== currentSceneId &&
        cmpKeys(n.sortOrder, currentScene.sortOrder) < 0 &&
        n.synopsis != null &&
        n.synopsis.trim() !== "",
    )
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  if (precedingScenes.length === 0) return "";

  // Build entries (oldest first)
  const entries = precedingScenes.map((scene) => ({
    title: scene.title,
    synopsis: scene.synopsis as string,
  }));

  const s = getPromptCatalog(lang ?? "ja").chatSystem;
  // Trim oldest scenes first if token budget exceeded
  const header = s.headers.storySoFar;
  let kept = [...entries];
  while (kept.length > 0) {
    const body = kept.map((e) => `${e.title}\n${e.synopsis}`).join("\n\n");
    const full = header + body;
    if (countTokens(full) <= tokenBudget) {
      return full;
    }
    // Remove the oldest entry
    kept = kept.slice(1);
  }

  return "";
}
