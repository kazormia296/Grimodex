import type { AiProvider } from "@/features/chat/types";

export type TurnSurface = "chat" | "agent";
export type TurnToolProtocol = "native" | "hermes";

export interface ResolvedTurnRoute {
  surface: TurnSurface;
  provider: AiProvider;
  model: string;
  apiVariant: string | null;
  toolProtocol: TurnToolProtocol;
  contextWindow: number;
  /** Exact request limit placed on the provider wire for HTTP routes. */
  wireOutputTokens: number;
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
