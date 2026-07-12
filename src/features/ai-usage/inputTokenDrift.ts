export type InputTokenEstimatorFamily = "o200k_base" | "cjk_heuristic_v1";

export type InputTokenDriftScope = "chat" | "agent-parent" | "agent-research";

export interface InputTokenRouteSnapshot {
  surface: "chat" | "agent";
  provider: string;
  model: string;
  apiVariant: string | null;
  requestedEndpointId: string | null;
  resolvedEndpointId: string | null;
  toolProtocol: "native" | "hermes";
  contextWindow: number;
}

export interface InputTokenUsageSample {
  estimatedInputTokens?: number | null;
  safetyMarginTokens?: number | null;
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

export interface InputTokenDriftTotals {
  estimatedInputTokens: number | null;
  normalizedActualInputTokens: number | null;
  safetyMarginTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  requestCount: number;
}

export interface InputTokenDriftMetadataInput {
  scope: InputTokenDriftScope;
  projectId: string;
  route: InputTokenRouteSnapshot;
  estimatorFamily: InputTokenEstimatorFamily;
  language?: string | null;
  contextPlanDigest?: string | null;
  totals: InputTokenDriftTotals;
}

function nonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function addComplete(
  total: number | null,
  value: number | null | undefined,
): number | null {
  const normalized = nonNegative(value);
  return total === null || normalized === null ? null : total + normalized;
}

function addObserved(
  total: number | null,
  value: number | null | undefined,
): number | null {
  const normalized = nonNegative(value);
  if (normalized === null) return total;
  return (total ?? 0) + normalized;
}

/**
 * Normalize provider-reported prompt usage into comparable total input.
 * Anthropic direct reports uncached input separately from cache read/create;
 * OpenAI-family prompt totals already include cached input and must not add it.
 */
export function normalizeActualInputTokens(
  provider: string,
  usage: Pick<
    InputTokenUsageSample,
    "inputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): number | null {
  const inputTokens = nonNegative(usage.inputTokens);
  if (inputTokens === null) return null;
  if (provider !== "anthropic") return inputTokens;
  return (
    inputTokens +
    (nonNegative(usage.cacheReadTokens) ?? 0) +
    (nonNegative(usage.cacheWriteTokens) ?? 0)
  );
}

export function createInputTokenDriftTotals(): InputTokenDriftTotals {
  return {
    estimatedInputTokens: 0,
    normalizedActualInputTokens: 0,
    safetyMarginTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    requestCount: 0,
  };
}

/** Add one completed application-level LLM request without mutating prior totals. */
export function accumulateInputTokenDrift(
  totals: InputTokenDriftTotals,
  provider: string,
  sample: InputTokenUsageSample,
): InputTokenDriftTotals {
  return {
    estimatedInputTokens: addComplete(
      totals.estimatedInputTokens,
      sample.estimatedInputTokens,
    ),
    normalizedActualInputTokens: addComplete(
      totals.normalizedActualInputTokens,
      normalizeActualInputTokens(provider, sample),
    ),
    safetyMarginTokens: addComplete(
      totals.safetyMarginTokens,
      sample.safetyMarginTokens,
    ),
    cacheReadTokens: addObserved(
      totals.cacheReadTokens,
      sample.cacheReadTokens,
    ),
    cacheWriteTokens: addObserved(
      totals.cacheWriteTokens,
      sample.cacheWriteTokens,
    ),
    requestCount: totals.requestCount + 1,
  };
}

export function buildInputTokenDriftMetadata(
  input: InputTokenDriftMetadataInput,
): Record<string, unknown> {
  const { totals } = input;
  const language = input.language?.trim().toLowerCase() || null;
  const deltaInputTokens =
    totals.normalizedActualInputTokens !== null &&
    totals.estimatedInputTokens !== null
      ? totals.normalizedActualInputTokens - totals.estimatedInputTokens
      : null;
  return {
    inputTokenDrift: {
      scope: input.scope,
      provider: input.route.provider,
      projectId: input.projectId,
      route: { ...input.route },
      estimatorFamily: input.estimatorFamily,
      language,
      safetyMarginTokens: totals.safetyMarginTokens,
      contextPlanDigest: input.contextPlanDigest ?? null,
      estimatedInputTokens: totals.estimatedInputTokens,
      normalizedActualInputTokens: totals.normalizedActualInputTokens,
      deltaInputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      requestCount: totals.requestCount,
    },
  };
}
