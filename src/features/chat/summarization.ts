import type { ChatMessage } from "./chatTypes";
import type { ChatMessageResult } from "./chatApi";

export const SUMMARIZATION_THRESHOLD = 16;
export const KEEP_RECENT_COUNT = 8;

/**
 * 要約トリガー判定。
 * system以外の未要約メッセージ数が閾値を超えたら true を返す。
 */
export function shouldSummarize(messages: ChatMessage[]): boolean {
  const unsummarized = messages.filter(
    (m) => m.role !== "system" && !m.isSummarized,
  );
  return unsummarized.length > SUMMARIZATION_THRESHOLD;
}

/**
 * 要約対象メッセージを選定する。
 * 条件: system除外 / starred除外 / 既要約除外 / 直近 KEEP_RECENT_COUNT 件除外
 */
export function selectSummarizationCandidates(
  messages: ChatMessage[],
): ChatMessage[] {
  const nonSystem = messages.filter((m) => m.role !== "system");
  // 直近 N 件を保護
  const recentIds = new Set(
    nonSystem.slice(-KEEP_RECENT_COUNT).map((m) => m.id),
  );

  return nonSystem.filter(
    (m) => !m.isStarred && !m.isSummarized && !recentIds.has(m.id),
  );
}

/**
 * 要約用プロンプトを構築する。
 */
export function createSummarizationPrompt(messages: ChatMessage[]): string {
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

/**
 * LLMを呼び出して要約を生成する。
 * sendMessage は sendChatMessageWithThinking と同じシグネチャ。
 */
export async function runSummarization(
  candidates: ChatMessage[],
  sendMessage: (
    messages: { role: string; content: string }[],
    thinkingParams?: { effort?: string | null },
  ) => Promise<ChatMessageResult>,
): Promise<string> {
  const prompt = createSummarizationPrompt(candidates);
  const result = await sendMessage([{ role: "user", content: prompt }], {
    effort: "low",
  });
  return result.text.trim();
}
