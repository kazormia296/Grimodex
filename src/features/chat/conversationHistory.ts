import type { ChatMessage, ChatMessageMetadata } from "./chatTypes";
import { parseChatMessageMetadata } from "./chatTypes";
import { countTokens } from "./contextBuilder";

export const TIER2_SUB_BUDGET_RATIO = 0.4;
export const PREVENTIVE_TURN_THRESHOLD = 4;
export const PREVENTIVE_BUDGET_RATIO = 0.8;
export const EMERGENCY_MIN_TURNS = 3;
export const RECENT_TURN_PAIRS = 3;

function nonSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== "system");
}

export function countTurns(messages: ChatMessage[]): number {
  return Math.floor(nonSystemMessages(messages).length / 2);
}

export function isTier2Anchor(
  msg: ChatMessage,
  meta: ChatMessageMetadata,
): boolean {
  if (msg.role === "user") return true;
  if (meta.insertedToEditor === true) return true;
  if (Array.isArray(meta.extractedCodex) && meta.extractedCodex.length > 0) {
    return true;
  }
  if (
    Array.isArray(meta.extractedSnippets) &&
    meta.extractedSnippets.length > 0
  ) {
    return true;
  }
  return false;
}

/** Tier 1: first user message + last 3 turn-pairs (max 6 messages). */
export function getTier1Messages(messages: ChatMessage[]): ChatMessage[] {
  const nonSystem = nonSystemMessages(messages).filter((m) => !m.isSummarized);
  if (nonSystem.length === 0) return [];

  const firstUserIdx = nonSystem.findIndex((m) => m.role === "user");
  const tier1Ids = new Set<string>();

  if (firstUserIdx >= 0) {
    tier1Ids.add(nonSystem[firstUserIdx].id);
  }

  const recentCount = RECENT_TURN_PAIRS * 2;
  for (const m of nonSystem.slice(-recentCount)) {
    tier1Ids.add(m.id);
  }

  return nonSystem.filter((m) => tier1Ids.has(m.id));
}

export function classifyMessagesForL5(
  messages: ChatMessage[],
  l5Budget: number,
): {
  tier1: ChatMessage[];
  tier2: ChatMessage[];
  tier3: ChatMessage[];
} {
  const nonSystem = nonSystemMessages(messages).filter((m) => !m.isSummarized);
  const tier1 = getTier1Messages(messages);
  const tier1Ids = new Set(tier1.map((m) => m.id));

  const tier2Candidates: ChatMessage[] = [];
  for (const m of nonSystem) {
    if (tier1Ids.has(m.id)) continue;
    const meta = parseChatMessageMetadata(m.metadata);
    if (isTier2Anchor(m, meta)) {
      tier2Candidates.push(m);
    }
  }

  // Newest first within Tier 2 sub-budget (L5 × 40%).
  const tier2Budget = Math.floor(l5Budget * TIER2_SUB_BUDGET_RATIO);
  const tier2NewestFirst = [...tier2Candidates].reverse();
  const tier2: ChatMessage[] = [];
  let tier2Tokens = 0;
  for (const m of tier2NewestFirst) {
    const tokens = countTokens(m.content);
    if (tier2.length === 0 || tier2Tokens + tokens <= tier2Budget) {
      tier2.push(m);
      tier2Tokens += tokens;
    } else {
      break;
    }
  }
  const tier2Ids = new Set(tier2.map((m) => m.id));

  const tier3 = nonSystem.filter(
    (m) => !tier1Ids.has(m.id) && !tier2Ids.has(m.id) && m.role === "assistant",
  );

  return { tier1, tier2, tier3 };
}

export function computeL5UsedTokens(
  messages: ChatMessage[],
  summaries: string[],
  l5Budget: number,
): number {
  const summaryTokens = summaries.reduce(
    (sum, s) => sum + countTokens(s),
    0,
  );
  const { tier1, tier2, tier3 } = classifyMessagesForL5(messages, l5Budget);
  const messageTokens = [...tier1, ...tier2, ...tier3].reduce(
    (sum, m) => sum + countTokens(m.content),
    0,
  );
  return summaryTokens + messageTokens;
}

export function shouldSummarize(
  messages: ChatMessage[],
  l5Budget: number,
  l5UsedTokens: number,
): boolean {
  const turns = countTurns(messages);
  if (turns < EMERGENCY_MIN_TURNS) return false;

  const usageRatio = l5Budget > 0 ? l5UsedTokens / l5Budget : 1;

  if (usageRatio > 1) return true;
  if (turns > PREVENTIVE_TURN_THRESHOLD && usageRatio > PREVENTIVE_BUDGET_RATIO) {
    return true;
  }
  return false;
}

/** Tier 3 assistant messages only — summarization candidates. */
export function selectSummarizationCandidates(
  messages: ChatMessage[],
  l5Budget: number,
): ChatMessage[] {
  const { tier3 } = classifyMessagesForL5(messages, l5Budget);
  return tier3.filter((m) => !m.isSummarized);
}

export function buildHandoffMetaComment(opts: {
  generation: number;
  sourceMsgCount: number;
  lastMsgId: string;
  generatedAt: string;
}): string {
  return `<!-- gen=${opts.generation} source_msg_count=${opts.sourceMsgCount} last_msg_id=${opts.lastMsgId} generated_at=${opts.generatedAt} -->`;
}

export function parseHandoffMetaComment(summary: string): {
  generation?: number;
  sourceMsgCount?: number;
  lastMsgId?: string;
} {
  const match = summary.match(
    /<!-- gen=(\d+) source_msg_count=(\d+) last_msg_id=([^\s]+)/,
  );
  if (!match) return {};
  return {
    generation: Number(match[1]),
    sourceMsgCount: Number(match[2]),
    lastMsgId: match[3],
  };
}
