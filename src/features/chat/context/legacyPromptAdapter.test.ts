import { describe, expect, it } from "vitest";
import { buildSystemPrompt, ensureTokenizer } from "../contextBuilder";
import { renderLegacyPrompt } from "./legacyPromptAdapter";

describe("renderLegacyPrompt", () => {
  it("preserves the legacy prompt, cache segments, tail, and layers byte-for-byte", async () => {
    await ensureTokenizer();
    const input = {
      scene: { id: "scene-1", title: "Scene", content: "Body" },
      project: { title: "Project", language: "en" },
      conversationTokens: 0,
      contextWindow: 16_384,
      maxOutputTokens: 2_048,
      deliveryMode: "plain" as const,
    };

    const expected = buildSystemPrompt(input);
    const actual = renderLegacyPrompt(input);

    expect(actual.prompt).toBe(expected.prompt);
    expect(actual.cacheSegments).toEqual(expected.cacheSegments);
    expect(actual.volatileTail).toBe(expected.volatileTail);
    expect(actual.layers).toEqual(expected.layers);
    expect(actual.totalTokens).toBe(expected.totalTokens);
  });
});
