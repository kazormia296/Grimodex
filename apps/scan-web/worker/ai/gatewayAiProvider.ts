import type { ScanEnv } from "../env";
import {
  createWorkersAiProvider,
  withProviderCallTimeout,
  type WorkersAiBindingLike,
} from "./workersAiProvider";
import type { ScanAiProvider, ScanModelProfile } from "@grimodex/scan-prompts";
import type { ProviderCallHooks } from "./workersAiProvider";

export type GatewayProviderName = "ai-gateway" | "openrouter";

function endpointFor(
  env: ScanEnv,
  provider: GatewayProviderName,
): { url: string; token: string } | null {
  if (provider === "ai-gateway") {
    if (!env.SCAN_AI_GATEWAY_URL || !env.AI_GATEWAY_TOKEN) return null;
    return { url: env.SCAN_AI_GATEWAY_URL, token: env.AI_GATEWAY_TOKEN };
  }
  if (!env.OPENROUTER_URL || !env.OPENROUTER_API_KEY) return null;
  return { url: env.OPENROUTER_URL, token: env.OPENROUTER_API_KEY };
}

/**
 * Adapts an OpenAI-compatible Gateway/OpenRouter endpoint to the same
 * schema-validating provider used by Workers AI. Raw request/response bodies
 * are never logged by this adapter.
 */
export function createGatewayAiProvider(
  env: ScanEnv,
  provider: GatewayProviderName,
  profile: ScanModelProfile,
  hooks: ProviderCallHooks = {},
): ScanAiProvider | null {
  const endpoint = endpointFor(env, provider);
  if (!endpoint) return null;
  const binding: WorkersAiBindingLike = {
    async run(model, input) {
      return withProviderCallTimeout(async (signal) => {
        const response = await fetch(endpoint.url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${endpoint.token}`,
            ...(provider === "openrouter"
              ? { "x-title": "Grimodex Scan" }
              : {}),
          },
          body: JSON.stringify({
            model,
            messages: input.messages,
            temperature: 0,
            max_tokens: 4_000,
          }),
        });
        if (!response.ok) {
          const error = new Error(
            `AI provider request failed (${response.status})`,
          );
          Object.assign(error, { status: response.status });
          throw error;
        }
        return response.json();
      });
    },
  };
  return createWorkersAiProvider(binding, profile, hooks);
}
