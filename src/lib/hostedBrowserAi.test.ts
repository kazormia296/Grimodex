import type {
  AiDataDisclosureV1,
  HostedAiSessionV1,
} from "@grimodex/scan-contract";
import { snapshotAgentTools } from "@/features/chat/agent/toolDefinitions";
import { describe, expect, it, vi } from "vitest";
import { createHostedBrowserAi } from "./hostedBrowserAi";

const session: HostedAiSessionV1 = {
  scanId: "scan-123",
  token: "a".repeat(64),
  expiresAt: "2026-07-20T00:00:00.000Z",
};

const disclosure: AiDataDisclosureV1 = {
  schemaVersion: "grimodex/ai-data-disclosure/1",
  policyVersion: "2026-07-19.1",
  route: "hosted-editor",
  provider: "workers-ai",
  consentId: "consent_hosted_editor_2026_07_19_v1",
  usagePolicy: {
    summary: "AI usage policy",
    policyUrl: "https://example.com/terms",
  },
  sentData: [{ category: "prompt", description: "Prompt and context" }],
  processingDestinations: [
    {
      processor: "Cloudflare Workers AI",
      purpose: "Generate a response",
      location: "Cloudflare-managed infrastructure",
      privacyPolicyUrl: "https://example.com/privacy",
    },
  ],
  storage: {
    application: {
      storesPrompt: true,
      storesResponse: true,
      location: "Cloudflare R2",
    },
    provider: {
      summary: "Provider policy",
      policyUrl: "https://example.com/provider-storage",
    },
  },
  retention: {
    application: { uploadMinutes: 15, sourceDays: 1, artifactDays: 30 },
    provider: {
      summary: "Provider retention",
      policyUrl: "https://example.com/provider-retention",
    },
  },
  trainingUse: {
    status: "not-used",
    summary: "Not used for training",
    policyUrl: "https://example.com/training",
  },
};

function request(messages = [{ role: "user", content: "続きを書いて" }]) {
  return {
    operation: "chat" as const,
    provider: "openrouter" as const,
    model: "grimodex-hosted",
    messages,
  };
}

