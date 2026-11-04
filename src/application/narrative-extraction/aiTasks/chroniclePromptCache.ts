import {
  splitChroniclePromptForCache,
  type ChroniclePromptArtifact,
} from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";

/**
 * Shortest static prefix (in UTF-16 code units) worth sending as a cache
 * segment. Anthropic caches only prefixes of at least 512 tokens on the
 * smallest models, and a token is never shorter than one code unit for
 * Japanese text, so a shorter prefix can never be cached. Below this the
 * prompt is sent unsplit and keeps its original (user-only) shape.
 */
export const CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS = 512;

export interface ChroniclePromptRoute {
  readonly provider: string | null;
  readonly model: string | null;
  readonly apiVariant: string | null;
}

export interface ChroniclePromptRequest {
  readonly messages: { role: string; content: string }[];
  /** Present only when the cache segment is actually sent. */
  readonly systemCacheSegments?: string[];
}

/**
 * Mirrors `supports_prompt_cache` in grimodex-ai (Anthropic, or OpenRouter
 * routed to a Claude model) and additionally excludes the Responses API,
 * which ignores cache segments, so a split there would only change roles.
 */
export function supportsChroniclePromptCache(
  route: ChroniclePromptRoute,
): boolean {
  if (route.apiVariant === "responses") return false;
  if (route.provider === "anthropic") return true;
  return (
    route.provider === "openrouter" &&
    route.model !== null &&
    route.model.includes("claude")
  );
}

/**
 * Resolve the provider/model exactly as the single-shot transport will, using
 * the same override-over-settings precedence. Loaded lazily so the transport
 * stays out of the initial module graph, like `chatApi` does.
 */
export async function resolveChroniclePromptRoute(override: {
  readonly provider: string | null;
  readonly model: string | null;
  readonly apiVariant: string | null;
  readonly endpointId: string | null;
}): Promise<ChroniclePromptRoute | null> {
  try {
    const { loadSingleShotTransport } =
      await import("@/features/chat/lazyTransportApi");
    const { resolveChatAuditRoute } = await loadSingleShotTransport();
    const route = resolveChatAuditRoute({
      provider: override.provider,
      model: override.model,
      apiVariant: override.apiVariant,
      endpointId: override.endpointId,
    });
    return {
      provider: route.provider,
      model: route.model,
      apiVariant: route.apiVariant,
    };
  } catch {
    // The transport re-resolves and reports route errors itself.
    return null;
  }
}

/**
 * Shape the model request for a Chronicle prompt. The model-visible text is
 * never changed: when the route can use Anthropic prompt caching, the static
 * leading part of the single user prompt moves, verbatim, into one cacheable
 * system segment and the remainder stays the user message; otherwise (other
 * providers, a prefix too short to cache, an unrecognised shape) the prompt is
 * returned as the same single user message as before.
 */
export function buildChroniclePromptRequest(
  artifact: ChroniclePromptArtifact,
  route: ChroniclePromptRoute | null,
): ChroniclePromptRequest {
  const unsplit: ChroniclePromptRequest = {
    messages: [{ role: "user", content: artifact.messages[0].content }],
  };
  if (route === null || !supportsChroniclePromptCache(route)) return unsplit;
  const split = splitChroniclePromptForCache(artifact);
  if (
    split === null ||
    split.staticPrefix.length < CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS ||
    split.dynamicRest.length === 0
  ) {
    return unsplit;
  }
  return {
    messages: [
      { role: "system", content: split.staticPrefix },
      { role: "user", content: split.dynamicRest },
    ],
    systemCacheSegments: [split.staticPrefix],
  };
}
