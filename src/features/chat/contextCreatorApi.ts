/**
 * Context Creator API
 * AI がプロジェクトデータを検索し、コンテキストに追加すべき Codex エントリを提案する。
 * エージェントループを再利用するが、ツールサブセットと低 effort で実行する。
 */

import { runAgentLoop } from "./agent/agentLoop";
import { executeTool } from "./agent/toolExecutors";
import { AGENT_TOOLS } from "./agent/toolDefinitions";
import { buildThinkingParams, getEffortForTask } from "./agent/modelLimits";
import { sendAgentMessage } from "./chatApi";
import type { AgentMessagePayload } from "./agent/agentTypes";

export interface SuggestedEntry {
  id: string;
  name: string;
  type: string;
  summary: string;
  reason: string;
  alreadyPinned: boolean;
}

/** Context Creator で使うツールのサブセット */
const CREATOR_TOOLS = AGENT_TOOLS.filter((t) =>
  [
    "search_codex",
    "list_codex_by_type",
    "search_codex_by_tags",
    "search_snippets",
  ].includes(t.name),
);

const TOOL_TOKEN_BUDGET = 2_000;

const SYSTEM_PROMPT = `You are a context search assistant for a novel writing tool.
Given the user's instruction, use the available tools to find relevant Codex entries and Snippets.
After searching, output a JSON array of suggested entries in this exact format (no markdown, no explanation):
[{"id":"...","name":"...","type":"...","summary":"...","reason":"..."}]
Only include entries that are genuinely relevant to the user's request.`;

/**
 * ユーザーの指示に基づき、コンテキストに追加すべきエントリを提案する。
 */
export async function runContextCreator(
  instruction: string,
  pinnedIds: string[],
  model: string,
): Promise<SuggestedEntry[]> {
  const thinkingParams = buildThinkingParams(
    model,
    getEffortForTask("chat"),
    "omitted",
  );

  const messages: AgentMessagePayload[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: instruction },
  ];

  let finalText = "";

  await runAgentLoop({
    messages,
    tools: CREATOR_TOOLS,
    tokenBudget: TOOL_TOKEN_BUDGET,
    sendToLLM: (msgs, tools) => sendAgentMessage(msgs, tools, thinkingParams),
    executeTool: async (name, toolCallId, params) => {
      const result = await executeTool(name, toolCallId, params);
      return result;
    },
    onProgress: () => {},
    onTextChunk: (text) => {
      finalText += text;
    },
    callLimitMessage: "Tool call limit reached. Please summarize findings.",
    tokenBudgetMessage: "Token budget low. Please summarize findings.",
  });

  return parseSuggestedEntries(finalText, pinnedIds);
}

function parseSuggestedEntries(
  text: string,
  pinnedIds: string[],
): SuggestedEntry[] {
  const trimmed = text.trim();
  // JSON 配列を抽出
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is Record<string, string> =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).id === "string",
      )
      .map((item) => ({
        id: item.id,
        name: item.name ?? "",
        type: item.type ?? "",
        summary: item.summary ?? "",
        reason: item.reason ?? "",
        alreadyPinned: pinnedIds.includes(item.id),
      }));
  } catch {
    return [];
  }
}
