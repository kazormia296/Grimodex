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

export interface BuildSystemPromptInput {
  scene: SceneContext;
  project?: ProjectContext;
}

const encoder = encodingForModel("gpt-4o");

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

  return parts.join("\n");
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return encoder.encode(text).length;
}
