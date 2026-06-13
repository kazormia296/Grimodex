import type {
  InlineAiCommand,
  InlineAiContext,
} from "@/features/editor/inlineAi/inlineAiTypes";

export function buildInlineAiSystemPromptEn(
  _command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  const lines: string[] = [
    `You are a fiction-writing assistant. You are helping write the scene "${ctx.sceneTitle}" in the project "${ctx.projectTitle}".`,
  ];
  if (ctx.codexSummaries) {
    lines.push(`\n## Related settings\n${ctx.codexSummaries}`);
  }
  // User-defined additional instruction (aiPrompt.custom.inline). Add nothing if empty.
  if (ctx.customInstruction?.trim()) {
    lines.push(`\n## Additional instructions\n${ctx.customInstruction.trim()}`);
  }
  return lines.join("\n");
}

export function buildInlineAiUserPromptEn(
  command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  const scene = `\n## Scene text\n${ctx.sceneText}`;
  const cursor = ctx.cursorContext
    ? `\n## Around the cursor (text before and after the 【カーソル】 marker)\n${ctx.cursorContext}`
    : "";
  const selection = ctx.selectedText
    ? `\n## Selected text\n${ctx.selectedText}`
    : "";

  switch (command.id) {
    case "continue":
      return `${scene}${cursor}\n\nContinue writing. Keep it flowing naturally, about 250 words. Output the prose only.`;
    case "rewrite":
      return `${scene}${selection}\n\nRewrite the selected text to read better while keeping the same meaning. Output the prose only.`;
    case "describe":
      return `${scene}${cursor}\n\nWrite a description of "${ctx.arg ?? "the subject"}". Output the prose only.`;
    case "dialogue":
      return `${scene}${cursor}\n\nWrite dialogue and narration for "${ctx.arg ?? "the character"}". Output the prose only.`;
    case "shorten":
      return `${scene}${selection}\n\nMake the selected text shorter and more concise while preserving its meaning. Output the prose only.`;
    case "expand":
      return `${scene}${selection}\n\nExpand the selected text by adding detail and description. Output the prose only.`;
    case "tone":
      return `${scene}${selection}\n\nChange the tone of the selected text to "${ctx.arg ?? ""}". Output the prose only.`;
    case "translate":
      return `${scene}${selection}\n\nTranslate the selected text into "${ctx.arg ?? "English"}". Output the translation only.`;
    case "custom":
      return `${scene}${cursor}${selection}\n\n${ctx.arg ?? "Improve the text."} Output the prose only.`;
    default:
      return `${scene}${cursor}\n\nContinue writing. Output the prose only.`;
  }
}
