import type { RuntimeTarget } from "@/runtime/runtimeTarget";
import { AI_PROVIDERS, type AiProvider } from "./types";

/**
 * The Web Editor has no developer-owned AI credential or hosted provider.
 * Every allowed route is configured by the user and contacts either their
 * Local LLM or the provider attached to their own API key.
 */
export const BROWSER_DIRECT_AI_PROVIDERS = [
  "ollama",
  "openai",
  "anthropic",
] as const satisfies readonly AiProvider[];

export function aiProvidersForRuntime(
  target: RuntimeTarget,
): readonly AiProvider[] {
  return target === "web" ? BROWSER_DIRECT_AI_PROVIDERS : AI_PROVIDERS;
}
