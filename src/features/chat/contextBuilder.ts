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
}

export interface BuildSystemPromptInput {
  scene: SceneContext;
  project?: ProjectContext;
  storySoFar?: string;
  codexEntries?: CodexContext[];
  pinnedCodexEntries?: CodexContext[];
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

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const parts: string[] = [];

  parts.push(
    "あなたは小説執筆を支援するAIアシスタントです。" +
      "ユーザーの執筆スタイルを尊重し、創造的な提案や文章の改善を行ってください。",
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

  parts.push(`\n## 現在のシーン\n` + `タイトル: ${input.scene.title}`);

  if (input.scene.content) {
    parts.push(`\n### シーン本文\n${input.scene.content}`);
  }

  const allCodex = deduplicateById([
    ...(input.codexEntries ?? []),
    ...(input.pinnedCodexEntries ?? []),
  ]);
  if (allCodex.length > 0) {
    const typeLabels: Record<string, string> = {
      character: "キャラクター",
      location: "場所",
      item: "アイテム",
      lore: "設定",
    };
    parts.push("\n## 登場キャラクター・設定情報");
    for (const entry of allCodex) {
      const label = typeLabels[entry.type] ?? entry.type;
      parts.push(`- **${entry.name}** (${label}): ${entry.summary}`);
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
    const body = kept
      .map((e) => `${e.title}\n${e.synopsis}`)
      .join("\n\n");
    const full = header + body;
    if (countTokens(full) <= tokenBudget) {
      return full;
    }
    // Remove the oldest entry
    kept = kept.slice(1);
  }

  return "";
}
