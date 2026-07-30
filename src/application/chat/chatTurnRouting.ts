import { resolveAgentPrivacyPlan } from "@/features/chat/agent/agentPrivacy";
import { getEffortForTask } from "@/features/chat/agent/modelLimits";
import type { WebSearchConfig } from "@/features/chat/agent/agentTypes";
import { resolveSendApiVariant } from "@/features/chat/aiNovelist";
import {
  parseRoleProviders,
  resolveRoleModel,
  resolveRolePathConfig,
  roleSettingKey,
  ROLE_PROVIDERS_KEY,
} from "@/features/chat/modelRouting";
import {
  isRagCapableProvider,
  useAiSettingsStore,
} from "@/features/chat/store";
import type { AiProvider } from "@/features/chat/types";
import {
  resolveChatTurnRoute,
  type ResolvedChatTurnRoute,
} from "@/features/chat/turn/resolveTurnRoute";
import {
  buildWebSearchConfig,
  parseWebSearchControls,
} from "@/features/chat/webSearchConfig";
import { useSettingsStore } from "@/features/settings/settingsStore";

export function getChatApiVariant(model: string): string | undefined {
  const { settings, models } = useAiSettingsStore.getState();
  return resolveSendApiVariant(settings, models, model);
}

/**
 * composer のモデルピッカーで「別プロバイダ」のモデルを選んだ場合の override を返す。
 * cross-provider override は provider/model/variant を一括で決め、per-role routing より
 * 優先する(明示的かつ即時のユーザー選択で、provider と model の名前空間整合を保つため)。
 * 同一プロバイダ内の一時モデル(chatProviderOverride==null)や未選択時は null を返し、
 * 呼び出し側は従来ロジック(role routing / getChatApiVariant)に委ねる(= 回帰なし)。
 *
 * variant は選択時に resolveModelApiVariant で確定済みの値(active provider の models へ
 * 依存しない)。null は backend 既定解決を意味するため undefined に正規化して返す。
 */
export function getCrossProviderChatOverride(): {
  provider: AiProvider;
  model: string;
  variant: string | undefined;
  /**
   * OpenAI 互換で別エンドポイントのモデルを選んだ場合の endpoint id。
   * provider は "openai-compatible" のまま（同一プロバイダの別サーバ）でも、この値で
   * 送信先 base_url / API キーを切り替える。他プロバイダ選択時は undefined。
   */
  endpointId: string | undefined;
} | null {
  const st = useAiSettingsStore.getState();
  const provider = st.chatProviderOverride;
  const model = st.chatModelOverride;
  if (!provider || !model) return null;
  return {
    provider,
    model,
    variant: st.chatModelVariantOverride ?? undefined,
    endpointId: st.chatEndpointIdOverride ?? undefined,
  };
}

export interface AgentPreflightTarget {
  provider: AiProvider | undefined;
  model: string;
  ollamaEndpoint: string;
}

export interface AgentPreflightAuthority {
  settings: string;
  chatModelOverride: string | null;
  chatProviderOverride: AiProvider | null;
  chatModelVariantOverride: string | null;
  chatEndpointIdOverride: string | null;
  agentRoleModel: string;
  conversationRoleModel: string;
  roleProviders: string;
}

/**
 * Resolve only the provider/model identity needed by the Ollama metadata
 * preflight. It is intentionally recomputed after the await so a composer,
 * settings, or role-route change cannot send with another model's observation.
 */
export function resolveAgentPreflightTarget(): AgentPreflightTarget {
  const aiState = useAiSettingsStore.getState();
  const settings = aiState.settings;
  const crossProvider = getCrossProviderChatOverride();
  const composerModel = aiState.chatModelOverride;
  const agentRole = resolveRolePathConfig(
    "chat_agent_main",
    undefined,
    settings?.provider,
  );
  return {
    provider: composerModel
      ? (crossProvider?.provider ?? settings?.provider)
      : (agentRole?.provider ?? settings?.provider),
    model: composerModel
      ? composerModel
      : (agentRole?.model ?? settings?.model ?? ""),
    ollamaEndpoint: settings?.ollamaEndpoint?.trim() ?? "",
  };
}

/**
 * The first selected-model `/api/show` probe deliberately bypasses the cached
 * capability gate. A tag may have been replaced since a previous no-tools
 * observation, and the selected model endpoint is the authority that can make
 * the Agent role eligible again.
 */
