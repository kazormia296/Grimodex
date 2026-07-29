import type { AiProvider } from "@/features/chat/types";

export type TurnSurface = "chat" | "agent";
export type TurnToolProtocol = "native" | "hermes";
export type ChatTransport = "http" | "cli-exec" | "codex-app-server";

export interface ResolvedTurnRoute {
  surface: TurnSurface;
  provider: AiProvider;
  model: string;
  apiVariant: string | null;
  toolProtocol: TurnToolProtocol;
  contextWindow: number;
  /** Provider-advertised model maximum; may differ from a local runtime allocation. */
  modelContextWindow?: number;
  /** Whether contextWindow is the effective limit for this exact route. */
  contextWindowIsEffective?: boolean;
  /** Diagnostic provenance for contextWindow. */
  contextWindowSource?: string;
  /**
   * An Agent-origin turn that fell back to plain chat still requires an exact
   * Ollama runner allocation before local validation/HTTP dispatch.
   */
  requiresEffectiveOllamaContext?: boolean;
  /** Exact request limit placed on the provider wire for HTTP routes. */
  wireOutputTokens: number;
  /** Internal transport selected for this turn. Legacy fixtures may omit it. */
  transport?: ChatTransport;
}

export interface SystemPayloadCandidate {
  /** Full system text used by plain/Responses/Hermes routes. */
  fallback: string;
  /** Stable text blocks eligible for Anthropic prompt caching. */
  cacheSegments?: string[];
  /** Non-cacheable text appended after cache segments. */
  volatileTail?: string;
}

export interface PayloadMessage {
  role: string;
  content: string;
}

export interface FinalizeTurnPayloadInput {
  route: ResolvedTurnRoute;
  system: SystemPayloadCandidate;
  messages: PayloadMessage[];
  /** Provider-materialized non-system messages (Agent tool/thinking history). */
  renderedConversationPayloads?: string[];
  /** Already-rendered tool schemas/protocol preambles/results not present in messages. */
  renderedToolPayloads?: string[];
  /** Provider/message framing estimate supplied by the route adapter. */
  envelopeTokens?: number;
  /** Conservative tokenizer/provider drift guard. */
  safetyMarginTokens?: number;
}

export type SystemDelivery =
  | { kind: "plain"; text: string }
  | {
      kind: "cache-blocks";
      blocks: Array<{
        text: string;
        cacheControl?: "ephemeral";
      }>;
    };

export interface TurnPayloadUsage {
  systemTokens: number;
  conversationTokens: number;
  toolTokens: number;
  envelopeTokens: number;
  safetyMarginTokens: number;
  inputTokens: number;
  outputReservedTokens: number;
  reservedTotalTokens: number;
  remainingTokens: number;
}

export interface FinalizedTurnPayload {
  route: ResolvedTurnRoute;
  systemDelivery: SystemDelivery;
  transport: {
    systemCacheSegments?: string[];
    systemVolatileTail?: string;
  };
  usage: TurnPayloadUsage;
  cacheDowngradeReason?: "budget" | "too-many-blocks";
}

export type TokenCounter = (text: string) => number;

export class ContextWindowExceededError extends Error {
  readonly code = "AI_CONTEXT_WINDOW_EXCEEDED" as const;
  readonly overflowTokens: number;
  readonly usage: TurnPayloadUsage;

  constructor(usage: TurnPayloadUsage) {
    const overflowTokens = Math.max(0, -usage.remainingTokens);
    super(
      `AI context window exceeded by ${overflowTokens.toLocaleString()} tokens`,
    );
    this.name = "ContextWindowExceededError";
    this.overflowTokens = overflowTokens;
    this.usage = usage;
  }
}

export class OllamaContextWindowUnknownError extends Error {
  readonly code = "OLLAMA_CONTEXT_WINDOW_UNKNOWN" as const;
  readonly usage: TurnPayloadUsage;
  readonly requiredTokens: number;
  readonly modelContextWindow: number | null;

  constructor(route: ResolvedTurnRoute, usage: TurnPayloadUsage) {
    const modelMaximumKnown =
      route.contextWindowSource !== "default" &&
      Number.isSafeInteger(route.modelContextWindow) &&
      (route.modelContextWindow ?? 0) > 0;
    const modelContextWindow = modelMaximumKnown
      ? (route.modelContextWindow ?? null)
      : null;
    const maximumLabel =
      modelContextWindow === null
        ? "unknown"
        : `${modelContextWindow.toLocaleString()} tokens`;
    super(
      `Ollama context allocation is unknown for ${route.model}. ` +
        `This request requires ${usage.reservedTotalTokens.toLocaleString()} tokens; ` +
        `${formatUsageBreakdown(usage)} The model maximum is ${maximumLabel}. ` +
        "Load the model so Grimodex can inspect " +
        "the runner allocation. If automatic detection is unavailable, first set " +
        "Ollama via Modelfile PARAMETER num_ctx or OLLAMA_CONTEXT_LENGTH and reload " +
        "the model, then set the Grimodex fallback to that same verified value.",
    );
    this.name = "OllamaContextWindowUnknownError";
    this.usage = usage;
    this.requiredTokens = usage.reservedTotalTokens;
    this.modelContextWindow = modelContextWindow;
  }
}

