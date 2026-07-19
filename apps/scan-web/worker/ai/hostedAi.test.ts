import { afterEach, describe, expect, it, vi } from "vitest";
import { HOSTED_EDITOR_AI_LIMITS } from "@grimodex/scan-contract";
import { runHostedAi } from "./hostedAi";
import { OPENROUTER_ACCOUNT_POLICY_ATTESTATION } from "./openRouterPolicy";
import { DEFAULT_SCAN_AI_MODEL, type ScanEnv } from "../env";

afterEach(() => {
  vi.useRealTimers();
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

  it("passes declared agent tools to Workers AI and validates tool calls", async () => {
    const run = vi.fn(async () => ({
      response: "設定を確認します",
      tool_calls: [{ name: "search_codex", arguments: { query: "星の設定" } }],
    }));

    const result = await runHostedAi(
      {
        AI: { run },
        SCAN_AI_PROVIDER: "workers-ai",
        SCAN_AI_MODEL: "test-model",
      } as unknown as ScanEnv,
      {
        prompt: "設定を確認して",
        agent: {
          messages: [
            { role: "system", content: "創作を支援する" },
            { role: "user", content: "設定を確認して" },
          ],
          tools: [
            {
              name: "search_codex",
              description: "Search the project codex",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        },
      },
    );

    expect(run).toHaveBeenCalledWith(
      "test-model",
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: "system", content: "創作を支援する" },
          { role: "user", content: "設定を確認して" },
        ]),
        tools: [
          {
            type: "function",
            function: {
              name: "search_codex",
              description: "Search the project codex",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
        ],
        tool_choice: "auto",
        max_completion_tokens:
          HOSTED_EDITOR_AI_LIMITS.maxProviderCompletionTokens,
      }),
    );
    expect(result).toMatchObject({
      response: "設定を確認します",
      toolCalls: [
        {
          name: "search_codex",
          input: { query: "星の設定" },
        },
      ],
    });
    expect(result.toolCalls?.[0]?.id).toMatch(/^call_[A-Za-z0-9_-]+$/);
  });

  it("falls back to the active Cloudflare model when no model override is configured", async () => {
    const run = vi.fn(async () => ({ response: "ok" }));

    const result = await runHostedAi(
      {
        AI: { run },
        SCAN_AI_PROVIDER: "workers-ai",
      } as unknown as ScanEnv,
      { prompt: "help" },
    );

    expect(run).toHaveBeenCalledWith(DEFAULT_SCAN_AI_MODEL, expect.any(Object));
    expect(result.model).toBe("@cf/zai-org/glm-4.7-flash");
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
        OPENROUTER_ACCOUNT_POLICY_ATTESTATION,
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
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("help");
  });

  it("round-trips structured tool history through an OpenAI-compatible endpoint", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.tools).toEqual([
          {
            type: "function",
            function: {
              name: "search_codex",
              description: "Search",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
        ]);
        expect(body.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              tool_calls: [
                {
                  id: "call-previous",
                  type: "function",
                  function: {
                    name: "search_codex",
                    arguments: JSON.stringify({ query: "前回" }),
                  },
                },
              ],
            }),
            {
              role: "tool",
              tool_call_id: "call-previous",
              content: "前回の結果",
            },
          ]),
        );
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "次も調べます",
                tool_calls: [
                  {
                    id: "call-next",
                    type: "function",
                    function: {
                      name: "search_codex",
                      arguments: JSON.stringify({ query: "次" }),
                    },
                  },
                ],
              },
            },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runHostedAi(
      {
        SCAN_AI_PROVIDER: "openrouter",
        OPENROUTER_URL: "https://router.example/v1/chat/completions",
        OPENROUTER_API_KEY: "server-only",
        OPENROUTER_ACCOUNT_POLICY_ATTESTATION,
        SCAN_AI_MODEL: "router-model",
      } as unknown as ScanEnv,
      {
        prompt: "次も確認して",
        agent: {
          messages: [
            { role: "user", content: "前回を確認して" },
            {
              role: "assistant",
              content: "",
              toolUses: [
                {
                  id: "call-previous",
                  name: "search_codex",
                  input: { query: "前回" },
                },
              ],
            },
            {
              role: "tool_result",
              toolUseId: "call-previous",
              content: "前回の結果",
            },
            { role: "user", content: "次も確認して" },
          ],
          tools: [
            {
              name: "search_codex",
              description: "Search",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        },
      },
    );

    expect(result).toMatchObject({
      response: "次も調べます",
      toolCalls: [
        {
          id: "call-next",
          name: "search_codex",
          input: { query: "次" },
        },
      ],
    });
  });

  it("fails closed when a provider returns an undeclared or malformed tool call", async () => {
    const run = vi.fn(async () => ({
      tool_calls: [{ name: "delete_workspace", arguments: [] }],
    }));

    await expect(
      runHostedAi(
        {
          AI: { run },
          SCAN_AI_PROVIDER: "workers-ai",
        } as unknown as ScanEnv,
        {
          prompt: "help",
          agent: {
            messages: [{ role: "user", content: "help" }],
            tools: [
              {
                name: "search_codex",
                description: "Search",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                },
              },
            ],
          },
        },
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("rejects an oversized Workers AI response before it can be persisted", async () => {
    await expect(
      runHostedAi(
        {
          AI: {
            run: vi.fn(async () => ({
              response: "x".repeat(
                HOSTED_EDITOR_AI_LIMITS.maxResponseTextChars + 1,
              ),
            })),
          },
          SCAN_AI_PROVIDER: "workers-ai",
        } as unknown as ScanEnv,
        { prompt: "help" },
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("bounds a Workers AI call well below the stale reservation lease", async () => {
    vi.useFakeTimers();
    const result = runHostedAi(
      {
        AI: { run: vi.fn(() => new Promise(() => undefined)) },
        SCAN_AI_PROVIDER: "workers-ai",
      } as unknown as ScanEnv,
      { prompt: "help" },
    );
    const rejection = expect(result).rejects.toMatchObject({ status: 504 });

    await vi.advanceTimersByTimeAsync(2 * 60 * 1_000);

    await rejection;
  });
});
