import type { ChatMessage } from "./chatTypes";
import type { ChatMessageResult } from "./chatApi";
import type { ChatSummary } from "./chatTypes";
import type { ThinkingParams } from "./agent/modelLimits";
import { getPromptCatalog } from "@/prompts/index";
import { countTokens } from "./contextBuilder";
import { buildHandoffMetaComment } from "./conversationHistory";

export {
  shouldSummarize,
  selectSummarizationCandidates,
  computeL5UsedTokens,
  classifyMessagesForL5,
  isTier2Anchor,
  countTurns,
} from "./conversationHistory";

/**
 * 要約用プロンプトを構築する (handoff 形式)。
 */
export function createSummarizationPrompt(
  candidates: ChatMessage[],
  opts: {
    lang?: string;
    previousSummary?: string;
    generation: number;
  },
): string {
  return getPromptCatalog(opts.lang ?? "ja").summarization.buildPrompt(
    candidates,
    {
      previousSummary: opts.previousSummary,
      generation: opts.generation,
    },
  );
}

/**
 * LLMを呼び出して要約を生成する。
 */
export async function runSummarization(
  candidates: ChatMessage[],
  sendMessage: (
    messages: { role: string; content: string }[],
    thinkingParams?: ThinkingParams,
  ) => Promise<ChatMessageResult>,
  opts: {
    lang?: string;
    previousSummary?: string;
    generation: number;
    sourceMsgCount: number;
    lastMsgId: string;
  },
): Promise<string> {
  const prompt = createSummarizationPrompt(candidates, opts);
  const result = await sendMessage([{ role: "user", content: prompt }], {
    effort: "low",
  });
  const trimmed = result.text.trim();
  const meta = buildHandoffMetaComment({
    generation: opts.generation,
    sourceMsgCount: opts.sourceMsgCount,
    lastMsgId: opts.lastMsgId,
    generatedAt: new Date().toISOString(),
  });
  return trimmed.startsWith("<!-- gen=") ? trimmed : `${meta}\n\n${trimmed}`;
}

export function estimateSummaryTokenCount(summaryText: string): number {
  return countTokens(summaryText);
}

export function getPreviousSummaryText(summaries: ChatSummary[]): string | undefined {
  if (summaries.length === 0) return undefined;
  return summaries[summaries.length - 1].summary;
}

export function getMaxSummaryGeneration(summaries: ChatSummary[]): number {
  if (summaries.length === 0) return 0;
  return Math.max(...summaries.map((s) => s.generation));
}
