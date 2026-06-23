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
import { resolveRoleSendOverride } from "./modelRouting";
import type { AgentMessagePayload } from "./agent/agentTypes";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";

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
  // Defense: 実 LLM を呼ぶエージェント実行なので、メインチャット sendMessage と
  // 同じ chokepoint を UI presentation から独立に通す（内部再入・再配線対策）。
  if (blockIfPolicyOff("chat")) return [];
  if (blockIfUnlicensed()) return [];

  // agent ロールの override を実モデルとして解決。thinking と usage 記録を実モデルから
  // 導出し、sendAgentMessage に渡す override と一致させる（未設定なら引数の既定モデル）。
  // 横断割り当て時は provider/endpoint/variant も同じ ov から送信へ流す。
  const ov = resolveRoleSendOverride("context_creator");
  const effectiveModel = ov.model ?? model;
  const thinkingParams = buildThinkingParams(
    effectiveModel,
    getEffortForTask("chat"),
    "omitted",
  );

  const messages: AgentMessagePayload[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: instruction },
  ];

  const loopResult = await runAgentLoop({
    messages,
    tools: CREATOR_TOOLS,
    tokenBudget: TOOL_TOKEN_BUDGET,
    sendToLLM: (msgs, tools) =>
      sendAgentMessage(
        msgs,
        tools,
        thinkingParams,
        undefined,
        ov.apiVariant,
        undefined,
        undefined,
        ov.model,
        ov.provider,
        ov.endpointId,
      ),
    executeTool: async (name, toolCallId, params) => {
      const result = await executeTool(name, toolCallId, params);
      return result;
    },
    onProgress: () => {},
    onTextChunk: () => {},
    callLimitMessage: "Tool call limit reached. Please summarize findings.",
    tokenBudgetMessage: "Token budget low. Please summarize findings.",
  });

  // N4: Context Creator のエージェント実行 usage を台帳に記録。
  void recordAiUsage({
    surface: "context_creator",
    model: effectiveModel,
    tokensIn: loopResult.tokensIn,
    tokensOut: loopResult.tokensOut,
    costUsd: loopResult.cost,
  });

  // 中間ターンの説明文に '[' が混じると greedy 抽出が跨って捕捉するため、
  // 解析対象は最終 assistant メッセージのみとする。
  return parseSuggestedEntries(loopResult.finalText, pinnedIds);
}

function parseSuggestedEntries(
  text: string,
  pinnedIds: string[],
): SuggestedEntry[] {
  const parsed = extractLastJsonArray(text.trim());
  if (!parsed) return [];

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
}

/**
 * テキストに含まれる JSON 配列を、バランスした角括弧スキャンで抽出する。
 * 説明文中の stray な '[' を greedy 正規表現が跨いで捕捉する破綻を避けるため、
 * 後ろの '[' から順に対応の取れた候補を JSON.parse する。
 * エントリ要素のネスト配列フィールド (例 aliases) を誤って拾わないよう、
 * id 付きオブジェクトを含む配列を優先し、無ければ最後にパース成功した配列
 * (空配列 = 提案なし、を含む) にフォールバックする。
 */
function extractLastJsonArray(text: string): unknown[] | null {
  let fallback: unknown[] | null = null;
  for (
    let start = text.lastIndexOf("[");
    start >= 0;
    start = text.lastIndexOf("[", start - 1)
  ) {
    const candidate = scanBalancedArray(text, start);
    if (candidate) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          const hasEntryShape = parsed.some(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              typeof (item as Record<string, unknown>).id === "string",
          );
          if (hasEntryShape) return parsed;
          fallback ??= parsed;
        }
      } catch {
        // JSON でない候補は手前の '[' を試す
      }
    }
    if (start === 0) break;
  }
  return fallback;
}

/** start の '[' から、文字列リテラル・エスケープを考慮して対応する ']' までを切り出す。 */
function scanBalancedArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
