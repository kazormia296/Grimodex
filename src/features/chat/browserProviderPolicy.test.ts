import { describe, expect, it } from "vitest";
import {
  BROWSER_DIRECT_AI_PROVIDERS,
  aiProvidersForRuntime,
} from "./browserProviderPolicy";
import { AI_PROVIDERS } from "./types";

describe("Web Editor AI provider policy", () => {
  it("offers only Local LLM and direct BYOK providers on the web", () => {
    expect(BROWSER_DIRECT_AI_PROVIDERS).toEqual([
      "ollama",
      "openai",
      "anthropic",
    ]);
    expect(aiProvidersForRuntime("web")).toEqual(BROWSER_DIRECT_AI_PROVIDERS);
  });

  it("does not narrow the desktop provider registry", () => {
    expect(aiProvidersForRuntime("electron")).toEqual(AI_PROVIDERS);
  });
});
