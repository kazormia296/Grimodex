import type {
  ChatTransport,
  ResolvedTurnRoute,
} from "@/features/ai-context/finalizeTurnPayload";
import {
  resolveOutputBudgetPlan,
  type OutputBudgetPlan,
} from "@/features/ai-context/outputBudget";
import {
  buildThinkingParams,
  resolveModelCapabilities,
  type EffortLevel,
  type ModelCapabilities,
  type ModelContextWindowSource,
  type ThinkingDisplay,
  type ThinkingParams,
} from "../agent/modelLimits";
import { resolveToolProtocol } from "../toolProtocolParse";
import { isAinoveristV1Model } from "../aiNovelist";
import {
  getOpenaiCompatibleEndpoints,
  resolveActiveOpenaiCompatibleEndpoint,
  type CliTransport,
  type AiProvider,
  type AiSettings,
} from "../types";

export {
  createTurnControl,
  createTurnCoordinator,
  createTurnRequest,
} from "./turnCoordinator";
export type {
  TurnControl,
  TurnPhase,
  TurnRequest,
  TurnSurface,
  TurnTransport,
  TurnWorkspaceAuthority,
} from "./turnCoordinator";

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
  /** Ollama endpoint expected to remain configured through transport start. */
  resolvedOllamaEndpoint: string | null;
  endpointId: string | null;
  modelContextWindow: number;
  contextWindowIsEffective: boolean;
  contextWindowSource: ModelContextWindowSource;
  capabilities: ModelCapabilities;
  thinking: ThinkingParams;
  outputBudget: OutputBudgetPlan;
  effectiveSettings: AiSettings;
}

/**
 * Identity of every setting that can change the effective destination or the
 * local payload budget for a resolved turn. Provider/model alone is
 * insufficient: two OpenAI-compatible endpoints may expose the same bare
 * model id, and the same Ollama tag may be observed through different
 * endpoints or runner allocations.
 */
export function resolvedChatTurnRouteAuthorityKey(
  route: ResolvedChatTurnRoute | null | undefined,
): string | null {
  if (!route) return null;
  return JSON.stringify([
    route.surface,
    route.source,
    route.provider,
    route.providerOverride,
    route.model,
    route.transport,
    route.apiVariant,
    route.endpointId,
    route.resolvedEndpointId,
    route.resolvedOllamaEndpoint,
    route.toolProtocol,
    route.contextWindow,
    route.modelContextWindow,
    route.contextWindowIsEffective,
    route.contextWindowSource,
    route.capabilities,
    route.outputBudget,
    route.effectiveSettings,
  ]);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (
    parts.length !== 4 ||
    parts.some(
      (part) =>
        !/^\d{1,3}$/.test(part) || Number(part) < 0 || Number(part) > 255,
    )
  ) {
    return false;
  }
  const [first, second] = parts.map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  );
}

/** Whether the frozen route executes inference on this device or its LAN. */
export function isLocalInferenceRoute(
  route: ResolvedChatTurnRoute | null | undefined,
): boolean {
  if (!route) return false;
  if (route.provider === "ollama") return true;
  if (route.provider !== "openai-compatible") return false;
  const endpoint = resolveActiveOpenaiCompatibleEndpoint(
    route.effectiveSettings,
    route.resolvedEndpointId,
  );
  if (!endpoint?.baseUrl?.trim()) return false;
  try {
    const hostname = new URL(endpoint.baseUrl).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      isPrivateIpv4(hostname) ||
      isPrivateIpv6(hostname)
    );
  } catch {
    return false;
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function resolveTransport(
  provider: AiProvider,
  settings: AiSettings,
): ChatTransport {
  if (provider !== "cli") return "http";
  const cli = settings.cli;
  if (cli?.kind !== "codex") return "cli-exec";
  const selected: CliTransport = cli.codexTransport ?? "exec";
  return selected === "app-server" || selected === "auto"
    ? "codex-app-server"
    : "cli-exec";
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
    defaultVisibleOutputTokens: capabilities.defaultVisibleOutputTokens,
    defaultReasoningReservationTokens:
      capabilities.defaultReasoningReservationTokens,
    thinking,
  });
  const responsesRoute =
    apiVariant === "responses" &&
    ["openai", "openai-compatible", "openrouter", "sakana"].includes(provider);
  const route: ResolvedChatTurnRoute = {
    source,
    providerOverride: selected?.provider ?? null,
    resolvedEndpointId: resolvedEndpoint?.id ?? null,
    resolvedOllamaEndpoint:
      provider === "ollama"
        ? nonEmpty(input.activeSettings.ollamaEndpoint)
        : null,
    surface: input.surface,
    provider,
    model,
    transport: resolveTransport(provider, effectiveSettings),
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
    modelContextWindow: capabilities.modelContextWindow,
    contextWindowIsEffective: capabilities.contextWindowIsEffective,
    contextWindowSource: capabilities.contextWindowSource,
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
