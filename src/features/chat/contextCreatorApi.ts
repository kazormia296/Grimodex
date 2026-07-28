/**
 * Context Creator API
 * AI がプロジェクトデータを検索し、コンテキストに追加すべき Codex エントリを提案する。
 * エージェントループを再利用するが、ツールサブセットと低 effort で実行する。
 */

import { runAgentLoop } from "./agent/agentLoop";
import { executeTool } from "./agent/toolExecutors";
import { AGENT_TOOLS } from "./agent/toolDefinitions";
import { sendAgentMessage } from "./chatApi";
import {
  parseRoleProviders,
  resolveRoleModel,
  resolveRolePathConfig,
  roleSettingKey,
  ROLE_PROVIDERS_KEY,
} from "./modelRouting";
import { refreshDynamicCapsForProvider, useAiSettingsStore } from "./store";
import type { AgentMessagePayload } from "./agent/agentTypes";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { DEFAULT_AI_SETTINGS, type AiSettings } from "./types";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  resolveChatTurnRoute,
  resolvedChatTurnRouteAuthorityKey,
  type ResolvedChatTurnRoute,
} from "./turn/resolveTurnRoute";
import {
  renderAgentConversationPayloads,
  renderAgentToolPayloads,
} from "./turn/renderAgentPayload";
import { finalizeTurnPayload } from "@/features/ai-context/finalizeTurnPayload";
import { countTokens, ensureTokenizer } from "./contextBuilder";
import i18next from "@/lib/i18n";

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
const TURN_PAYLOAD_SAFETY_MARGIN_TOKENS = 32;

const SYSTEM_PROMPT = `You are a context search assistant for a novel writing tool.
Given the user's instruction, use the available tools to find relevant Codex entries and Snippets.
After searching, output a JSON array of suggested entries in this exact format (no markdown, no explanation):
[{"id":"...","name":"...","type":"...","summary":"...","reason":"..."}]
Only include entries that are genuinely relevant to the user's request.`;

type ContextCreatorFallback = ResolvedChatTurnRoute | string | null;

function isResolvedRoute(
  fallback: ContextCreatorFallback,
): fallback is ResolvedChatTurnRoute {
  return typeof fallback === "object" && fallback !== null;
}

function fallbackSettings(fallback: ContextCreatorFallback): AiSettings {
  const configured = useAiSettingsStore.getState().settings;
  if (configured) return configured;
  if (isResolvedRoute(fallback)) return fallback.effectiveSettings;
  return {
    ...DEFAULT_AI_SETTINGS,
    model: typeof fallback === "string" ? fallback : "",
  };
}

/** Resolve the exact Context Creator route used by both UI gating and send. */
export function resolveContextCreatorRoute(
  fallback: ContextCreatorFallback,
): ResolvedChatTurnRoute {
  const settings = fallbackSettings(fallback);
  const role = resolveRolePathConfig(
    "context_creator",
    undefined,
    settings.provider,
  );
  const fallbackCandidate = isResolvedRoute(fallback)
    ? {
        model: fallback.model,
        provider: fallback.provider,
        apiVariant: fallback.apiVariant,
        endpointId: fallback.endpointId,
      }
    : typeof fallback === "string" && fallback.trim()
      ? { model: fallback }
      : null;
  return resolveChatTurnRoute({
    surface: "agent",
    activeSettings: settings,
    activeApiVariant: settings.modelApiVariant ?? null,
    composer: role ? null : fallbackCandidate,
    role: role
      ? {
          model: role.model,
          provider: role.provider,
          apiVariant: role.variant,
          endpointId: role.endpointId,
        }
      : null,
    taskEffort: "low",
    thinkingDisplay: "omitted",
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffortOverride: settings.reasoningEffortOverride ?? undefined,
  });
}

function contextCreatorAuthorityKey(fallback: ContextCreatorFallback): string {
  const aiState = useAiSettingsStore.getState();
  const settingsState = useSettingsStore.getState();
  const settings = aiState.settings;
  return JSON.stringify([
    // Includes active endpoint id plus every OpenAI-compatible endpoint
    // definition. Same-name models on two servers are distinct authorities.
    settings ?? null,
    aiState.chatModelOverride,
    aiState.chatProviderOverride,
    aiState.chatModelVariantOverride,
    aiState.chatEndpointIdOverride,
    settingsState.get(roleSettingKey("agent"), ""),
    settingsState.get(ROLE_PROVIDERS_KEY, ""),
    isResolvedRoute(fallback)
      ? resolvedChatTurnRouteAuthorityKey(fallback)
      : fallback,
  ]);
}

function rawContextCreatorOllamaTarget(
  settings: AiSettings,
): { model: string; endpoint: string } | null {
  const settingsState = useSettingsStore.getState();
  const rawRoleModel = resolveRoleModel("agent");
  if (!rawRoleModel) return null;
  const provider =
    parseRoleProviders(settingsState.get(ROLE_PROVIDERS_KEY, ""))["agent"]
      ?.provider ?? settings.provider;
  return provider === "ollama"
    ? {
        model: rawRoleModel,
        endpoint: settings.ollamaEndpoint,
      }
    : null;
}

/**
 * A cached no-tools observation must not permanently disable the UI entry
 * point: Ollama tags are mutable and runContextCreator performs the
 * authoritative selected-model probe before transport.
 */
