import type { ResolvedTurnRoute } from "@/features/ai-context/finalizeTurnPayload";
import {
  resolveOutputBudgetPlan,
  type OutputBudgetPlan,
} from "@/features/ai-context/outputBudget";
import {
  buildThinkingParams,
  resolveModelCapabilities,
  type EffortLevel,
  type ModelCapabilities,
  type ThinkingDisplay,
  type ThinkingParams,
} from "../agent/modelLimits";
import { resolveToolProtocol } from "../toolProtocolParse";
import { isAinoveristV1Model } from "../aiNovelist";
import {
  getOpenaiCompatibleEndpoints,
  resolveActiveOpenaiCompatibleEndpoint,
  type AiProvider,
  type AiSettings,
} from "../types";

export interface TurnRouteCandidate {
  model?: string | null;
  provider?: AiProvider | null;
  apiVariant?: string | null;
  endpointId?: string | null;
}

export interface ResolveChatTurnRouteInput {
  surface: "chat" | "agent";
  activeSettings: AiSettings;
  activeApiVariant?: string | null;
  /** Composer selection is explicit user intent and wins over role routing. */
  composer?: TurnRouteCandidate | null;
  role?: TurnRouteCandidate | null;
  taskEffort: EffortLevel;
  thinkingDisplay?: ThinkingDisplay;
  thinkingEnabled?: boolean;
  reasoningEffortOverride?: "low" | "medium" | "high";
}

export interface ResolvedChatTurnRoute extends ResolvedTurnRoute {
  source: "composer" | "role" | "active";
  /** Explicit cross-provider override; null keeps the active provider. */
  providerOverride: AiProvider | null;
  /** Effective endpoint pinned at route resolution time. */
  resolvedEndpointId: string | null;
  endpointId: string | null;
  capabilities: ModelCapabilities;
  thinking: ThinkingParams;
  outputBudget: OutputBudgetPlan;
  effectiveSettings: AiSettings;
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Freeze the effective provider/model/variant/capabilities before context work.
 * Every downstream consumer receives this snapshot instead of re-reading stores.
 */
export function resolveChatTurnRoute(
  input: ResolveChatTurnRouteInput,
): ResolvedChatTurnRoute {
  const composerModel = nonEmpty(input.composer?.model);
  const roleModel = nonEmpty(input.role?.model);
  const source = composerModel ? "composer" : roleModel ? "role" : "active";
  const selected =
    source === "composer"
      ? input.composer
      : source === "role"
        ? input.role
        : null;
  const provider = selected?.provider ?? input.activeSettings.provider;
  const model =
    (source === "active"
      ? input.activeSettings.provider === "cli"
        ? (nonEmpty(input.activeSettings.cli?.model) ??
          nonEmpty(input.activeSettings.model))
        : nonEmpty(input.activeSettings.model)
      : nonEmpty(selected?.model)) ?? "";
  const endpointId = selected?.endpointId ?? null;
  const requestedEndpointKnown =
    provider === "openai-compatible" &&
    endpointId !== null &&
    getOpenaiCompatibleEndpoints(input.activeSettings).some(
      (endpoint) => endpoint.id === endpointId,
    );
  const resolvedEndpoint =
    provider === "openai-compatible"
      ? resolveActiveOpenaiCompatibleEndpoint(
          input.activeSettings,
          requestedEndpointKnown ? endpointId : null,
        )
      : undefined;

  const effectiveSettings: AiSettings = {
    ...input.activeSettings,
    provider,
    model,
    ...(provider === "openai-compatible" && resolvedEndpoint
      ? { activeOpenaiCompatibleEndpointId: resolvedEndpoint.id }
      : {}),
  };
  let apiVariant =
    source === "active" || selected?.provider == null
      ? (selected?.apiVariant ?? input.activeApiVariant ?? null)
      : (selected.apiVariant ?? null);
  if (model === "openrouter/fusion") {
    apiVariant = null;
  } else if (apiVariant === null && provider === "openai-compatible") {
    apiVariant = resolvedEndpoint?.apiVariant ?? null;
  } else if (apiVariant === null && provider === "ai-novelist") {
    apiVariant = isAinoveristV1Model(model) ? "v1" : "legacy";
  }
  const capabilities = resolveModelCapabilities(
    model,
    effectiveSettings,
    apiVariant,
  );
  const thinking = buildThinkingParams(
    model,
    input.taskEffort,
    input.thinkingDisplay ?? "summarized",
    input.thinkingEnabled ?? effectiveSettings.thinkingEnabled,
    effectiveSettings,
    apiVariant,
    input.reasoningEffortOverride ??
      effectiveSettings.reasoningEffortOverride ??
      undefined,
  );
  const outputBudget = resolveOutputBudgetPlan({
    provider,
    model,
    apiVariant,
    contextWindow: capabilities.contextWindow,
    modelMaxOutputTokens: capabilities.maxOutputTokens,
    thinking,
  });
  const responsesRoute =
    apiVariant === "responses" &&
    ["openai", "openai-compatible", "openrouter", "sakana"].includes(provider);
  const route: ResolvedChatTurnRoute = {
    source,
    providerOverride: selected?.provider ?? null,
    resolvedEndpointId: resolvedEndpoint?.id ?? null,
    surface: input.surface,
    provider,
    model,
    apiVariant,
    endpointId,
    capabilities,
    thinking,
    // Rust dispatches Responses before the Hermes adapter. Normalize that
    // precedence here so budget materialization matches the actual wire.
    toolProtocol: responsesRoute
      ? "native"
      : resolveToolProtocol(
          provider,
          model,
          effectiveSettings.toolProtocolMode ?? "auto",
        ),
    contextWindow: capabilities.contextWindow,
    // CLI has no wire max. The conservative policy reservation is still used
    // by the final input guard and is explicitly marked non-exact in outputBudget.
    wireOutputTokens:
      outputBudget.requestMaxOutputTokens ??
      outputBudget.responseReservationTokens,
    outputBudget,
    effectiveSettings,
  };
  return Object.freeze(route);
}