export function resolveRawAgentPreflightTarget(): AgentPreflightTarget {
  const aiState = useAiSettingsStore.getState();
  const settings = aiState.settings;
  const crossProvider = getCrossProviderChatOverride();
  const composerModel = aiState.chatModelOverride;
  if (composerModel) {
    return {
      provider: crossProvider?.provider ?? settings?.provider,
      model: composerModel,
      ollamaEndpoint: settings?.ollamaEndpoint?.trim() ?? "",
    };
  }

  const settingsState = useSettingsStore.getState();
  const roleModel = resolveRoleModel("agent");
  const roleProvider = parseRoleProviders(
    settingsState.get(ROLE_PROVIDERS_KEY, ""),
  ).agent?.provider?.trim() as AiProvider | undefined;
  return {
    provider: roleModel
      ? (roleProvider ?? settings?.provider)
      : settings?.provider,
    model: roleModel ?? settings?.model ?? "",
    ollamaEndpoint: settings?.ollamaEndpoint?.trim() ?? "",
  };
}

export function resolveConversationPreflightTarget(): AgentPreflightTarget {
  const aiState = useAiSettingsStore.getState();
  const settings = aiState.settings;
  const crossProvider = getCrossProviderChatOverride();
  const composerModel = aiState.chatModelOverride;
  const conversationRole = resolveRolePathConfig(
    "chat_stream_non_agent",
    undefined,
    settings?.provider,
  );
  return {
    provider: composerModel
      ? (crossProvider?.provider ?? settings?.provider)
      : (conversationRole?.provider ?? settings?.provider),
    model: composerModel
      ? composerModel
      : (conversationRole?.model ?? settings?.model ?? ""),
    ollamaEndpoint: settings?.ollamaEndpoint?.trim() ?? "",
  };
}

export function resolveCurrentPreflightRoute(
  surface: "chat" | "agent",
): ResolvedChatTurnRoute | null {
  const aiState = useAiSettingsStore.getState();
  if (!aiState.settings) return null;
  const crossProvider = getCrossProviderChatOverride();
  const composerModel = aiState.chatModelOverride;
  const role = resolveRolePathConfig(
    surface === "agent" ? "chat_agent_main" : "chat_stream_non_agent",
    undefined,
    aiState.settings.provider,
  );
  return resolveChatTurnRoute({
    surface,
    activeSettings: aiState.settings,
    activeApiVariant: getChatApiVariant(aiState.settings.model),
    composer: composerModel
      ? {
          model: composerModel,
          provider: crossProvider?.provider ?? null,
          apiVariant: crossProvider
            ? (crossProvider.variant ?? null)
            : (getChatApiVariant(composerModel) ?? null),
          endpointId: crossProvider?.endpointId ?? null,
        }
      : null,
    role: role
      ? {
          model: role.model,
          provider: role.provider,
          apiVariant: role.provider
            ? role.variant
            : getChatApiVariant(role.model),
          endpointId: role.endpointId,
        }
      : null,
    taskEffort: getEffortForTask(surface),
    thinkingDisplay: "summarized",
    thinkingEnabled: aiState.settings.thinkingEnabled,
    reasoningEffortOverride:
      aiState.settings.reasoningEffortOverride ?? undefined,
  });
}

export interface ChatTurnRoutePolicy {
  route: ResolvedChatTurnRoute | null;
  ragActive: boolean;
  agentToolsSuppressed: boolean;
  useAgentPath: boolean;
  publicWebSearchPath: boolean;
}

