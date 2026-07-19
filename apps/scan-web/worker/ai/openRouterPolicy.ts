export const OPENROUTER_APP_URL = "https://grimodex.app";
export const OPENROUTER_ALLOWED_PROVIDERS = ["azure"] as const;
export const OPENROUTER_PRIVACY_PROFILE_ID = "azure-zdr-account-attested-v2";
export const OPENROUTER_ACCOUNT_POLICY_ATTESTATION =
  "2026-07-19.9:logging-off:inputs-outputs-use-off:broadcast-off-or-key-excluded";

export function openRouterAccountPolicyAttested(
  value: string | undefined,
): boolean {
  return value === OPENROUTER_ACCOUNT_POLICY_ATTESTATION;
}

export interface OpenRouterUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  providerRequestId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed)
    ? parsed
    : undefined;
}

export function openRouterRequestFields(
  maxCompletionTokens: number,
): Record<string, unknown> {
  return {
    max_completion_tokens: maxCompletionTokens,
    provider: {
      order: [...OPENROUTER_ALLOWED_PROVIDERS],
      only: [...OPENROUTER_ALLOWED_PROVIDERS],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    },
    usage: { include: true },
  };
}

export function openRouterHeaders(title: string): Record<string, string> {
  return {
    "HTTP-Referer": OPENROUTER_APP_URL,
    "X-OpenRouter-Title": title,
  };
}

export function openRouterEndpointClass(
  urlValue: string | undefined,
): "global" | "eu" {
  let url: URL;
  try {
    url = new URL(urlValue ?? "");
  } catch {
    throw new Error("OpenRouter endpoint is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/api/v1/chat/completions" ||
    url.search ||
    url.hash
  ) {
    throw new Error("OpenRouter endpoint is invalid");
  }
  if (url.hostname === "openrouter.ai") return "global";
  if (url.hostname === "eu.openrouter.ai") return "eu";
  throw new Error("OpenRouter endpoint is invalid");
}

export function openRouterProviderIdentity(
  endpoint: string | undefined,
  model: string,
): string {
  const normalizedModel = model.trim();
  if (
    normalizedModel.length < 1 ||
    normalizedModel.length > 96 ||
    !/^[A-Za-z0-9._:/+-]+$/.test(normalizedModel)
  ) {
    throw new Error("OpenRouter model identity is invalid");
  }
  return `openrouter:${openRouterEndpointClass(endpoint)}:${OPENROUTER_PRIVACY_PROFILE_ID}:${normalizedModel}`;
}

export function parseOpenRouterUsage(
  value: unknown,
): OpenRouterUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage = isRecord(value.usage) ? value.usage : null;
  const parsed: OpenRouterUsage = {};
  const inputTokens = nonNegativeInteger(usage?.prompt_tokens);
  const outputTokens = nonNegativeInteger(usage?.completion_tokens);
  const estimatedCostUsd = nonNegativeNumber(usage?.cost);
  if (inputTokens !== undefined) parsed.inputTokens = inputTokens;
  if (outputTokens !== undefined) parsed.outputTokens = outputTokens;
  if (estimatedCostUsd !== undefined)
    parsed.estimatedCostUsd = estimatedCostUsd;
  if (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 256
  ) {
    parsed.providerRequestId = value.id;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}