export function canAttemptContextCreator(
  fallback: ContextCreatorFallback,
): boolean {
  const settings = fallbackSettings(fallback);
  const route = resolveContextCreatorRoute(fallback);
  return (
    route.capabilities.supportsTools ||
    route.provider === "ollama" ||
    rawContextCreatorOllamaTarget(settings) !== null
  );
}

/**
 * ユーザーの指示に基づき、コンテキストに追加すべきエントリを提案する。
 */
export async function runContextCreator(
  instruction: string,
  pinnedIds: string[],
  fallback: ContextCreatorFallback,
): Promise<SuggestedEntry[]> {
  // Defense: 実 LLM を呼ぶエージェント実行なので、メインチャット sendMessage と
  // 同じ chokepoint を UI presentation から独立に通す（内部再入・再配線対策）。
  if (blockIfPolicyOff("chat")) return [];
  if (blockIfUnlicensed()) return [];

  const authority = contextCreatorAuthorityKey(fallback);
  const settings = fallbackSettings(fallback);
  const probedTargets = new Set<string>();
  const probeOllama = async (
    model: string,
    endpoint: string,
  ): Promise<void> => {
    const key = `${endpoint.trim().replace(/\/+$/u, "")}\u0000${model}`;
    if (probedTargets.has(key)) return;
    probedTargets.add(key);
    const observed = await refreshDynamicCapsForProvider("ollama", {
      force: true,
      selectedModelId: model,
      ollamaEndpoint: endpoint,
      requireOllamaCapabilities: true,
    });
    if (contextCreatorAuthorityKey(fallback) !== authority) {
      throw new Error(
        "Context Creator model selection changed during preflight",
      );
    }
    if (observed === null) {
      throw new Error(i18next.t("chat.ollamaMetadataUnavailable", { model }));
    }
    if (observed.length === 0) {
      throw new Error(i18next.t("chat.ollamaModelUnavailable", { model }));
    }
  };

  const rawTarget = rawContextCreatorOllamaTarget(settings);
  if (rawTarget) {
    await probeOllama(rawTarget.model, rawTarget.endpoint);
  }

  let route = resolveContextCreatorRoute(fallback);
  let routeIsStable = false;
  for (let transition = 0; transition < 3; transition += 1) {
    if (route.provider === "ollama") {
      await probeOllama(route.model, route.effectiveSettings.ollamaEndpoint);
    }
    const nextRoute = resolveContextCreatorRoute(fallback);
    if (
      resolvedChatTurnRouteAuthorityKey(nextRoute) ===
      resolvedChatTurnRouteAuthorityKey(route)
    ) {
      route = nextRoute;
      routeIsStable = true;
      break;
    }
    route = nextRoute;
  }
  if (!routeIsStable) {
    throw new Error(
      "Context Creator model selection did not stabilize during preflight",
    );
  }
  if (contextCreatorAuthorityKey(fallback) !== authority) {
    throw new Error("Context Creator model selection changed during preflight");
  }
  if (!route.capabilities.supportsTools) {
    throw new Error(
      `Context Creator requires tool support, but ${route.model} does not provide it.`,
    );
  }
  const stableRouteAuthority = resolvedChatTurnRouteAuthorityKey(route);
  await ensureTokenizer();
  if (contextCreatorAuthorityKey(fallback) !== authority) {
    throw new Error("Context Creator model selection changed during preflight");
  }
  if (
    resolvedChatTurnRouteAuthorityKey(resolveContextCreatorRoute(fallback)) !==
    stableRouteAuthority
  ) {
    throw new Error("Context Creator route changed during preflight");
  }

  const messages: AgentMessagePayload[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: instruction },
  ];

  const loopResult = await runAgentLoop({
    messages,
    tools: CREATOR_TOOLS,
    tokenBudget: TOOL_TOKEN_BUDGET,
    sendToLLM: (msgs, tools) => {
      if (
        blockIfPolicyOff("chat") ||
        blockIfUnlicensed() ||
        contextCreatorAuthorityKey(fallback) !== authority ||
        resolvedChatTurnRouteAuthorityKey(
          resolveContextCreatorRoute(fallback),
        ) !== stableRouteAuthority
      ) {
        throw new Error("Context Creator route changed during execution");
      }
      const fallbackSystemPrompt = msgs
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      const finalized = finalizeTurnPayload(
        {
          route,
          system: { fallback: fallbackSystemPrompt },
          messages: msgs,
          renderedConversationPayloads: renderAgentConversationPayloads(
            route,
            msgs,
          ),
          renderedToolPayloads: renderAgentToolPayloads(route, tools),
          envelopeTokens: 0,
          safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
        },
        countTokens,
      );
      return sendAgentMessage(
        msgs,
        tools,
        route.thinking,
        finalized.transport.systemCacheSegments,
        route.apiVariant,
        null,
        finalized.transport.systemVolatileTail,
        route.model,
        route.providerOverride,
        route.endpointId,
        route.outputBudget.requestMaxOutputTokens,
        route.provider,
        route.resolvedEndpointId,
        route.toolProtocol,
        route.resolvedOllamaEndpoint,
      );
    },
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
    model: route.model,
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
