import { describe, expect, it, vi } from "vitest";

import {
  aiPolicyAllowsChat,
  projectAiChatPolicyAllows,
} from "./mastraChatPolicy.js";

describe("Mastra main chat policy", () => {
  it("matches the renderer for absent and interpretable policies", async () => {
    const renderer = await vi.importActual<{
      parseAiPolicy(raw: string | null | undefined): {
        toggles: { chat: boolean };
      };
    }>("../../src/features/ai-policy/parse");
    const policies = [
      undefined,
      null,
      JSON.stringify({
        preset: "full",
        toggles: { chat: true, bodyWrite: true, analysis: true },
      }),
      JSON.stringify({
        preset: "custom",
        toggles: { chat: false, bodyWrite: true, analysis: false },
      }),
      JSON.stringify({
        preset: "full",
        toggles: { chat: "off", bodyWrite: 1, analysis: null },
      }),
    ];

    for (const raw of policies) {
      expect(aiPolicyAllowsChat(raw)).toBe(
        renderer.parseAiPolicy(raw).toggles.chat,
      );
    }
  });

  it("fails closed for an uninterpretable serialized policy", () => {
    expect(aiPolicyAllowsChat("not-json")).toBe(false);
    expect(aiPolicyAllowsChat("")).toBe(false);
    expect(
      aiPolicyAllowsChat(JSON.stringify({ preset: "full", toggles: {} })),
    ).toBe(false);
  });

  it("requires one object row with an ai_policy column", () => {
    for (const result of [
      "not-json",
      JSON.stringify({ rows: [] }),
      JSON.stringify({ rows: [{}] }),
      JSON.stringify({ rows: [[null]] }),
      JSON.stringify({ rows: [{ ai_policy: "not-json" }] }),
    ]) {
      expect(projectAiChatPolicyAllows(result)).toBe(false);
    }
    expect(
      projectAiChatPolicyAllows(
        JSON.stringify({ rows: [{ ai_policy: null }] }),
      ),
    ).toBe(true);
  });
});
