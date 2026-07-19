import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanEnv } from "../env";
import { runHostedAi } from "./hostedAi";
import { OPENROUTER_ACCOUNT_POLICY_ATTESTATION } from "./openRouterPolicy";

afterEach(() => vi.unstubAllGlobals());

describe("Hosted Editor OpenRouter contract", () => {
  it("uses the Editor-only Luna route and records provider usage", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          id: "generation-123",
          choices: [{ message: { content: "編集案です" } }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 32,
            cost: 0.000312,
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runHostedAi(
      {
        AI: { run: vi.fn(async () => ({ response: "wrong route" })) },
        SCAN_AI_PROVIDER: "workers-ai",
        SCAN_AI_MODEL: "@cf/zai-org/glm-4.7-flash",
        SCAN_EDITOR_AI_PROVIDER: "openrouter",
        SCAN_EDITOR_AI_MODEL: "openai/gpt-5.6-luna",
        OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "server-only",
        OPENROUTER_ACCOUNT_POLICY_ATTESTATION,
      } as unknown as ScanEnv,
      { prompt: "この段落を整えて" },
    );

    expect(result).toMatchObject({
      response: "編集案です",
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      usage: {
        inputTokens: 120,
        outputTokens: 32,
        estimatedCostUsd: 0.000312,
        providerRequestId: "generation-123",
      },
    });
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "openai/gpt-5.6-luna",
      max_completion_tokens: 2_000,
      provider: {
        order: ["azure"],
        only: ["azure"],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
      usage: { include: true },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
    expect(new Headers(init?.headers).get("x-openrouter-title")).toBe(
      "Grimodex Hosted Editor",
    );
  });
});
