import type { TurnPayloadUsage } from "./finalizeTurnPayload";

/**
 * ContextBar-facing projection of a provider request.
 *
 * `contextTokens` is the authored system/history/user material. The remaining
 * fields are request costs that were previously invisible in ContextBar even
 * though the final payload guard counted them.
 */
export interface ContextWindowUsage {
  contextTokens: number;
  toolTokens: number;
  envelopeTokens: number;
  safetyMarginTokens: number;
  inputTokens: number;
  outputReservedTokens: number;
  reservedTotalTokens: number;
  contextWindow: number;
  remainingTokens: number;
  overflowTokens: number;
  estimated: boolean;
}

export interface CreateContextWindowUsageInput {
  contextTokens: number;
  toolTokens?: number;
  envelopeTokens?: number;
  safetyMarginTokens?: number;
  outputReservedTokens: number;
  contextWindow: number;
  estimated: boolean;
}

export function createContextWindowUsage(
  input: CreateContextWindowUsageInput,
): ContextWindowUsage {
  const toolTokens = input.toolTokens ?? 0;
  const envelopeTokens = input.envelopeTokens ?? 0;
  const safetyMarginTokens = input.safetyMarginTokens ?? 0;
  const inputTokens = input.contextTokens + toolTokens + envelopeTokens;
  const reservedTotalTokens =
    inputTokens + input.outputReservedTokens + safetyMarginTokens;
  const remainingTokens = input.contextWindow - reservedTotalTokens;
  return {
    contextTokens: input.contextTokens,
    toolTokens,
    envelopeTokens,
    safetyMarginTokens,
    inputTokens,
    outputReservedTokens: input.outputReservedTokens,
    reservedTotalTokens,
    contextWindow: input.contextWindow,
    remainingTokens,
    overflowTokens: Math.max(0, -remainingTokens),
    estimated: input.estimated,
  };
}

export function contextWindowUsageFromTurnPayloadUsage(
  usage: TurnPayloadUsage,
): ContextWindowUsage {
  const contextWindow = usage.reservedTotalTokens + usage.remainingTokens;
  return {
    contextTokens: usage.systemTokens + usage.conversationTokens,
    toolTokens: usage.toolTokens,
    envelopeTokens: usage.envelopeTokens,
    safetyMarginTokens: usage.safetyMarginTokens,
    inputTokens: usage.inputTokens,
    outputReservedTokens: usage.outputReservedTokens,
    reservedTotalTokens: usage.reservedTotalTokens,
    contextWindow,
    remainingTokens: usage.remainingTokens,
    overflowTokens: Math.max(0, -usage.remainingTokens),
    estimated: false,
  };
}

function isTurnPayloadUsage(value: unknown): value is TurnPayloadUsage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof TurnPayloadUsage, unknown>>;
  return [
    "systemTokens",
    "conversationTokens",
    "toolTokens",
    "envelopeTokens",
    "safetyMarginTokens",
    "inputTokens",
    "outputReservedTokens",
    "reservedTotalTokens",
    "remainingTokens",
  ].every(
    (key) => typeof candidate[key as keyof TurnPayloadUsage] === "number",
  );
}

export function contextWindowUsageFromError(
  error: unknown,
): ContextWindowUsage | null {
  if (typeof error !== "object" || error === null || !("usage" in error)) {
    return null;
  }
  const usage = (error as { usage?: unknown }).usage;
  return isTurnPayloadUsage(usage)
    ? contextWindowUsageFromTurnPayloadUsage(usage)
    : null;
}
