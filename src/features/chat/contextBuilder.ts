import { encodingForModel } from "js-tiktoken";
import type { TreeNodeData } from "@/features/tree/treeStore";

export interface SceneContext {
  id: string;
  title: string;
  content: string;
}

export interface ProjectContext {
  title: string;
  genre?: string | null;
  pov?: string | null;
  tense?: string | null;
  styleGuide?: string | null;
  aiInstructions?: string | null;
}

export interface CodexContext {
  id: string;
  type: string;
  name: string;
  summary: string;
  childrenContext?: string; // pre-computed descendant summaries within budget
}

export interface PinnedCodexContext extends CodexContext {
  withChildren?: boolean;
  children?: CodexContext[]; // full content children (budget ignored)
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
  codexEntries?: CodexContext[];
  pinnedCodexEntries?: PinnedCodexContext[];
  /** L6: /command で注入されるインストラクション（一回限り） */
  commandInstruction?: string;
  /** コンテキストウィンドウのトークン数（trimToFit使用時に必要） */
  contextWindow?: number;
  /** 会話履歴のトークン数（trimToFit使用時に必要） */
  conversationTokens?: number;
  /** トリムで除外するレイヤー（空文字に置換される） */
  excludeLayers?: string[];
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

const encoder = encodingForModel("gpt-4o");

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
function trimL3Text(text: string, targetTokens: number): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  // Keep "## 現在のシーン" header section up to "### シーン本文\n"
  const bodyHeaderMatch = text.match(/([\s\S]*?### シーン本文\n)/);
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
function trimL1Text(text: string, targetTokens: number): string {
  if (countTokens(text) <= targetTokens) return text;
  if (targetTokens <= 0) return "";

  // Rebuild the L1 text by progressively removing optional fields
  // We work on the raw text via line-based manipulation.
  // Fields to remove in order: styleGuide block, aiInstructions block, genre line, pov line, tense line
  const removablePatterns = [
    /\n文体ガイド:\n[\s\S]*?(?=\n[^\s]|$)/,
    /\nAI指示:\n[\s\S]*?(?=\n[^\s]|$)/,
    /\nジャンル:[^\n]*/,
    /\n視点:[^\n]*/,
    /\n時制:[^\n]*/,
  ];

  let current = text;
  for (const pattern of removablePatterns) {
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

const RESPONSE_RESERVATION = 4_000;

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
  const layers: LayerBreakdown[] = [];

  // Base instruction (L0)
  const baseText =
    "あなたは小説執筆を支援するAIアシスタントです。" +
    "ユーザーの執筆スタイルを尊重し、創造的な提案や文章の改善を行ってください。";

  // L1: Project info
  let l1Text = "";
  if (input.project) {
    const p = input.project;
    const info: string[] = [`タイトル: ${p.title}`];
    if (p.genre) info.push(`ジャンル: ${p.genre}`);
    if (p.pov) info.push(`視点: ${p.pov}`);
    if (p.tense) info.push(`時制: ${p.tense}`);
    if (p.styleGuide) info.push(`文体ガイド:\n${p.styleGuide}`);
    if (p.aiInstructions) info.push(`AI指示:\n${p.aiInstructions}`);
    l1Text = `\n## プロジェクト情報\n${info.join("\n")}`;
  }

  // L2: Story so far
  let l2Text = input.storySoFar ? `\n${input.storySoFar}` : "";

  // L3: Current scene
  let l3Text = `\n## 現在のシーン\nタイトル: ${input.scene.title}`;
  if (input.scene.content) {
    l3Text += `\n\n### シーン本文\n${sanitizeSceneContent(input.scene.content)}`;
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

  const allCodex = deduplicateById([
    ...(input.codexEntries ?? []).filter((e) => !pinnedChildIds.has(e.id)),
    ...pinnedWithChildren,
  ]);
  let l4Text = "";
  if (allCodex.length > 0) {
    const typeLabels: Record<string, string> = {
      character: "キャラクター",
      location: "場所",
      item: "アイテム",
      lore: "設定",
    };
    const lines = ["\n## 登場キャラクター・設定情報"];
    for (const entry of allCodex) {
      const label = typeLabels[entry.type] ?? entry.type;
      lines.push(`- **${entry.name}** (${label}): ${entry.summary}`);
      if (entry.childrenContext) {
        lines.push(entry.childrenContext);
      }
    }
    l4Text = lines.join("\n");
  }

  // L5: 将来用 (現在は常に空)
  const l5Text = "";

  // L6: Command instruction（一回限りのコマンド注入）
  const l6Text = input.commandInstruction
    ? `\n## 指示\n${input.commandInstruction}`
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
    const budget =
      input.contextWindow - RESPONSE_RESERVATION - input.conversationTokens;
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
    label: "プロジェクト情報",
    used: countTokens(effectiveL1),
  });
  layers.push({
    layer: "L2",
    label: "これまでの物語",
    used: countTokens(effectiveL2),
  });
  layers.push({
    layer: "L3",
    label: "現在のシーン",
    used: countTokens(effectiveL3),
  });
  layers.push({
    layer: "L4",
    label: "Codex・設定情報",
    used: countTokens(effectiveL4),
  });
  if (effectiveL6) {
    layers.push({
      layer: "L6",
      label: "コマンド指示",
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
}

/** Agent mode用システムプロンプト — Layer 4（Codex自動注入）を除外 */
export function buildAgentSystemPrompt(
  input: BuildAgentSystemPromptInput,
): string {
  const parts: string[] = [];

  parts.push(
    "あなたは小説執筆を支援するAIアシスタントです。" +
      "ユーザーの執筆スタイルを尊重し、創造的な提案や文章の改善を行ってください。\n" +
      "プロジェクトデータを検索するツールが利用可能です。回答に必要な情報はツールで取得してください。",
  );

  if (input.project) {
    const p = input.project;
    const info: string[] = [`タイトル: ${p.title}`];
    if (p.genre) info.push(`ジャンル: ${p.genre}`);
    if (p.pov) info.push(`視点: ${p.pov}`);
    if (p.tense) info.push(`時制: ${p.tense}`);
    if (p.styleGuide) info.push(`文体ガイド:\n${p.styleGuide}`);
    if (p.aiInstructions) info.push(`AI指示:\n${p.aiInstructions}`);
    parts.push(`\n## プロジェクト情報\n${info.join("\n")}`);
  }

  if (input.storySoFar) {
    parts.push(`\n${input.storySoFar}`);
  }

  if (input.scene) {
    parts.push(`\n## 現在のシーン\n` + `タイトル: ${input.scene.title}`);
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
  return encoder.encode(text).length;
}

export function buildStorySoFar(
  currentSceneId: string,
  allNodes: TreeNodeData[],
  tokenBudget: number,
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
        n.sortOrder < currentScene.sortOrder &&
        n.synopsis != null &&
        n.synopsis.trim() !== "",
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (precedingScenes.length === 0) return "";

  // Build entries (oldest first)
  const entries = precedingScenes.map((scene) => ({
    title: scene.title,
    synopsis: scene.synopsis as string,
  }));

  // Trim oldest scenes first if token budget exceeded
  const header = "## これまでの物語\n\n";
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
