// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMock } from "./browser-mock";

describe("BrowserMock web AI runtime contract", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("preserves every HTTP provider role override and removes only CLI", async () => {
    const legacySettings = {
      recentWorkspaces: [
        { path: "/dev/workspace", lastOpened: "2026-07-20T00:00:00.000Z" },
      ],
      lastActiveWorkspace: "/dev/workspace",
      userPreferences: {
        "editor.fontSize": "18",
        "aiModel.roleProviders": JSON.stringify({
          conversation: { provider: "openrouter" },
          agent: { provider: "openai" },
          inline: { provider: "ollama" },
          cheap: {
            provider: "openai-compatible",
            endpointId: "legacy-endpoint",
          },
          title: { provider: "cli" },
        }),
        "aiModel.role.conversation": "anthropic/claude-sonnet-4.6",
        "aiModel.role.agent": "gpt-5-mini",
        "aiModel.role.inline": "qwen3:8b",
        "aiModel.role.cheap": "legacy-compatible-model",
        "aiModel.role.title": "codex",
      },
    };
    localStorage.setItem(
      "grimodex:global-settings",
      JSON.stringify(legacySettings),
    );
    const mock = await createBrowserMock();

    const normalized = await mock.invoke<typeof legacySettings>(
      "get_global_settings",
    );

    expect(normalized.userPreferences).toEqual({
      "editor.fontSize": "18",
      "aiModel.roleProviders": JSON.stringify({
        conversation: { provider: "openrouter" },
        agent: { provider: "openai" },
        inline: { provider: "ollama" },
        cheap: {
          provider: "openai-compatible",
          endpointId: "legacy-endpoint",
        },
      }),
      "aiModel.role.conversation": "anthropic/claude-sonnet-4.6",
      "aiModel.role.agent": "gpt-5-mini",
      "aiModel.role.inline": "qwen3:8b",
      "aiModel.role.cheap": "legacy-compatible-model",
    });
    expect(
      JSON.parse(localStorage.getItem("grimodex:global-settings") ?? "{}"),
    ).toEqual(normalized);
    mock.close();
  });

  it("resolves the selected OpenAI-compatible endpoint for browser requests", async () => {
    const authorizeAiRequest = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "local response" }],
      stopReason: "end_turn",
    });
    const mock = await createBrowserMock({
      authorizeAiRequest,
      aiTransport: { complete },
    });
    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "openai-compatible",
        model: "local-model",
        ollamaEndpoint: "http://localhost:11434",
        openaiCompatible: { baseUrl: "http://legacy.invalid/v1" },
        openaiCompatibleEndpoints: [
          {
            id: "lan",
            label: "LAN",
            baseUrl: "http://192.0.2.20:8080/v1/",
            apiVariant: null,
          },
        ],
        activeOpenaiCompatibleEndpointId: "lan",
      },
    });

    await mock.invoke("send_chat_message", {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        endpointId: "lan",
        baseUrl: "http://192.0.2.20:8080/v1",
      }),
    );
    expect(authorizeAiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        baseUrl: "http://192.0.2.20:8080/v1",
        hasApiKey: false,
      }),
    );
    mock.close();
  });

  it("routes the Web Editor browserAiMode through model discovery and completion", async () => {
    const authorizeAiRequest = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "on-device" }],
      stopReason: "end_turn",
    });
    const listModels = vi
      .fn()
      .mockResolvedValue([
        { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", name: "Qwen 0.5B" },
      ]);
    const mock = await createBrowserMock({
      authorizeAiRequest,
      aiTransport: { complete, listModels },
    });

    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "ollama",
        browserAiMode: "webgpu",
        model: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
        ollamaEndpoint: "http://localhost:11434",
      },
    });
    await expect(
      mock.invoke("list_ai_models", { provider: "ollama" }),
    ).resolves.toEqual([
      { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", name: "Qwen 0.5B" },
    ]);
    await mock.invoke("send_chat_message", {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ browserAiMode: "webgpu" }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ browserAiMode: "webgpu" }),
    );
    expect(authorizeAiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ browserAiMode: "webgpu" }),
    );
    mock.close();
  });

  it("falls back from a desktop Responses preference to Web chat transport", async () => {
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "sakana response" }],
      stopReason: "end_turn",
    });
    const mock = await createBrowserMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete },
    });
    await mock.invoke("save_api_key", {
      provider: "sakana",
      key: "sakana-key",
    });
    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "sakana",
        model: "fugu",
        modelApiVariant: "responses",
        ollamaEndpoint: "http://localhost:11434",
      },
    });

    await mock.invoke("send_chat_message", {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "sakana",
        apiVariant: null,
      }),
    );
    mock.close();
  });

  it("returns the structured chat payload expected by the real editor", async () => {
    const authorizeAiRequest = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "real response" }],
      stopReason: "end_turn",
      inputTokens: 4,
      outputTokens: 2,
    });
    const mock = await createBrowserMock({
      authorizeAiRequest,
      aiTransport: { complete },
    });

    const result = await mock.invoke<{
      blocks: Array<{ type: string; content: string }>;
      stopReason: string;
    }>("send_chat_message", {
      messages: [{ role: "user", content: "hello" }],
      provider: "openai",
      model: "gpt-4.1-mini",
      endpointId: "primary",
    });

    expect(authorizeAiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "chat", provider: "openai" }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "chat",
        provider: "openai",
        model: "gpt-4.1-mini",
        endpointId: "primary",
      }),
    );
    expect(result).toEqual({
      blocks: [{ type: "text", content: "real response" }],
      stopReason: "end_turn",
      inputTokens: 4,
      outputTokens: 2,
    });
  });

  it("does not reach the provider when consent authorization fails", async () => {
    const complete = vi.fn();
    const mock = await createBrowserMock({
      authorizeAiRequest: vi
        .fn()
        .mockRejectedValue(new Error("ai-data-consent-required")),
      aiTransport: { complete },
    });

    await expect(
      mock.invoke("send_chat_message", {
        messages: [{ role: "user", content: "private manuscript" }],
        provider: "openai",
        model: "gpt-5-mini",
      }),
    ).rejects.toThrow("ai-data-consent-required");
    expect(complete).not.toHaveBeenCalled();
  });

  it("authorizes credentialed model discovery before contacting a provider", async () => {
    const order: string[] = [];
    const authorizeAiRequest = vi.fn(async () => {
      order.push("authorize");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("provider");
        return Response.json({ data: [] });
      }),
    );
    const mock = await createBrowserMock({ authorizeAiRequest });
    await mock.invoke("save_api_key", {
      provider: "openai",
      key: "disposable-test-key",
    });

    await expect(
      mock.invoke("list_ai_models", { provider: "openai" }),
    ).resolves.toEqual([]);
    expect(order).toEqual(["authorize", "provider"]);
    expect(authorizeAiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "connection",
        provider: "openai",
        hasApiKey: true,
      }),
    );
    vi.unstubAllGlobals();
  });

  it("uses and discloses the configured Ollama endpoint on every AI surface", async () => {
    const authorizeAiRequest = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ models: [] }))
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: "Connection OK" } }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: "Agent OK" } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const mock = await createBrowserMock({ authorizeAiRequest });
    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "ollama",
        model: "qwen3:8b",
        ollamaEndpoint: "http://192.0.2.10:11434",
      },
    });

    await mock.invoke("list_ai_models", { provider: "ollama" });
    await mock.invoke("test_ai_connection", { provider: "ollama" });
    await mock.invoke("send_agent_message", {
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://192.0.2.10:11434/api/tags",
      "http://192.0.2.10:11434/v1/chat/completions",
      "http://192.0.2.10:11434/v1/chat/completions",
    ]);
    expect(authorizeAiRequest).toHaveBeenCalledTimes(3);
    for (const [request] of authorizeAiRequest.mock.calls) {
      expect(request).toEqual(
        expect.objectContaining({
          provider: "ollama",
          ollamaEndpoint: "http://192.0.2.10:11434",
        }),
      );
    }
    vi.unstubAllGlobals();
  });

  it("emits the existing chat stream wire and can abort it", async () => {
    let releaseStream: (() => void) | undefined;
    const stream = vi.fn(
      async (
        _request: unknown,
        sink: {
          text(delta: string): void;
          done(payload: {
            stopReason: string;
            inputTokens?: number;
            outputTokens?: number;
          }): void;
        },
      ) => {
        sink.text("本物");
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        sink.done({ stopReason: "end_turn", inputTokens: 3, outputTokens: 1 });
      },
    );
    const abort = vi.fn(() => releaseStream?.());
    const mock = await createBrowserMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort },
    });
    const chunks: unknown[] = [];
    const done: unknown[] = [];
    window.addEventListener("chat:stream-chunk", (event) => {
      chunks.push((event as CustomEvent).detail);
    });
    window.addEventListener("chat:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });

    const running = mock.invoke("send_chat_message_stream", {
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });
    await vi.waitFor(() =>
      expect(chunks).toEqual([{ delta: "本物", block_type: "text" }]),
    );
    await mock.invoke("abort_chat_stream");
    await running;

    expect(abort).toHaveBeenCalledWith("chat");
    expect(done).toEqual([
      { stop_reason: "end_turn", input_tokens: 3, output_tokens: 1 },
    ]);
  });

  it("emits inline AI events instead of resolving as a no-op", async () => {
    const stream = vi.fn(
      async (
        request: { operation: string },
        sink: {
          text(delta: string): void;
          done(payload: { stopReason: string }): void;
        },
      ) => {
        expect(request.operation).toBe("inline");
        sink.text("続き");
        sink.done({ stopReason: "end_turn" });
      },
    );
    const mock = await createBrowserMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort: vi.fn() },
    });
    const chunks: unknown[] = [];
    const done: unknown[] = [];
    window.addEventListener("inline-ai:stream-chunk", (event) => {
      chunks.push((event as CustomEvent).detail);
    });
    window.addEventListener("inline-ai:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });

    await mock.invoke("send_inline_ai_stream", {
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });

    expect(chunks).toEqual([{ delta: "続き", block_type: "text" }]);
    expect(done).toEqual([
      {
        stop_reason: "end_turn",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });

  it("keeps BYOK agent requests on the selected direct transport", async () => {
    const completeAgent = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "BYOK agent response" }],
      stopReason: "end_turn",
    });
    const mock = await createBrowserMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: {
        complete: vi.fn(),
        completeAgent,
      },
    });
    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "openai",
        model: "gpt-5-mini",
        ollamaEndpoint: "http://localhost:11434",
        toolProtocolMode: "hermes",
      },
    });
    await mock.invoke("save_api_key", {
      provider: "openai",
      key: "sk-user-owned",
    });
    const messages = [{ role: "user", content: "相談" }];
    const tools = [
      {
        name: "lookup",
        description: "Lookup",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];

    const result = await mock.invoke("send_agent_message", {
      messages,
      tools,
    });

    expect(completeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5-mini",
        toolProtocolMode: "hermes",
      }),
      messages,
      tools,
    );
    expect(result).toEqual({
      blocks: [{ type: "text", content: "BYOK agent response" }],
      stopReason: "end_turn",
    });
  });
});