export class OllamaContextWindowTooSmallError extends Error {
  readonly code = "OLLAMA_CONTEXT_WINDOW_TOO_SMALL" as const;
  readonly usage: TurnPayloadUsage;
  readonly overflowTokens: number;
  readonly limitKind: "effective" | "model-maximum";
  readonly availableContextWindow: number;
  readonly modelContextWindow: number | null;

  constructor(
    route: ResolvedTurnRoute,
    usage: TurnPayloadUsage,
    limitKind: "effective" | "model-maximum",
  ) {
    const overflowTokens = Math.max(0, -usage.remainingTokens);
    const modelContextWindow =
      Number.isSafeInteger(route.modelContextWindow) &&
      (route.modelContextWindow ?? 0) > 0
        ? (route.modelContextWindow ?? null)
        : null;
    const maximumDetail =
      modelContextWindow === null
        ? ""
        : ` (model maximum ${modelContextWindow.toLocaleString()})`;
    const remedy =
      limitKind === "effective"
        ? "Increase Ollama via Modelfile PARAMETER num_ctx or OLLAMA_CONTEXT_LENGTH, " +
          "reload the model, then refresh Grimodex. Only set the Grimodex fallback " +
          "to the same verified effective value."
        : "Use a model with a larger context window or reduce the Agent payload.";
    super(
      `Ollama ${limitKind === "effective" ? "effective" : "model maximum"} ` +
        `context window is ${route.contextWindow.toLocaleString()} tokens${maximumDetail}, ` +
        `but this request requires ${usage.reservedTotalTokens.toLocaleString()} tokens. ` +
        `${formatUsageBreakdown(usage)} ${remedy}`,
    );
    this.name = "OllamaContextWindowTooSmallError";
    this.usage = usage;
    this.overflowTokens = overflowTokens;
    this.limitKind = limitKind;
    this.availableContextWindow = route.contextWindow;
    this.modelContextWindow = modelContextWindow;
  }
}

