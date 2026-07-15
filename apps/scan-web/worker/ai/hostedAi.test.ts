import { afterEach, describe, expect, it, vi } from "vitest";
import { runHostedAi } from "./hostedAi";
import type { ScanEnv } from "../env";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hosted AI provider routing", () => {
  it("uses Workers AI without exposing the request through a URL", async () => {
    const result = await runHostedAi(
      {
        AI: { run: vi.fn(async () => ({ response: "ok" })) },
        SCAN_AI_PROVIDER: "workers-ai",
        SCAN_AI_MODEL: "test-model",
      } as unknown as ScanEnv,
      { prompt: "help" },
    );
    expect(result).toMatchObject({
      response: "ok",
      provider: "workers-ai",
      model: "test-model",
    });
  });

  it("uses an OpenAI-compatible hosted endpoint with server-side authorization", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "gateway-ok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runHostedAi(
      {
        SCAN_AI_PROVIDER: "openrouter",
        OPENROUTER_URL: "https://router.example/v1/chat/completions",
        OPENROUTER_API_KEY: "server-only",
        SCAN_AI_MODEL: "router-model",
      } as unknown as ScanEnv,
      { prompt: "help" },
    );
    expect(result.response).toBe("gateway-ok");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://router.example/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer server-only",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("help");
  });
});
