import { describe, expect, it, vi } from "vitest";

import {
  aiPolicyAllowsChat,
  projectAiChatPolicyAllows,
} from "./mastraChatPolicy.js";

describe("Mastra main chat policy", () => {
  it("matches the renderer for absent, empty, and boolean policies", async () => {
    const renderer = await vi.importActual<{
      parseAiPolicy(raw: string | null | undefined): {
        toggles: { chat: boolean };
      };
    }>("../../src/features/ai-policy/parse");
    const policies = [
      undefined,
      null,
      "",
      JSON.stringify({
        preset: "full",
        toggles: { chat: true, bodyWrite: true, analysis: true },
      }),
      JSON.stringify({
        preset: "custom",
        toggles: { chat: false, bodyWrite: true, analysis: false },
      }),
    ];

    for (const raw of policies) {
      expect(aiPolicyAllowsChat(raw)).toBe(
        renderer.parseAiPolicy(raw).toggles.chat,
      );
    }
  });

  it("rejects corrupted chat toggles instead of the renderer's Boolean(t.chat) coercion", async () => {
    const renderer = await vi.importActual<{
      parseAiPolicy(raw: string | null | undefined): {
        toggles: { chat: boolean };
      };
    }>("../../src/features/ai-policy/parse");

    for (const chat of ["off", 1, null]) {
      const raw = JSON.stringify({
        preset: "custom",
        toggles: { chat, bodyWrite: true, analysis: false },
      });
      // Renderer Boolean(t.chat) enables "off"/1; Main rejects every non-boolean value.
      expect(renderer.parseAiPolicy(raw).toggles.chat).toBe(Boolean(chat));
      expect(aiPolicyAllowsChat(raw)).toBe(false);
    }
  });

  it("renderer defaults malformed JSON to full while Main fails closed", async () => {
    // parseAiPolicy intentionally defaults unreadable persisted text to full; Main rejects it before egress.
    const renderer = await vi.importActual<{
      parseAiPolicy(raw: string | null | undefined): {
        toggles: { chat: boolean };
      };
    }>("../../src/features/ai-policy/parse");
    expect(renderer.parseAiPolicy("not-json").toggles.chat).toBe(true);
    expect(aiPolicyAllowsChat("not-json")).toBe(false);
    expect(aiPolicyAllowsChat(" ")).toBe(false);
    expect(
      aiPolicyAllowsChat(
        JSON.stringify({
          preset: "future",
          toggles: { chat: true, bodyWrite: true, analysis: true },
        }),
      ),
    ).toBe(false);
    expect(
      aiPolicyAllowsChat(JSON.stringify({ preset: "full", toggles: {} })),
    ).toBe(false);
    expect(aiPolicyAllowsChat(0)).toBe(false);
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
    expect(
      projectAiChatPolicyAllows(JSON.stringify({ rows: [{ ai_policy: "" }] })),
    ).toBe(true);
  });
});