function formatUsageBreakdown(usage: TurnPayloadUsage): string {
  const promptAndHistory = usage.systemTokens + usage.conversationTokens;
  const parts = [
    `prompt/history ${promptAndHistory.toLocaleString()}`,
    ...(usage.toolTokens > 0
      ? [`Agent tools ${usage.toolTokens.toLocaleString()}`]
      : []),
    ...(usage.envelopeTokens > 0
      ? [`message framing ${usage.envelopeTokens.toLocaleString()}`]
      : []),
    `output reserve ${usage.outputReservedTokens.toLocaleString()}`,
    ...(usage.safetyMarginTokens > 0
      ? [`safety margin ${usage.safetyMarginTokens.toLocaleString()}`]
      : []),
  ];
  return `Breakdown: ${parts.join("; ")}.`;
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function usesResponsesApi(route: ResolvedTurnRoute): boolean {
  return (
    route.apiVariant === "responses" &&
    ["openai", "openai-compatible", "openrouter", "sakana"].includes(
      route.provider,
    )
  );
}

export function selectsCacheSystemDelivery(route: ResolvedTurnRoute): boolean {
  if (usesResponsesApi(route)) return false;
  if (route.surface === "agent" && route.toolProtocol === "hermes") {
    return false;
  }
  return (
    route.provider === "anthropic" ||
    (route.provider === "openrouter" && route.model.includes("claude"))
  );
}

function countDelivery(
  delivery: SystemDelivery,
  countTokens: TokenCounter,
): number {
  return delivery.kind === "plain"
    ? countTokens(delivery.text)
    : delivery.blocks.reduce((sum, block) => sum + countTokens(block.text), 0);
}

function buildUsage(
  input: FinalizeTurnPayloadInput,
  systemDelivery: SystemDelivery,
  countTokens: TokenCounter,
): TurnPayloadUsage {
  const envelopeTokens = input.envelopeTokens ?? 0;
  const safetyMarginTokens = input.safetyMarginTokens ?? 0;
  const systemTokens = countDelivery(systemDelivery, countTokens);
  // The system candidate is measured separately because cache-capable providers
  // discard the fallback system message. Other system messages are likewise
  // excluded here so the same bytes are never counted twice.
  const conversationTokens = input.renderedConversationPayloads
    ? input.renderedConversationPayloads.reduce(
        (sum, payload) => sum + countTokens(payload),
        0,
      )
    : input.messages
        .filter((message) => message.role !== "system")
        .reduce((sum, message) => sum + countTokens(message.content), 0);
  const toolTokens = (input.renderedToolPayloads ?? []).reduce(
    (sum, payload) => sum + countTokens(payload),
    0,
  );
  const inputTokens =
    systemTokens + conversationTokens + toolTokens + envelopeTokens;
  const reservedTotalTokens =
    inputTokens + input.route.wireOutputTokens + safetyMarginTokens;
  return {
    systemTokens,
    conversationTokens,
    toolTokens,
    envelopeTokens,
    safetyMarginTokens,
    inputTokens,
    outputReservedTokens: input.route.wireOutputTokens,
    reservedTotalTokens,
    remainingTokens: input.route.contextWindow - reservedTotalTokens,
  };
}

function buildPlainDelivery(system: SystemPayloadCandidate): SystemDelivery {
  return { kind: "plain", text: system.fallback };
}

function buildCacheDelivery(
  system: SystemPayloadCandidate,
): SystemDelivery | null {
  const segments = (system.cacheSegments ?? []).filter(
    (segment) => segment.length > 0,
  );
  if (segments.length === 0 || segments.length > 4) return null;
  const blocks: Extract<SystemDelivery, { kind: "cache-blocks" }>["blocks"] =
    segments.map((text) => ({ text, cacheControl: "ephemeral" }));
  if (system.volatileTail) blocks.push({ text: system.volatileTail });
  return { kind: "cache-blocks", blocks };
}

/**
 * Materialize the provider-selected system representation and enforce the final
 * request budget against those exact text blocks. The counter remains injected
 * because provider tokenizers differ; the delivery bytes themselves are exact.
 */
export function finalizeTurnPayload(
  input: FinalizeTurnPayloadInput,
  countTokens: TokenCounter,
): FinalizedTurnPayload {
  requirePositiveSafeInteger(input.route.contextWindow, "contextWindow");
  requirePositiveSafeInteger(input.route.wireOutputTokens, "wireOutputTokens");
  requireNonNegativeSafeInteger(input.envelopeTokens ?? 0, "envelopeTokens");
  requireNonNegativeSafeInteger(
    input.safetyMarginTokens ?? 0,
    "safetyMarginTokens",
  );

  const plainDelivery = buildPlainDelivery(input.system);
  const cacheDelivery = selectsCacheSystemDelivery(input.route)
    ? buildCacheDelivery(input.system)
    : null;
  let systemDelivery = cacheDelivery ?? plainDelivery;
  let usage = buildUsage(input, systemDelivery, countTokens);
  let cacheDowngradeReason: FinalizedTurnPayload["cacheDowngradeReason"];

  if (cacheDelivery && usage.remainingTokens < 0) {
    const plainUsage = buildUsage(input, plainDelivery, countTokens);
    if (plainUsage.remainingTokens >= 0) {
      systemDelivery = plainDelivery;
      usage = plainUsage;
      cacheDowngradeReason = "budget";
    }
  } else if (
    selectsCacheSystemDelivery(input.route) &&
    (input.system.cacheSegments ?? []).filter(Boolean).length > 4
  ) {
    cacheDowngradeReason = "too-many-blocks";
  }

  if (input.route.provider === "ollama") {
    if (input.route.contextWindowIsEffective === false) {
      if (
        usage.remainingTokens < 0 &&
        input.route.contextWindowSource === "model-maximum"
      ) {
        throw new OllamaContextWindowTooSmallError(
          input.route,
          usage,
          "model-maximum",
        );
      }
      // A model maximum is never evidence of the allocation used by the
      // OpenAI-compatible Ollama runner. Both plain and Agent requests must use
      // `/api/ps`, Modelfile `num_ctx`, or the explicit verified fallback.
      throw new OllamaContextWindowUnknownError(input.route, usage);
    }
    if (
      input.route.contextWindowIsEffective === true &&
      usage.remainingTokens < 0
    ) {
      throw new OllamaContextWindowTooSmallError(
        input.route,
        usage,
        "effective",
      );
    }
  }

  if (usage.remainingTokens < 0) {
    throw new ContextWindowExceededError(usage);
  }

  const cacheBlocks =
    systemDelivery.kind === "cache-blocks"
      ? systemDelivery.blocks.filter(
          (block) => block.cacheControl === "ephemeral",
        )
      : [];
  const volatileBlock =
    systemDelivery.kind === "cache-blocks"
      ? systemDelivery.blocks.find((block) => block.cacheControl === undefined)
      : undefined;
  const usesCache = systemDelivery.kind === "cache-blocks";
  return {
    route: { ...input.route },
    systemDelivery,
    transport: usesCache
      ? {
          systemCacheSegments: cacheBlocks.map((block) => block.text),
          ...(volatileBlock ? { systemVolatileTail: volatileBlock.text } : {}),
        }
      : {},
    usage,
    ...(cacheDowngradeReason ? { cacheDowngradeReason } : {}),
  };
}
