import type { ChatContextPreparationInput } from "./chatContextPreparation";
import {
  getChatApiVariant,
  getCrossProviderChatOverride,
} from "./chatTurnRouting";
import {
  finalizeTurnPayload,
  selectsCacheSystemDelivery,
} from "@/features/ai-context/finalizeTurnPayload";
import {
  createContextWindowUsage,
  type ContextWindowUsage,
} from "@/features/ai-context/contextWindowUsage";
import type { InputTokenRouteSnapshot } from "@/features/ai-usage/inputTokenDrift";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
  WebSearchConfig,
} from "@/features/chat/agent/agentTypes";
import { resolveModelCapabilities } from "@/features/chat/agent/modelLimits";
import { countTokens } from "@/features/chat/contextBuilder";
import { resolveRolePathConfig } from "@/features/chat/modelRouting";
import { useAiSettingsStore } from "@/features/chat/store";
import { stripToolProtocol } from "@/features/chat/toolProtocol";
import {
  renderAgentConversationPayloads,
  renderAgentToolPayloads,
} from "@/features/chat/turn/renderAgentPayload";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";

/**
 * 会話履歴を CLI に渡す単一プロンプトに平坦化する。
 * CLI (claude -p / codex exec / opencode run) は単一プロンプト引数しか
 * 受け付けないため、role タグ付きで連結する。
 */
export function flattenMessagesForCli(
  messages: { role: string; content: string }[],
): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

export const TURN_PAYLOAD_SAFETY_MARGIN_TOKENS = 32;

export function estimateMessageEnvelopeTokens(
  messages: ReadonlyArray<{ role: string; content: string }>,
): number {
  // Provider tokenizers account for role/message boundaries differently. Keep
  // this explicit and conservative; exact text content is measured separately.
  return messages.length * 4 + (messages.length > 0 ? 2 : 0);
}

export function estimateContextWindowUsage(input: {
  route: ResolvedChatTurnRoute | null | undefined;
  contextTokens: number;
  messages: ReadonlyArray<{ role: string; content: string }>;
  /** Defined (including an empty list) when the provider uses the Agent path. */
  tools?: AgentToolDefinition[];
  webSearch?: WebSearchConfig | null;
  estimated: boolean;
}): ContextWindowUsage | null {
  if (!input.route) return null;

  let toolTokens = 0;
  let envelopeTokens: number;
  if (input.tools !== undefined) {
    toolTokens = renderAgentToolPayloads(
      input.route,
      input.tools,
      input.webSearch,
    ).reduce((sum, payload) => sum + countTokens(payload), 0);
    const agentMessages = input.messages.flatMap<AgentMessagePayload>(
      (message) => {
        if (message.role === "user") {
          return [{ role: "user", content: message.content }];
        }
        if (message.role === "assistant") {
          return [
            {
              role: "assistant",
              content: stripToolProtocol(message.content),
            },
          ];
        }
        return [];
      },
    );
    const rawConversationTokens = agentMessages.reduce(
      (sum, message) => sum + countTokens(message.content),
      0,
    );
    const renderedConversationTokens = renderAgentConversationPayloads(
      input.route,
      agentMessages,
    ).reduce((sum, payload) => sum + countTokens(payload), 0);
    envelopeTokens = Math.max(
      0,
      renderedConversationTokens - rawConversationTokens,
    );
  } else {
    envelopeTokens = estimateMessageEnvelopeTokens([
      ...(input.contextTokens > 0 ? [{ role: "system", content: "" }] : []),
      ...input.messages,
    ]);
  }

  return createContextWindowUsage({
    contextTokens: input.contextTokens,
    toolTokens,
    envelopeTokens,
    safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
    outputReservedTokens: input.route.wireOutputTokens,
    contextWindow: input.route.contextWindow,
    estimated: input.estimated,
  });
}

export function estimateContextInputOverhead(input: {
  route: ResolvedChatTurnRoute | null | undefined;
  messages: ReadonlyArray<{ role: string; content: string }>;
  tools?: AgentToolDefinition[];
  webSearch?: WebSearchConfig | null;
}): number | undefined {
  // A one-token placeholder makes plain-chat framing include the system
  // message. Remove it again so only non-context request overhead is returned.
  const usage = estimateContextWindowUsage({
    ...input,
    contextTokens: 1,
    estimated: true,
  });
  return usage ? usage.inputTokens - 1 + usage.safetyMarginTokens : undefined;
}

