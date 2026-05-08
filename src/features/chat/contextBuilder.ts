import type { Tiktoken } from "js-tiktoken/lite";
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
}

export interface CodexContext {
  id: string;
  type: string;
  name: string;
  summary: string;
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
  /** 執筆言語（project.language）。省略時は "ja" にフォールバック */
  lang?: string;
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
}

// js-tiktoken は cl100k/p50k/r50k/o200k 等の BPE テーブルを含み 5MB 超ある。
// メインチャンクから切り離すため lite + 必要 rank だけを動的 import する。
// 起動を遅らせないよう事前ロードはせず、`ensureTokenizer()` を chat フロー入口で await する。
let encoder: Tiktoken | null = null;
let encoderLoadingPromise: Promise<Tiktoken> | null = null;
let _heuristicWarned = false;

export async function ensureTokenizer(): Promise<void> {
  if (encoder) return;
  if (!encoderLoadingPromise) {
    encoderLoadingPromise = (async () => {
      const [lite, ranks] = await Promise.all([
        import("js-tiktoken/lite"),
        import("js-tiktoken/ranks/o200k_base"),
      ]);
      encoder = new lite.Tiktoken(ranks.default);
      return encoder;
    })();
  }
  await encoderLoadingPromise;
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

/** L4: Codexエントリを末尾から1件ずつ削除（`- **` で分割） */
function trimL4Text(text: string, targetTokens: number): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  // Split on lines starting with "- **" to get entries
  // Keep the header line (first line: "\n## 登場キャラクター・設定情報")
  const headerMatch = text.match(/^(\n## [^\n]+\n)/);
  const header = headerMatch ? headerMatch[1] : "";
  const body = header ? text.slice(header.length) : text;

  // Split into entry blocks — each starting with "- **"
  const entryBlocks = body.split(/(?=\n- \*\*)/).filter((b) => b.length > 0);

  // Remove from the end until within budget
  let kept = [...entryBlocks];
  while (kept.length > 0) {
    const candidate = header + kept.join("");
    if (countTokens(candidate) <= targetTokens) return candidate;
    kept = kept.slice(0, kept.length - 1);
  }
  return "";
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

  // Base instruction (L0)
  const baseText = s.baseText;

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

  // L2: Story so far
  const l2Text = input.storySoFar ? `\n${input.storySoFar}` : "";

  // L3: Current scene (+ G11: preceding scene synopsis + G19: active tab content)
  let l3Text = "";
  if (input.previousScene) {
    l3Text += `${s.headers.previousScene}\n${s.labels.prevTitle}: ${input.previousScene.title}\n${s.labels.prevSummary}: ${input.previousScene.synopsis}`;
  }
  l3Text += `${s.headers.currentScene}\n${s.labels.title}: ${input.scene.title}`;
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
  if (input.scene.content) {
    l3Text += `${s.headers.sceneBody}\n${sanitizeSceneContent(input.scene.content)}`;
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
  const allCodex = deduplicateById([
    ...(input.codexEntries ?? []).filter(
      (e) => !pinnedChildIds.has(e.id) && !pinnedIds.has(e.id),
    ),
    ...pinnedWithChildren,
  ]);
  let l4Text = "";
  const hasPinnedSnippets =
    input.pinnedSnippets && input.pinnedSnippets.length > 0;
  if (allCodex.length > 0 || hasPinnedSnippets) {
    const lines = [s.headers.codexSection];
    for (const entry of allCodex) {
      const label = s.typeLabels[entry.type] ?? entry.type;
      // G13: summary未記入時はcontentPlainTextにフォールバック
      const displaySummary =
        entry.summary.trim() || entry.contentFallback || "";
      const phaseSuffix = entry.phaseLabel ? ` [${entry.phaseLabel}]` : "";
      lines.push(
        `- **${entry.name}**${phaseSuffix} (${label}): ${displaySummary}`,
      );
      if (pinnedIds.has(entry.id) && entry.customDetails?.length) {
        for (const detail of entry.customDetails) {
          lines.push(`  - ${detail.fieldName}: ${detail.value}`);
        }
      }
      if (entry.fullContent) {
        lines.push(`  本文:\n${entry.fullContent}`);
      }
      if (entry.childrenContext) {
        lines.push(entry.childrenContext);
      }
    }
    // G16: ピン留めSnippetをL4に注入
    for (const snippet of input.pinnedSnippets ?? []) {
      lines.push(`- **${snippet.title}** (Snippet): ${snippet.content}`);
    }
    l4Text = lines.join("\n");
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

  layers.push({
    layer: "L1",
    label: i18next.t("chat.context.layer.L1"),
    used: countTokens(effectiveL1),
  });
  layers.push({
    layer: "L2",
    label: i18next.t("chat.context.layer.L2"),
    used: countTokens(effectiveL2),
  });
  layers.push({
    layer: "L3",
    label: i18next.t("chat.context.layer.L3"),
    used: countTokens(effectiveL3),
  });
  layers.push({
    layer: "L4",
    label: i18next.t("chat.context.layer.L4"),
    used: countTokens(effectiveL4),
  });
  if (effectiveL5) {
    layers.push({
      layer: "L5",
      label: i18next.t("chat.context.layer.L5"),
      used: countTokens(effectiveL5),
    });
  }
  if (effectiveL6) {
    layers.push({
      layer: "L6",
      label: i18next.t("chat.context.layer.L6"),
      used: countTokens(effectiveL6),
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
  const totalTokens = countTokens(prompt);

  return {
    prompt,
    totalTokens,
    layers,
    ...(trimmedLayers ? { trimmedLayers } : {}),
  };
}

export interface BuildAgentSystemPromptInput {
  scene?: SceneContext;
  project?: ProjectContext;
  storySoFar?: string;
  lang?: string;
}

/** Agent mode用システムプロンプト — Layer 4（Codex自動注入）を除外 */
export function buildAgentSystemPrompt(
  input: BuildAgentSystemPromptInput,
): string {
  const s = getPromptCatalog(input.lang ?? "ja").chatSystem;
  const parts: string[] = [];

  parts.push(s.agentBaseText);

  if (input.project) {
    const p = input.project;
    const info: string[] = [`${s.labels.title}: ${p.title}`];
    if (p.genre) info.push(`${s.labels.genre}: ${p.genre}`);
    if (p.pov) info.push(`${s.labels.pov}: ${p.pov}`);
    if (p.tense) info.push(`${s.labels.tense}: ${p.tense}`);
    if (p.styleGuide) info.push(`${s.labels.styleGuide}:\n${p.styleGuide}`);
    if (p.aiInstructions)
      info.push(`${s.labels.aiInstructions}:\n${p.aiInstructions}`);
    parts.push(`${s.headers.projectInfo}\n${info.join("\n")}`);
  }

  if (input.storySoFar) {
    parts.push(`\n${input.storySoFar}`);
  }

  if (input.scene) {
    let sceneSection = `${s.headers.currentScene}\n${s.labels.title}: ${input.scene.title}`;
    if (input.scene.synopsis) {
      sceneSection += `\n${s.labels.synopsis}: ${input.scene.synopsis}`;
    }
    parts.push(sceneSection);
    if (input.scene.content) {
      parts.push(
        `\n### シーン本文\n${sanitizeSceneContent(input.scene.content)}`,
      );
    }
  }

  return parts.join("\n");
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
