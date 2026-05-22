import type { ChatMessage } from "@/features/chat/chatTypes";

export interface SummarizationPromptOptions {
  previousSummary?: string;
  generation: number;
}

export function buildSummarizationPromptJa(
  messages: ChatMessage[],
  opts?: SummarizationPromptOptions,
): string {
  const lines = messages.map((m) => {
    const roleLabel = m.role === "user" ? "ユーザー" : "アシスタント";
    return `${roleLabel}: ${m.content}`;
  });

  const previousBlock = opts?.previousSummary
    ? `\n\n=== 直前世代の要約 ===\n${opts.previousSummary}\n`
    : "";

  return (
    `CONVERSATION CHECKPOINT — HANDOFF SUMMARY\n\n` +
    `あなたは小説執筆セッションの引き継ぎ要約を作成しています。\n` +
    `次のターンのアシスタントが文脈を失わずに作業を継続できるよう、\n` +
    `以下を構造化して保持してください:\n\n` +
    `## このセッションの執筆目標\n` +
    `## 合意・決定した事項\n` +
    `## 言及された Codex エントリ\n` +
    `## 文体・トーンに関するユーザーの指示\n` +
    `## 検討中のドラフト / 提案テキスト\n` +
    `## 未解決の問い / 保留中のアクション\n\n` +
    `要約のみを出力してください。先頭行に HTML コメントで\n` +
    `<!-- gen=${opts?.generation ?? 1} source_msg_count=${messages.length} last_msg_id=... generated_at=... -->\n` +
    `を含めてください。\n` +
    previousBlock +
    `\n=== 入力メッセージ ===\n` +
    lines.join("\n\n")
  );
}
