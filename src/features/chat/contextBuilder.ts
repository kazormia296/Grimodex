import type { Tiktoken } from "tiktoken/lite/init";
import i18next from "@/lib/i18n";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  formatTimelineContext,
  type ResolvedCodexState,
} from "@/features/codex/phaseResolver";
import type { L1TrimMarkers, L3TrimMarkers } from "@/prompts/shared/types";
import {
  JA_L1_TRIM_MARKERS,
  JA_L3_TRIM_MARKERS,
  JA_TYPE_LABELS,
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
}

export interface ProjectContext {
  title: string;
  genre?: string | null;
  pov?: string | null;
  tense?: string | null;
  styleGuide?: string | null;
  aiInstructions?: string | null;
  language?: string;
  /** Phase 4: 著者手書きの outline。fetch ヘルパーが project から拾い、
   * `BuildSystemPromptInput.projectOutline` に渡されることを想定する。
   * L1 (project info) には載らない (L2 narrative 層の扱い)。 */
  outline?: string | null;
}

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

export interface TrimInput {
  baseText: string;
  l1Text: string;
  l2Text: string;
  l3Text: string;
  l4Text: string;
  l5Text: string;
  l6Text: string;
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
  /** G19: アクティブタブのコンテンツ (L3に注入) */
  activeTabContent?: {
    type: "codex" | "snippet";
    title: string;
    content: string; // plain text
  };
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
    setups: Array<{ title: string; intent: string | null }>;
    payoffs: Array<{
      title: string;
      intent: string | null;
      /** 仕込みが置かれた代表シーンのタイトル（複数ある場合は最初の 1 件）。
       * 仕込み未配置の payoff（設計のみ）の場合は null。 */
      setupSceneTitle: string | null;
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
  /** Codex entry IDs fixed at session start — L4 cache marker boundary. */
  sessionStableCodexIds?: string[];
  /** context_mode=always entries (L4 trim: lowest removal priority). */
  alwaysEntryIds?: string[];
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
  /** Anthropic cache_control segments (L1–L4 boundaries). */
  cacheSegments?: string[];
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
export { JA_TYPE_LABELS };

// ---------------------------------------------------------------------------
// Layer trim helpers
// ---------------------------------------------------------------------------

/** L4 trim priority: lower = removed first (children → mentioned → pinned → always). */
const L4_PRI_CHILD = 0;
const L4_PRI_MENTIONED = 1;
const L4_PRI_PINNED = 2;
const L4_PRI_ALWAYS = 3;

/** L4: remove lowest-priority entry blocks first. */
function trimL4Text(text: string, targetTokens: number): string {
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
function trimL3Text(
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

  // Trim from the front of scene body, keeping the tail
  const words = sceneBody.split("");
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

/** L5: 将来用 Progressive Summarization。現在は全削除のみ */
function trimL5Text(_text: string, _targetTokens: number): string {
  return "";
}

// ---------------------------------------------------------------------------
// trimToFit: budget超過時にL5→L4→L2→L3→L1の順でトリム
// ---------------------------------------------------------------------------

export function trimToFit(layers: TrimInput, budget: number): TrimResult {
  const sumTokens = (t: TrimInput) =>
    countTokens(t.baseText) +
    countTokens(t.l1Text) +
    countTokens(t.l2Text) +
    countTokens(t.l3Text) +
    countTokens(t.l4Text) +
    countTokens(t.l5Text) +
    countTokens(t.l6Text);

  const total = sumTokens(layers);
  if (total <= budget) {
    return { trimmedTexts: layers, trimmedLayers: [], totalTokens: total };
  }

  const trimmedLayers: string[] = [];
  const texts = { ...layers };

  // Trim order: L5 → L4 → L2 → L3 → L1
  const trimOrder: Array<{
    key: keyof TrimInput;
    name: string;
    fn: (text: string, target: number) => string;
  }> = [
    { key: "l5Text", name: "L5", fn: trimL5Text },
    { key: "l4Text", name: "L4", fn: trimL4Text },
    { key: "l2Text", name: "L2", fn: trimL2Text },
    { key: "l3Text", name: "L3", fn: trimL3Text },
    { key: "l1Text", name: "L1", fn: trimL1Text },
  ];

  for (const { key, name, fn } of trimOrder) {
    const currentTotal = sumTokens(texts);
    if (currentTotal <= budget) break;

    const excess = currentTotal - budget;
    const layerTokens = countTokens(texts[key]);
    const targetTokens = Math.max(0, layerTokens - excess);

    const trimmed = fn(texts[key], targetTokens);
    if (trimmed !== texts[key]) {
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
  const layers: LayerBreakdown[] = [];

  // Base instruction (L0)。Agent モード時は agentInstruction を付加。
  const baseText = input.agentMode
    ? `${s.baseText}\n\n${s.agentInstruction}`
    : s.baseText;

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
    const fsLines: string[] = [s.headers.openForeshadows];
    for (const fs of input.openForeshadows) {
      const intentSuffix = fs.intent ? ` — ${fs.intent}` : "";
      const meta: string[] = [];
      if (fs.loadBearing === "critical") meta.push(s.labels.foreshadowCritical);
      else if (fs.loadBearing === "supporting")
        meta.push(s.labels.foreshadowSupporting);
      else if (fs.loadBearing === "optional")
        meta.push(s.labels.foreshadowOptional);
      if (fs.setupCount > 0)
        meta.push(`${s.labels.foreshadowSetup}: ${fs.setupCount}件`);
      const metaSuffix = meta.length > 0 ? `（${meta.join(", ")}）` : "";
      fsLines.push(`- 「${fs.title}」${intentSuffix}${metaSuffix}`);
    }
    const fsBlock = fsLines.join("\n");
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
  l3Text += `${s.headers.currentScene}\n${s.labels.title}: ${input.scene.title}${labelSuffix}`;
  if (input.scene.synopsis) {
    l3Text += `\n${s.labels.synopsis}: ${input.scene.synopsis}`;
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
        lines.push(
          `- ${s.labels.foreshadowSetup}: 「${setup.title}」${intentSuffix}`,
        );
      }
      for (const payoff of fs.payoffs) {
        const intentSuffix = payoff.intent ? ` — ${payoff.intent}` : "";
        const setupSuffix = payoff.setupSceneTitle
          ? `（${s.labels.foreshadowSetup}: 「${payoff.setupSceneTitle}」）`
          : "";
        lines.push(
          `- ${s.labels.foreshadowPayoff}: 「${payoff.title}」${intentSuffix}${setupSuffix}`,
        );
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
    ...pinnedWithChildren,
  ]);
  let l4Text = "";
  const l4StableIds = new Set(input.sessionStableCodexIds ?? []);
  let l4StableSegment = "";
  const hasPinnedSnippets =
    input.pinnedSnippets && input.pinnedSnippets.length > 0;
  if (allCodex.length > 0 || hasPinnedSnippets) {
    const lines = [s.headers.codexSection];
    const stableLines = [s.headers.codexSection];
    for (const entry of allCodex) {
      const label = s.typeLabels[entry.type] ?? entry.type;
      const displaySummary =
        entry.summary.trim() || entry.contentFallback || "";
      const phaseSuffix = entry.phaseLabel ? ` [${entry.phaseLabel}]` : "";
      // L4_PRI_MENTIONED が既定値。いずれの条件にも一致しなければ初期値のまま。
      let priority = L4_PRI_MENTIONED;
      if (pinnedChildIds.has(entry.id)) {
        priority = L4_PRI_CHILD;
      } else if (alwaysEntryIdSet.has(entry.id)) {
        priority = L4_PRI_ALWAYS;
      } else if (pinnedIds.has(entry.id)) {
        priority = L4_PRI_PINNED;
      }
      const blockLines = [
        `<!-- l4pri:${priority} -->`,
        `- **${entry.name}**${phaseSuffix} (${label})`,
        `  ${s.labels.codexId}: ${entry.id}`,
      ];
      if (entry.aliases && entry.aliases.length > 0) {
        blockLines.push(
          `  ${s.labels.codexAliases}: ${entry.aliases.join(", ")}`,
        );
      }
      if (displaySummary) {
        blockLines.push(`  ${s.labels.codexSummary}: ${displaySummary}`);
      }
      if (pinnedIds.has(entry.id) && entry.tags?.length) {
        blockLines.push(`  ${s.labels.codexTags}: ${entry.tags.join(", ")}`);
      }
      if (pinnedIds.has(entry.id) && entry.customDetails?.length) {
        for (const detail of entry.customDetails) {
          blockLines.push(`  - ${detail.fieldName}: ${detail.value}`);
        }
      }
      if (entry.fullContent) {
        blockLines.push(
          `  ${s.labels.codexFullContent}:\n${entry.fullContent}`,
        );
      }
      if (entry.childrenContext) {
        blockLines.push(entry.childrenContext);
      }
      const blockText = blockLines.join("\n");
      lines.push(blockText);
      const isStable = l4StableIds.size === 0 || l4StableIds.has(entry.id);
      if (isStable) {
        stableLines.push(blockText);
      }
    }
    for (const snippet of input.pinnedSnippets ?? []) {
      const snippetBlock = `- **${snippet.title}** (Snippet): ${snippet.content}`;
      lines.push(snippetBlock);
      if (l4StableIds.size === 0 || l4StableIds.has(snippet.id)) {
        stableLines.push(snippetBlock);
      }
    }
    l4Text = lines.join("\n");
    l4StableSegment = stableLines.join("\n");
  }

  // L5: G17 会話要約（Progressive Summarization）
  const l5Text = input.conversationSummary
    ? `${s.headers.conversationSummary}\n${input.conversationSummary}`
    : "";

  // L6: Command instruction（一回限りのコマンド注入）
  const l6Text = input.commandInstruction
    ? `${s.headers.commandInstruction}\n${input.commandInstruction}`
    : "";

  // Apply excludeLayers: set specified layers to empty string
  let effectiveL1 = l1Text;
  let effectiveL2 = l2Text;
  let effectiveL3 = l3Text;
  let effectiveL4 = l4Text;
  let effectiveL5 = l5Text;
  let effectiveL6 = l6Text;
  const exclude = input.excludeLayers ?? [];
  if (exclude.includes("L1")) effectiveL1 = "";
  if (exclude.includes("L2")) effectiveL2 = "";
  if (exclude.includes("L3")) effectiveL3 = "";
  if (exclude.includes("L4")) effectiveL4 = "";
  if (exclude.includes("L5")) effectiveL5 = "";
  if (exclude.includes("L6")) effectiveL6 = "";

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
    const budget =
      input.contextWindow - responseReservation - input.conversationTokens;
    const trimInput: TrimInput = {
      baseText,
      l1Text: effectiveL1,
      l2Text: effectiveL2,
      l3Text: effectiveL3,
      l4Text: effectiveL4,
      l5Text: effectiveL5,
      l6Text: effectiveL6,
    };
    const result = trimToFit(trimInput, budget);
    effectiveL1 = result.trimmedTexts.l1Text;
    effectiveL2 = result.trimmedTexts.l2Text;
    effectiveL3 = result.trimmedTexts.l3Text;
    effectiveL4 = result.trimmedTexts.l4Text;
    effectiveL5 = result.trimmedTexts.l5Text;
    effectiveL6 = result.trimmedTexts.l6Text;
    if (result.trimmedLayers.length > 0) {
      trimmedLayers = result.trimmedLayers;
    }
  }

  // 各 layer のトークン数を 1 度だけ計算 (cache hit でも text 全長 hash コストを避ける)
  const baseTokens = countTokens(baseText);
  const l1Tokens = countTokens(effectiveL1);
  const l2Tokens = countTokens(effectiveL2);
  const l3Tokens = countTokens(effectiveL3);
  const l4Tokens = countTokens(effectiveL4);
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
  layers.push({
    layer: "L4",
    label: i18next.t("chat.context.layer.L4"),
    used: l4Tokens,
  });
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
    effectiveL4,
    effectiveL5,
    effectiveL6,
  ].join("\n");

  const cacheSegments = [
    `${baseText}${effectiveL1}`,
    effectiveL2,
    effectiveL3,
    l4StableSegment || effectiveL4,
  ].filter((seg) => seg.trim().length > 0);

  // 結合後の全文を再 tokenize しない: 各 layer 合計 + join した \n 6 個分 (BPE で各 1 token)
  const totalTokens =
    baseTokens +
    l1Tokens +
    l2Tokens +
    l3Tokens +
    l4Tokens +
    l5Tokens +
    l6Tokens +
    6;

  return {
    prompt,
    totalTokens,
    layers,
    ...(trimmedLayers ? { trimmedLayers } : {}),
    cacheSegments,
  };
}

export function countTokens(text: string): number {
  if (!text) return 0;
  const cached = _tokenCache.get(text);
  if (cached !== undefined) return cached;
  let result: number;
  if (encoder) {
    result = encoder.encode(text).length;
  } else {
    // ensureTokenizer() 未 await のフォールバック。Trim 計算が破綻しない程度の概算
    // （日本語・英語混在で 1 トークン ≒ 2 文字を仮定）。
    if (!_heuristicWarned) {
      _heuristicWarned = true;
      console.warn(
        "[contextBuilder] countTokens called before ensureTokenizer(); using heuristic.",
      );
    }
    result = Math.ceil(text.length / 2);
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

/**
 * プロジェクトスコープ用: タイムライン付きCodexエントリフォーマット
 */
export function formatTimelineEntry(
  entry: CodexContext,
  phases: {
    label: string;
    anchorTitle: string;
    summaryOverride: string | null;
  }[],
): string {
  if (phases.length > 0) {
    const latestResolved: ResolvedCodexState = {
      summary: entry.summary || null,
      content: "",
      contextMode: "mentioned",
      detailValues: new Map(),
      appliedPhaseIds: [],
    };
    return formatTimelineContext(
      { name: entry.name, type: entry.type, summary: entry.summary || null },
      phases,
      latestResolved,
    );
  }
  // フェーズなし: 通常フォーマット
  const typeLabels = JA_TYPE_LABELS;
  const label = typeLabels[entry.type] ?? entry.type;
  const displaySummary = entry.summary.trim() || entry.contentFallback || "";
  return `- **${entry.name}** (${label}): ${displaySummary}`;
}