export function resolveContextPreparationBudget(input: {
  mode: "chat" | "agent";
  route: ResolvedChatTurnRoute | null;
  inputOverheadTokens?: number;
}): ChatContextPreparationInput["budget"] {
  const aiState = useAiSettingsStore.getState();
  const aiSettings = aiState.settings;
  const crossProvider = getCrossProviderChatOverride();
  const role = aiState.chatModelOverride
    ? undefined
    : resolveRolePathConfig(
        input.mode === "agent" ? "chat_agent_main" : "chat_stream_non_agent",
        undefined,
        aiSettings?.provider,
      );
  const model =
    input.route?.model ??
    aiState.chatModelOverride ??
    role?.model ??
    aiSettings?.model ??
    "";
  const provider =
    input.route?.provider ??
    (aiState.chatModelOverride
      ? (crossProvider?.provider ?? aiSettings?.provider)
      : (role?.provider ?? aiSettings?.provider));
  const capabilitySettings =
    aiSettings && provider
      ? {
          ...aiSettings,
          provider,
          model,
          ...(crossProvider?.endpointId
            ? {
                activeOpenaiCompatibleEndpointId: crossProvider.endpointId,
              }
            : {}),
        }
      : aiSettings;
  const fallbackCapabilities = resolveModelCapabilities(
    model,
    capabilitySettings,
    input.route?.apiVariant ??
      crossProvider?.variant ??
      role?.variant ??
      getChatApiVariant(model),
  );
  return {
    contextWindow:
      input.route?.contextWindow ?? fallbackCapabilities.contextWindow,
    maxOutputTokens:
      input.route?.capabilities.maxOutputTokens ??
      fallbackCapabilities.maxOutputTokens,
    responseReservationTokens:
      input.route?.outputBudget.responseReservationTokens,
    inputOverheadTokens: input.inputOverheadTokens,
    deliveryMode:
      input.route && selectsCacheSystemDelivery(input.route)
        ? "cache"
        : "plain",
  };
}

export function finalizeChatTurnPayload(input: {
  route: ResolvedChatTurnRoute;
  fallbackSystemPrompt: string;
  cacheSegments?: string[];
  volatileTail?: string;
  messages: AgentMessagePayload[] | Array<{ role: string; content: string }>;
  tools?: AgentToolDefinition[];
  webSearch?: WebSearchConfig | null;
}) {
  const isAgentPayload = input.tools !== undefined;
  const renderedToolPayloads = isAgentPayload
    ? renderAgentToolPayloads(input.route, input.tools ?? [], input.webSearch)
    : input.webSearch?.enabled
      ? [JSON.stringify(input.webSearch)]
      : [];
  const renderedConversationPayloads = isAgentPayload
    ? renderAgentConversationPayloads(
        input.route,
        input.messages as AgentMessagePayload[],
      )
    : undefined;
  return finalizeTurnPayload(
    {
      route: input.route,
      system: {
        fallback: input.fallbackSystemPrompt,
        cacheSegments: input.cacheSegments,
        volatileTail: input.volatileTail,
      },
      messages: input.messages,
      renderedConversationPayloads,
      renderedToolPayloads,
      envelopeTokens: isAgentPayload
        ? 0
        : estimateMessageEnvelopeTokens(input.messages),
      safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
    },
    countTokens,
  );
}

export function materializeSystemDeliverySnapshot(
  finalized: ReturnType<typeof finalizeChatTurnPayload>,
): string {
  return finalized.systemDelivery.kind === "plain"
    ? finalized.systemDelivery.text
    : finalized.systemDelivery.blocks.map((block) => block.text).join("");
}

export function snapshotInputTokenRoute(
  route: ResolvedChatTurnRoute,
): InputTokenRouteSnapshot {
  return {
    surface: route.surface,
    provider: route.provider,
    model: route.model,
    apiVariant: route.apiVariant,
    requestedEndpointId: route.endpointId,
    resolvedEndpointId: route.resolvedEndpointId,
    toolProtocol: route.toolProtocol,
    contextWindow: route.contextWindow,
  };
}