export function resolveChatTurnRoutePolicy(input: {
  agentMode: boolean;
  ragEnabled: boolean;
  resolveRouteForSurface: (
    surface: "chat" | "agent",
  ) => ResolvedChatTurnRoute | null;
}): ChatTurnRoutePolicy {
  let route = input.resolveRouteForSurface(input.agentMode ? "agent" : "chat");
  let ragActive =
    !input.agentMode &&
    input.ragEnabled &&
    isRagCapableProvider(route?.provider) &&
    route?.model !== "openrouter/fusion";
  if (ragActive) {
    const agentCandidate = input.resolveRouteForSurface("agent");
    if (
      isRagCapableProvider(agentCandidate?.provider) &&
      agentCandidate?.model !== "openrouter/fusion"
    ) {
      route = agentCandidate;
    } else {
      ragActive = false;
    }
  }
  let agentToolsSuppressed = false;
  if (
    (input.agentMode || ragActive) &&
    route?.capabilities.supportsTools === false
  ) {
    agentToolsSuppressed = true;
    route = input.resolveRouteForSurface("chat");
    if (input.agentMode && route?.provider === "ollama") {
      route = Object.freeze({
        ...route,
        requiresEffectiveOllamaContext: true,
      });
    }
    ragActive = false;
  }
  const isFusionModel = route?.model === "openrouter/fusion";
  const useAgentPath =
    (input.agentMode || ragActive) &&
    !agentToolsSuppressed &&
    route?.provider !== "cli" &&
    route?.capabilities.supportsTools !== false &&
    !isFusionModel;
  return {
    route,
    ragActive,
    agentToolsSuppressed,
    useAgentPath,
    publicWebSearchPath: !input.agentMode && ragActive && useAgentPath,
  };
}

/** Mirror sendMessage's route policy for ContextBar and prompt previews. */
export function resolveCurrentChatTurnPolicy(input: {
  agentMode: boolean;
  ragEnabled: boolean;
}): ChatTurnRoutePolicy {
  return resolveChatTurnRoutePolicy({
    ...input,
    resolveRouteForSurface: resolveCurrentPreflightRoute,
  });
}

export function resolveCurrentTurnWebSearchConfig(input: {
  agentMode: boolean;
  ragActive: boolean;
}): WebSearchConfig | null {
  const settingsState = useSettingsStore.getState();
  const controls = parseWebSearchControls({
    domainMode: settingsState.get("ai.webSearch.domainMode", "off"),
    domainsJson: settingsState.get("ai.webSearch.domains", "[]"),
    maxContentTokensRaw: settingsState.get("ai.webSearch.maxContentTokens", ""),
  });
  return resolveAgentPrivacyPlan({
    ...input,
    webSearchConfig: buildWebSearchConfig(
      input.ragActive,
      input.agentMode,
      controls,
    ),
  }).webSearchConfig;
}

export function resolveCurrentChatDisplayRoute(input: {
  agentMode: boolean;
  ragEnabled: boolean;
}): ResolvedChatTurnRoute | null {
  return resolveCurrentChatTurnPolicy(input).route;
}

/** Whether enabling RAG would actually select the public Web-search path. */
export function canUseCurrentChatPublicRag(): boolean {
  return resolveCurrentChatTurnPolicy({
    agentMode: false,
    ragEnabled: true,
  }).publicWebSearchPath;
}

export function captureAgentPreflightAuthority(): AgentPreflightAuthority {
  const aiState = useAiSettingsStore.getState();
  const settingsState = useSettingsStore.getState();
  return {
    // Includes the active OpenAI-compatible endpoint id and every endpoint
    // definition (base URL, variant and custom limits). A same-name model on a
    // different server is a different send authority.
    settings: JSON.stringify(aiState.settings) ?? "null",
    chatModelOverride: aiState.chatModelOverride,
    chatProviderOverride: aiState.chatProviderOverride,
    chatModelVariantOverride: aiState.chatModelVariantOverride,
    chatEndpointIdOverride: aiState.chatEndpointIdOverride,
    agentRoleModel: settingsState.get(roleSettingKey("agent"), ""),
    conversationRoleModel: settingsState.get(
      roleSettingKey("conversation"),
      "",
    ),
    roleProviders: settingsState.get(ROLE_PROVIDERS_KEY, ""),
  };
}

export function isSameAgentPreflightAuthority(
  left: AgentPreflightAuthority,
  right: AgentPreflightAuthority,
): boolean {
  return (
    left.settings === right.settings &&
    left.chatModelOverride === right.chatModelOverride &&
    left.chatProviderOverride === right.chatProviderOverride &&
    left.chatModelVariantOverride === right.chatModelVariantOverride &&
    left.chatEndpointIdOverride === right.chatEndpointIdOverride &&
    left.agentRoleModel === right.agentRoleModel &&
    left.conversationRoleModel === right.conversationRoleModel &&
    left.roleProviders === right.roleProviders
  );
}
