import { encodingForModel } from "js-tiktoken";

export interface SceneContext {
  id: string;
  title: string;
  content: string;
}

export interface ProjectContext {
  title: string;
  description: string;
}

export interface CodexContext {
  id: number;
  type: string;
  name: string;
  summary: string;
}

export interface BuildSystemPromptInput {
  scene: SceneContext;
  project?: ProjectContext;
  codexEntries?: CodexContext[];
  pinnedCodexEntries?: CodexContext[];
}

const encoder = encodingForModel("gpt-4o");

function deduplicateById(entries: CodexContext[]): CodexContext[] {
  const seen = new Set<number>();
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
    parts.push(
      `\n## プロジェクト情報\n` +
        `タイトル: ${input.project.title}\n` +
        `概要: ${input.project.description}`,
    );
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