describe("hosted browser AI", () => {
  it("allows the loopback HTTP origin used by the local Scan stack", () => {
    expect(() =>
      createHostedBrowserAi({
        apiBaseUrl: "http://127.0.0.1:8787",
        session,
        fetchImpl: vi.fn(),
        requestConsent: vi.fn(),
      }),
    ).not.toThrow();
  });

  it("requires the current server disclosure before sending manuscript data", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(disclosure))
      .mockResolvedValueOnce(
        Response.json({ response: "生成結果", costWeight: 1 }),
      );
    const requestConsent = vi.fn().mockResolvedValue(undefined);
    const hosted = createHostedBrowserAi({
      apiBaseUrl: "https://scan.example/",
      session,
      fetchImpl,
      requestConsent,
      now: () => Date.parse("2026-07-19T00:00:00.000Z"),
    });

    await hosted.authorizeAiRequest({
      operation: "chat",
      provider: "openrouter",
      model: "grimodex-hosted",
      hasApiKey: false,
    });
    const result = await hosted.transport.complete(
      request([
        { role: "system", content: "文体を保つ" },
        { role: "user", content: "続きを書いて" },
      ]),
    );

    expect(requestConsent).toHaveBeenCalledWith(disclosure);
    expect(result).toEqual({
      blocks: [{ type: "text", content: "生成結果" }],
      stopReason: "end_turn",
    });
    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(postInit.headers).toEqual(
      expect.objectContaining({
        "x-editor-session-token": session.token,
        "x-ai-consent-id": disclosure.consentId,
      }),
    );
    expect(postInit.body).toBe(
      JSON.stringify({
        operation: "chat",
        prompt: "続きを書いて",
        context: "[system]\n文体を保つ",
      }),
    );
    expect(String(postInit.body)).not.toContain(session.token);
    expect(String(postInit.body)).not.toContain(disclosure.consentId);
  });

  it("fails closed when the hosted session has expired", async () => {
    const fetchImpl = vi.fn();
    const hosted = createHostedBrowserAi({
      apiBaseUrl: "https://scan.example",
      session,
      fetchImpl,
      requestConsent: vi.fn(),
      now: () => Date.parse(session.expiresAt),
    });

    await expect(
      hosted.authorizeAiRequest({
        operation: "chat",
        provider: "openrouter",
        model: "grimodex-hosted",
        hasApiKey: false,
      }),
    ).rejects.toThrow("Hosted AI session has expired");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid disclosure without opening the consent dialog", async () => {
    const requestConsent = vi.fn();
    const hosted = createHostedBrowserAi({
      apiBaseUrl: "https://scan.example",
      session,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(Response.json({ ...disclosure, policyVersion: "" })),
      requestConsent,
      now: () => Date.parse("2026-07-19T00:00:00.000Z"),
    });

    await expect(
      hosted.authorizeAiRequest({
        operation: "chat",
        provider: "openrouter",
        model: "grimodex-hosted",
        hasApiKey: false,
      }),
    ).rejects.toThrow("Hosted AI disclosure is invalid");
    expect(requestConsent).not.toHaveBeenCalled();
  });

  it("uses the hosted codex route for the Editor agent loop", async () => {
    const tools = [
      {
        name: "search_codex",
        description: "Search the current project codex",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Search phrase" },
          },
          required: ["query"],
        },
      },
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(disclosure))
      .mockResolvedValueOnce(
        Response.json({
          response: "候補を調べます",
          costWeight: 3,
          toolCalls: [
            {
              id: "call-next",
              name: "search_codex",
              input: { query: "星の設定" },
            },
          ],
        }),
      );
    const hosted = createHostedBrowserAi({
      apiBaseUrl: "https://scan.example",
      session,
      fetchImpl,
      requestConsent: vi.fn().mockResolvedValue(undefined),
      now: () => Date.parse("2026-07-19T00:00:00.000Z"),
    });
    await hosted.authorizeAiRequest({
      operation: "agent",
      provider: "openrouter",
      model: "grimodex-hosted",
      hasApiKey: false,
    });

    const result = await hosted.transport.completeAgent?.(
      request(),
      [
        { role: "system", content: "創作を支援する" },
        {
          role: "assistant",
          content: "前回の回答",
          toolUses: [
            {
              id: "call-previous",
              name: "search_codex",
              input: { query: "前回の設定" },
            },
          ],
          thinkingBlocks: [
            { thinking: "送信してはいけない内部思考", signature: "sig" },
          ],
        },
        {
          role: "tool_result",
          toolUseId: "call-previous",
          content: "明示されたツール結果",
        },
        { role: "user", content: "相談です" },
      ],
      tools,
    );

    expect(result).toEqual({
      blocks: [
        { type: "text", content: "候補を調べます" },
        {
          type: "tool_use",
          id: "call-next",
          name: "search_codex",
          input: { query: "星の設定" },
        },
      ],
      stopReason: "tool_use",
    });
    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(postInit.body)) as {
      operation: string;
      prompt: string;
      context?: string;
      messages: Array<Record<string, unknown>>;
      tools: typeof tools;
    };
    expect(body).toMatchObject({
      operation: "codex",
      prompt: "相談です",
    });
    expect(body.context).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "創作を支援する" },
      {
        role: "assistant",
        content: "前回の回答",
        toolUses: [
          {
            id: "call-previous",
            name: "search_codex",
            input: { query: "前回の設定" },
          },
        ],
      },
      {
        role: "tool_result",
        toolUseId: "call-previous",
        content: "明示されたツール結果",
      },
      { role: "user", content: "相談です" },
    ]);
    expect(body.tools).toEqual(tools);
    expect(String(postInit.body)).not.toContain("送信してはいけない内部思考");
  });

  it("fails closed on malformed or undeclared hosted tool calls", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(disclosure))
      .mockResolvedValueOnce(
        Response.json({
          response: "",
          costWeight: 3,
          toolCalls: [{ id: "call-1", name: "delete_workspace", input: {} }],
        }),
      );
    const hosted = createHostedBrowserAi({
      apiBaseUrl: "https://scan.example",
      session,
      fetchImpl,
      requestConsent: vi.fn().mockResolvedValue(undefined),
      now: () => Date.parse("2026-07-19T00:00:00.000Z"),
    });
    await hosted.authorizeAiRequest({
      operation: "agent",
      provider: "openrouter",
      model: "grimodex-hosted",
      hasApiKey: false,
    });

    await expect(
      hosted.transport.completeAgent?.(
        request(),
        [{ role: "user", content: "相談です" }],
        [
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
      ),
    ).rejects.toThrow("Hosted AI response is invalid");
  });

  it("fits the real Editor agent tool snapshot within the hosted wire contract", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(disclosure))
      .mockResolvedValueOnce(
        Response.json({ response: "確認しました", costWeight: 3 }),
      );
    const hosted = createHostedBrowserAi({
      apiBaseUrl: "https://scan.example",
      session,
      fetchImpl,
      requestConsent: vi.fn().mockResolvedValue(undefined),
      now: () => Date.parse("2026-07-19T00:00:00.000Z"),
    });
    await hosted.authorizeAiRequest({
      operation: "agent",
      provider: "openrouter",
      model: "grimodex-hosted",
      hasApiKey: false,
    });

    await expect(
      hosted.transport.completeAgent?.(
        request(),
        [{ role: "user", content: "相談です" }],
        snapshotAgentTools(),
      ),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(
      new TextEncoder().encode(String(postInit.body)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it("emits a real hosted response through the existing stream contract", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(disclosure))
      .mockResolvedValueOnce(
        Response.json({ response: "続き", costWeight: 2 }),
      );
    const hosted = createHostedBrowserAi({
      apiBaseUrl: "https://scan.example",
      session,
      fetchImpl,
      requestConsent: vi.fn().mockResolvedValue(undefined),
      now: () => Date.parse("2026-07-19T00:00:00.000Z"),
    });
    await hosted.authorizeAiRequest({
      operation: "inline",
      provider: "openrouter",
      model: "grimodex-hosted",
      hasApiKey: false,
    });
    const text = vi.fn();
    const done = vi.fn();

    await hosted.transport.stream?.(
      { ...request(), operation: "inline" },
      { text, done },
    );

    expect(text).toHaveBeenCalledWith("続き", "text");
    expect(done).toHaveBeenCalledWith({ stopReason: "end_turn" });
  });
});
