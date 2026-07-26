import { describe, expect, it } from "vitest";
import {
  BROWSER_DIRECT_AI_PROVIDERS,
  aiProvidersForRuntime,
} from "./browserProviderPolicy";
import { AI_PROVIDERS } from "./types";

describe("Web Editor AI provider policy", () => {
  it("offers every HTTP provider on the web and excludes only native CLI", () => {
    expect(BROWSER_DIRECT_AI_PROVIDERS).toEqual([
      "openrouter",
      "openai",
      "anthropic",
      "ollama",
      "openai-compatible",
      "sakana",
      "ai-novelist",
    ]);
    expect(BROWSER_DIRECT_AI_PROVIDERS).toEqual(
      AI_PROVIDERS.filter((provider) => provider !== "cli"),
    );
    expect(aiProvidersForRuntime("web")).toEqual(BROWSER_DIRECT_AI_PROVIDERS);
  });

  it("does not narrow the desktop provider registry", () => {
    expect(aiProvidersForRuntime("electron")).toEqual(AI_PROVIDERS);
  });
});
