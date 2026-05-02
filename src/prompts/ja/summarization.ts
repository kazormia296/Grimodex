import type { ChatMessage } from "@/features/chat/chatTypes";

export function buildSummarizationPromptJa(messages: ChatMessage[]): string {
  const lines = messages.map((m) => {
    const roleLabel = m.role === "user" ? "ユーザー" : "アシスタント";
    return `${roleLabel}: ${m.content}`;
  });

  return (
    `以下の会話履歴を箇条書きで要約してください。最大500文字以内にまとめてください。\n` +
    `重要な決定事項、固有名詞、数値は必ず保持してください。\n` +
    `要約のみを出力してください。余分な説明は不要です。\n\n` +
    `===会話履歴===\n` +
    lines.join("\n\n")
  );
}
