import type { ChatMessage } from "./chatTypes";
import type { ChatMessageResult } from "./chatApi";
import type { ThinkingParams } from "./agent/modelLimits";
import { getPromptCatalog } from "@/prompts/index";

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
export function createSummarizationPrompt(
  messages: ChatMessage[],
  lang = "ja",
): string {
  return getPromptCatalog(lang).summarization.buildPrompt(messages);
}

/**
 * LLMを呼び出して要約を生成する。
 * sendMessage は sendChatMessageWithThinking と同じシグネチャ。
 */
export async function runSummarization(
  candidates: ChatMessage[],
  sendMessage: (
    messages: { role: string; content: string }[],
    thinkingParams?: ThinkingParams,
  ) => Promise<ChatMessageResult>,
): Promise<string> {
  const prompt = createSummarizationPrompt(candidates);
  const result = await sendMessage([{ role: "user", content: prompt }], {
    effort: "low",
  });
  return result.text.trim();
}
