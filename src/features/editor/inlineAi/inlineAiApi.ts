import { invoke } from "@/lib/tauri";
import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";

function buildSystemPrompt(
  _command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  const lines: string[] = [
    `あなたは小説執筆アシスタントです。プロジェクト「${ctx.projectTitle}」のシーン「${ctx.sceneTitle}」の執筆を支援しています。`,
  ];
  if (ctx.codexSummaries) {
    lines.push(`\n## 関連設定\n${ctx.codexSummaries}`);
  }
  return lines.join("\n");
}

function buildUserPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  const scene = `\n## シーン本文\n${ctx.sceneText}`;
  const cursor = ctx.cursorContext
    ? `\n## カーソル周辺\n${ctx.cursorContext}`
    : "";
  const selection = ctx.selectedText
    ? `\n## 選択テキスト\n${ctx.selectedText}`
    : "";

  switch (command.id) {
    case "continue":
      return `${scene}${cursor}\n\n続きを書いてください。自然な流れで500文字程度。本文のみ出力してください。`;
    case "rewrite":
      return `${scene}${selection}\n\n選択テキストを同じ意味でより良く書き直してください。本文のみ出力してください。`;
    case "describe":
      return `${scene}${cursor}\n\n「${ctx.arg ?? "対象"}」の描写を書いてください。本文のみ出力してください。`;
    case "dialogue":
      return `${scene}${cursor}\n\n「${ctx.arg ?? "キャラクター"}」の台詞と地の文を書いてください。本文のみ出力してください。`;
    case "shorten":
      return `${scene}${selection}\n\n選択テキストを意味を保ちながら短く簡潔にしてください。本文のみ出力してください。`;
    case "expand":
      return `${scene}${selection}\n\n選択テキストに詳細・描写を加えて膨らませてください。本文のみ出力してください。`;
    case "tone":
      return `${scene}${selection}\n\n選択テキストのトーンを「${ctx.arg ?? ""}」に変えてください。本文のみ出力してください。`;
    case "translate":
      return `${scene}${selection}\n\n選択テキストを「${ctx.arg ?? "English"}」に翻訳してください。翻訳文のみ出力してください。`;
    case "custom":
      return `${scene}${cursor}${selection}\n\n${ctx.arg ?? "テキストを改善してください。"}本文のみ出力してください。`;
    default:
      return `${scene}${cursor}\n\n続きを書いてください。本文のみ出力してください。`;
  }
}

export async function generateInlineAi(
  command: InlineAiCommand,
  context: InlineAiContext,
  onChunk: (chunk: string) => void,
): Promise<{ text: string; model: string }> {
  const messages = [
    { role: "system", content: buildSystemPrompt(command, context) },
    { role: "user", content: buildUserPrompt(command, context) },
  ];

  const response = await invoke<string>("send_chat_message", { messages });
  onChunk(response);
  return { text: response, model: "claude-sonnet-4-6" };
}
