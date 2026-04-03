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

export interface BuildSystemPromptInput {
  scene: SceneContext;
  project?: ProjectContext;
  storySoFar?: string;
  codexEntries?: CodexContext[];
  pinnedCodexEntries?: CodexContext[];
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
}

const encoder = encodingForModel("gpt-4o");

function deduplicateById(entries: CodexContext[]): CodexContext[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
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
  layers.push({
    layer: "L1",
    label: "プロジェクト情報",
    used: countTokens(l1Text),
  });

  // L2: Story so far
  const l2Text = input.storySoFar ? `\n${input.storySoFar}` : "";
  layers.push({
    layer: "L2",
    label: "これまでの物語",
    used: countTokens(l2Text),
  });

  // L3: Current scene
  let l3Text = `\n## 現在のシーン\nタイトル: ${input.scene.title}`;
  if (input.scene.content) {
    l3Text += `\n\n### シーン本文\n${input.scene.content}`;
  }
  layers.push({
    layer: "L3",
    label: "現在のシーン",
    used: countTokens(l3Text),
  });

  // L4: Codex entries
  const allCodex = deduplicateById([
    ...(input.codexEntries ?? []),
    ...(input.pinnedCodexEntries ?? []),
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
  layers.push({
    layer: "L4",
    label: "Codex・設定情報",
    used: countTokens(l4Text),
  });

  const prompt = [baseText, l1Text, l2Text, l3Text, l4Text].join("\n");
  const totalTokens = countTokens(prompt);

  return { prompt, totalTokens, layers };
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
      parts.push(`\n### シーン本文\n${input.scene.content}`);
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
