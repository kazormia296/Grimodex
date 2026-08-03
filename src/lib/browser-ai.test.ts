import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BrowserAiConnectionError,
  browserAiFetch,
  classifyBrowserAiAddressSpace,
  completeBrowserAiRequest,
  createBrowserAiTransport,
  fetchModels,
  isBrowserLocalEndpoint,
  resolveBrowserAiEndpoint,
  sendChat,
  sendChatWithTools,
  testConnection,
} from "./browser-ai";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("browser local-network request policy", () => {
  it.each([
    ["http://localhost:11434", "loopback"],
    ["http://127.0.0.1:1234/v1", "loopback"],
    ["http://[::1]:11434", "loopback"],
    ["http://192.168.1.50:1234/v1", "local"],
    ["http://172.20.0.4:8080", "local"],
    ["http://[fd12:3456::1]:8080", "local"],
    ["http://[fe90::1]:8080", "local"],
    ["http://printer.local:8080", "local"],
    ["https://fd.example.com/v1", undefined],
    ["https://api.example.com/v1", undefined],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(classifyBrowserAiAddressSpace(url)).toBe(expected);
  });

  it("identifies configured local endpoints without treating public HTTPS as local", () => {
    expect(isBrowserLocalEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isBrowserLocalEndpoint("http://192.168.1.20:11434")).toBe(true);
    expect(isBrowserLocalEndpoint("https://gateway.example/v1")).toBe(false);
  });

  it("passes the browser targetAddressSpace hint to local requests", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await browserAiFetch("http://192.168.1.20:1234/v1/models", {
      headers: { accept: "application/json" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://192.168.1.20:1234/v1/models",
      expect.objectContaining({ targetAddressSpace: "local" }),
    );
  });

  it("lets an HTTPS page use the browser LNA permission flow for an HTTP LAN endpoint", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "https://try.grimodex.app/editor",
        protocol: "https:",
      },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    try {
      await browserAiFetch("http://192.168.1.20:1234/v1/models");
    } finally {
      vi.stubGlobal("window", undefined);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "http://192.168.1.20:1234/v1/models",
      expect.objectContaining({ targetAddressSpace: "local" }),
    );
  });

  it("normalizes a local fetch rejection into a permission error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(
      browserAiFetch("http://192.168.1.20:1234/v1/models"),
    ).rejects.toMatchObject<Partial<BrowserAiConnectionError>>({
      code: "local-network-permission",
    });
  });
});

describe("sendChat", () => {
  it("sends Anthropic request with system extraction", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ text: "Hello!" }] }),
    );

    const result = await sendChat("anthropic", "claude-sonnet-4-6", "sk-test", [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ]);

    expect(result).toBe("Hello!");
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/anthropic/messages");
    expect(opts.headers["x-api-key"]).toBe("sk-test");
    expect(opts.headers["anthropic-version"]).toBe("2023-06-01");
    expect(opts.headers["anthropic-dangerous-direct-browser-access"]).toBe(
      "true",
    );

    const body = JSON.parse(opts.body);
    expect(body.system).toBe("You are helpful.");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(body.max_tokens).toBe(4096);
  });

  it("sends OpenAI request with Bearer auth", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: "Hi from OpenAI" } }],
      }),
    );

    const result = await sendChat("openai", "gpt-4o", "sk-openai", [
      { role: "user", content: "Hello" },
    ]);

    expect(result).toBe("Hi from OpenAI");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/openai/chat/completions");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-openai");
  });

  it("sends OpenRouter requests with BYOK and attribution headers", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: "OpenRouter says hi" } }],
      }),
    );

    await expect(
      sendChat("openrouter", "openai/gpt-5-mini", "sk-or", [
        { role: "user", content: "Test" },
      ]),
    ).resolves.toBe("OpenRouter says hi");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(opts.headers.Authorization).toBe("Bearer sk-or");
    expect(opts.headers["HTTP-Referer"]).toBe(
      "https://github.com/kazormia296/Grimodex",
    );
    expect(opts.headers["X-Title"]).toBe("Grimodex");
  });

  it("sends Ollama request without auth", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: "Ollama says hi" } }],
      }),
    );

    await sendChat("ollama", "llama3", "", [{ role: "user", content: "Hi" }]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/ollama/v1/chat/completions");
    expect(opts.headers["Authorization"]).toBeUndefined();
  });

  it("throws on error response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid API key" } }, 401),
    );

    await expect(
      sendChat("openai", "gpt-4o", "bad-key", [
        { role: "user", content: "Hi" },
      ]),
    ).rejects.toThrow("AI request failed (401): Invalid API key");
  });
});

describe("browser production endpoints", () => {
  it("resolves every Web Editor provider endpoint", () => {
    expect(
      resolveBrowserAiEndpoint("openai", "chat", { development: false }),
    ).toBe("https://api.openai.com/v1/chat/completions");
    expect(
      resolveBrowserAiEndpoint("openrouter", "models", {
        development: false,
      }),
    ).toBe("https://openrouter.ai/api/v1/models");
    expect(
      resolveBrowserAiEndpoint("sakana", "chat", {
        development: true,
      }),
    ).toBe("/api/sakana/chat/completions");
    expect(
      resolveBrowserAiEndpoint("ai-novelist", "chat", {
        development: false,
        apiVariant: "v1",
      }),
    ).toBe("https://api.tringpt.com/v1/chat/completions");
    expect(
      resolveBrowserAiEndpoint("openai-compatible", "chat", {
        development: false,
        baseUrl: "https://llm.example/v1/",
      }),
    ).toBe("https://llm.example/v1/chat/completions");
    expect(
      resolveBrowserAiEndpoint("anthropic", "chat", {
        development: false,
      }),
    ).toBe("https://api.anthropic.com/v1/messages");
    expect(
      resolveBrowserAiEndpoint("ollama", "chat", {
        development: false,
        ollamaEndpoint: "http://localhost:11434",
      }),
    ).toBe("http://localhost:11434/v1/chat/completions");
    expect(
      resolveBrowserAiEndpoint("openai", "chat", { development: true }),
    ).toBe("/api/openai/chat/completions");
  });

  it("honors an explicitly configured Ollama endpoint in development", () => {
    expect(
      resolveBrowserAiEndpoint("ollama", "models", {
        development: true,
        ollamaEndpoint: "http://192.0.2.10:11434/",
      }),
    ).toBe("http://192.0.2.10:11434/api/tags");
    expect(
      resolveBrowserAiEndpoint("ollama", "chat", {
        development: true,
        ollamaEndpoint: "http://192.0.2.10:11434/",
      }),
    ).toBe("http://192.0.2.10:11434/v1/chat/completions");
  });

  it("fails explicitly for native-only providers", () => {
    expect(() =>
      resolveBrowserAiEndpoint("cli", "chat", { development: false }),
    ).toThrow("not supported in browser mode");
  });

  it("requires a configured base URL for OpenAI-compatible routes", () => {
    expect(() =>
      resolveBrowserAiEndpoint("openai-compatible", "chat", {
        development: false,
      }),
    ).toThrow(/base URL/i);
  });
});

describe("structured browser AI transport", () => {
  it("normalizes provider text, stop reason, and usage", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [
          { message: { content: "Actual response" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    );

    await expect(
      completeBrowserAiRequest({
        operation: "chat",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).resolves.toEqual({
      blocks: [{ type: "text", content: "Actual response" }],
      stopReason: "end_turn",
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("parses OpenAI-compatible SSE into the shared stream sink", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"本"}}]}',
          'data: {"choices":[{"delta":{"content":"物"},"finish_reason":"stop"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
          'data: {"choices":[{"delta":{"content":"漏"},"finish_reason":"length"}]}',
          "data: {malformed-json",
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const transport = createBrowserAiTransport();
    const text: string[] = [];
    const done: unknown[] = [];

    await transport.stream?.(
      {
        operation: "chat",
        streamId: "stream-chat-1",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        messages: [{ role: "user", content: "Hello" }],
      },
      {
        text: (delta) => text.push(delta),
        done: (payload) => done.push(payload),
      },
    );

    expect(text).toEqual(["本", "物"]);
    expect(done).toEqual([
      { stopReason: "end_turn", inputTokens: 5, outputTokens: 2 },
    ]);
  });

  it("keeps the first provider terminal when the stream errors afterward", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            streamController.enqueue(
              encoder.encode(
                [
                  'data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}',
                  'data: {"choices":[{"delta":{"content":"must-not-escape"},"finish_reason":"length"}]}',
                  "data: {malformed-json",
                  "",
                ].join("\n\n"),
              ),
            );
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const transport = createBrowserAiTransport();
    const text: string[] = [];
    const done: string[] = [];
    const running = transport.stream?.(
      {
        operation: "chat",
        streamId: "stream-terminal-then-error",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        messages: [{ role: "user", content: "continue" }],
      },
      {
        text: (delta) => text.push(delta),
        done: (payload) => done.push(payload.stopReason),
      },
    );
    await vi.waitFor(() => expect(text).toEqual(["final"]));

    controller?.error(new Error("Authorization: Bearer must-not-surface"));
    await expect(running).resolves.toBeUndefined();
    expect(text).toEqual(["final"]);
    expect(done).toEqual(["end_turn"]);
  });

  it("keeps same-operation streams isolated by streamId and aborts only the target", async () => {
    let firstSignal: AbortSignal | undefined;
    mockFetch
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            firstSignal = init.signal ?? undefined;
            firstSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const transport = createBrowserAiTransport();
    const aDone: string[] = [];
    const bText: string[] = [];

    const streamA = transport.stream?.(
      {
        operation: "chat",
        streamId: "stream-a",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        messages: [{ role: "user", content: "A" }],
      },
      {
        text: () => undefined,
        done: (payload) => aDone.push(payload.stopReason),
      },
    );
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const streamB = transport.stream?.(
      {
        operation: "chat",
        streamId: "stream-b",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        messages: [{ role: "user", content: "B" }],
      },
      {
        text: (delta) => bText.push(delta),
        done: () => undefined,
      },
    );

    await expect(streamB).resolves.toBeUndefined();
    expect(bText).toEqual(["B"]);
    expect(firstSignal?.aborted).toBe(false);
    await expect(transport.abort?.("wrong-stream")).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    expect(firstSignal?.aborted).toBe(false);

    await expect(transport.abort?.("stream-a")).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await expect(streamA).resolves.toBeUndefined();
    expect(aDone).toEqual(["stopped"]);
  });

  it("turns an abort-before-register tombstone into a stopped stream without provider dispatch", async () => {
    const transport = createBrowserAiTransport();
    await expect(transport.abort?.("stream-before-register")).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    const done: string[] = [];

    await transport.stream?.(
      {
        operation: "inline",
        streamId: "stream-before-register",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        messages: [{ role: "user", content: "continue" }],
      },
      {
        text: () => undefined,
        done: (payload) => done.push(payload.stopReason),
      },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(done).toEqual(["stopped"]);
  });

  it.each([
    {
      provider: "openai" as const,
      sse: 'data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\n',
    },
    {
      provider: "anthropic" as const,
      sse: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"final"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        "",
      ].join("\n\n"),
    },
  ])(
    "preserves $provider provider success when its terminal marker precedes abort",
    async ({ provider, sse }) => {
      let signal: AbortSignal | undefined;
      const encoder = new TextEncoder();
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                signal = init.signal ?? undefined;
                controller.enqueue(encoder.encode(sse));
                signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(new DOMException("aborted", "AbortError")),
                  { once: true },
                );
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          ),
        ),
      );
      const transport = createBrowserAiTransport();
      const text: string[] = [];
      const done: string[] = [];
      const running = transport.stream?.(
        {
          operation: "chat",
          streamId: `stream-${provider}-terminal`,
          provider,
          model: "test-model",
          apiKey: "sk-test",
          messages: [{ role: "user", content: "continue" }],
        },
        {
          text: (delta) => text.push(delta),
          done: (payload) => done.push(payload.stopReason),
        },
      );
      await vi.waitFor(() => expect(text).toEqual(["final"]));

      await expect(
        transport.abort?.(`stream-${provider}-terminal`),
      ).resolves.toEqual({
        abortCommandAcknowledged: true,
        transportTerminationObserved: true,
      });
      await running;
      expect(signal?.aborted).toBe(true);
      expect(done).toEqual(["end_turn"]);
    },
  );

  it("rejects a non-trimmed streamId before provider dispatch", async () => {
    const transport = createBrowserAiTransport();
    await expect(
      transport.stream?.(
        {
          operation: "chat",
          streamId: " stream-with-space ",
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "continue" }],
        },
        { text: () => undefined, done: () => undefined },
      ),
    ).rejects.toThrow(/trimmed non-empty/iu);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses the AI Novelist legacy chat contract", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: ["返答"] }));

    await expect(
      completeBrowserAiRequest({
        operation: "chat",
        provider: "ai-novelist",
        model: "spiko",
        apiKey: "novelist-key",
        apiVariant: "legacy",
        messages: [
          { role: "system", content: "小説家として回答する" },
          { role: "user", content: "続きを考えて" },
        ],
      }),
    ).resolves.toMatchObject({
      blocks: [{ type: "text", content: "返答" }],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      messages: [
        {
          role: "user",
          content: "小説家として回答する\n\n続きを考えて",
        },
      ],
      model: "spiko",
      max_tokens: 4096,
    });
  });

  it("uses the AI Novelist legacy completion contract for inline AI", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: ["続き"] }));

    await expect(
      completeBrowserAiRequest({
        operation: "inline",
        provider: "ai-novelist",
        model: "damsel",
        apiKey: "novelist-key",
        apiVariant: "legacy",
        messages: [
          { role: "system", content: "続きを書く" },
          { role: "user", content: "雨が降り始めた。" },
        ],
      }),
    ).resolves.toMatchObject({
      blocks: [{ type: "text", content: "続き" }],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      text: "[system]\n続きを書く\n\n[user]\n雨が降り始めた。",
      model: "damsel",
      length: 400,
    });
  });
});

describe("fetchModels", () => {
  it("returns static list for Anthropic", async () => {
    const models = await fetchModels("anthropic", "sk-test");
    expect(models).toHaveLength(6);
    expect(models[0].id).toBe("claude-fable-5");
    expect(models[4].id).toBe("claude-sonnet-4-6");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches OpenAI models", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "gpt-4o-mini" }],
      }),
    );

    const models = await fetchModels("openai", "sk-test");
    expect(models).toEqual([
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "gpt-4o-mini" },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/openai/models");
  });

  it("fetches Ollama models", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [{ name: "llama3" }, { name: "codellama" }],
      }),
    );

    const models = await fetchModels("ollama", "");
    expect(models).toEqual([
      { id: "llama3", name: "llama3" },
      { id: "codellama", name: "codellama" },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/ollama/api/tags");
  });

  it("keeps the Ollama model maximum separate from the running context", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              name: "gemma4:latest",
              model: "gemma4:latest",
              digest: "sha256:a",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              name: "gemma4:latest",
              digest: "sha256:a",
              context_length: 4096,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: {
            "general.architecture": "gemma4",
            "gemma4.context_length": 131072,
          },
          parameters: "num_ctx 32768",
          capabilities: ["completion", "tools", "thinking"],
        }),
      );

    await expect(fetchModels("ollama", "")).resolves.toEqual([
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131072,
        effectiveContextLength: 4096,
        effectiveContextSource: "runner",
        supportedParameters: ["tools", "reasoning"],
      },
    ]);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/ollama/api/tags",
      "/api/ollama/api/ps",
      "/api/ollama/api/show",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
      model: "gemma4:latest",
    });
  });

  it("uses an Ollama model num_ctx when no runner is loaded", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: "local-model:latest" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: {
            "general.architecture": "custom",
            "custom.context_length": 65536,
          },
          parameters: "temperature 0.8\nPARAMETER num_ctx = 16384",
          capabilities: ["tools"],
        }),
      );

    await expect(fetchModels("ollama", "")).resolves.toEqual([
      {
        id: "local-model:latest",
        name: "local-model:latest",
        contextLength: 65536,
        effectiveContextLength: 16384,
        effectiveContextSource: "model-parameter",
        supportedParameters: ["tools"],
      },
    ]);
  });

  it("uses only a prompt-free control-plane preload for the selected cold Ollama model", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            { name: "gemma4:latest" },
            { name: "slow-unrelated:latest" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "gemma4.context_length": 131072 },
          capabilities: ["completion"],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ done: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          models: [{ name: "gemma4:latest", context_length: 32768 }],
        }),
      );

    await expect(
      fetchModels("ollama", "", { selectedModelId: "gemma4:latest" }),
    ).resolves.toEqual([
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131072,
        effectiveContextLength: 32768,
        effectiveContextSource: "runner",
        supportedParameters: [],
      },
    ]);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/ollama/api/tags",
      "/api/ollama/api/ps",
      "/api/ollama/api/show",
      "/api/ollama/api/generate",
      "/api/ollama/api/ps",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
      model: "gemma4:latest",
    });
    expect(JSON.parse(mockFetch.mock.calls[3][1].body)).toEqual({
      model: "gemma4:latest",
      stream: false,
    });
  });

  it("aborts stalled selected Ollama metadata probes at their deadlines", async () => {
    vi.useFakeTimers();
    try {
      let showSignal: AbortSignal | undefined;
      let loadSignal: AbortSignal | undefined;
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({ models: [{ name: "gemma4:latest" }] }),
        )
        .mockResolvedValueOnce(jsonResponse({ models: [] }))
        .mockImplementationOnce(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              showSignal = init?.signal ?? undefined;
              showSignal?.addEventListener(
                "abort",
                () =>
                  reject(
                    new DOMException("The operation was aborted", "AbortError"),
                  ),
                { once: true },
              );
            }),
        )
        .mockImplementationOnce(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              loadSignal = init?.signal ?? undefined;
              loadSignal?.addEventListener(
                "abort",
                () =>
                  reject(
                    new DOMException("The operation was aborted", "AbortError"),
                  ),
                { once: true },
              );
            }),
        );

      const request = fetchModels("ollama", "", {
        selectedModelId: "gemma4:latest",
      });
      const result = expect(request).resolves.toEqual([
        { id: "gemma4:latest", name: "gemma4:latest" },
      ]);

      await vi.runAllTimersAsync();
      await result;
      expect(showSignal?.aborted).toBe(true);
      expect(loadSignal?.aborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(4);
      // Completed /tags and /ps requests need not be retroactively aborted;
      // pending metadata and model-load requests must be cancelled.
      expect(mockFetch.mock.calls[2]?.[1].signal?.aborted).toBe(true);
      expect(mockFetch.mock.calls[3]?.[1].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reads /api/show when /api/ps reaches its per-request deadline", async () => {
    vi.useFakeTimers();
    try {
      let runnerSignal: AbortSignal | undefined;
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({ models: [{ name: "gemma4:latest" }] }),
        )
        .mockImplementationOnce(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              runnerSignal = init?.signal ?? undefined;
              runnerSignal?.addEventListener(
                "abort",
                () =>
                  reject(
                    new DOMException("The operation was aborted", "AbortError"),
                  ),
                { once: true },
              );
            }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            model_info: { "gemma4.context_length": 131_072 },
            capabilities: ["completion", "tools"],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ done: true }))
        .mockResolvedValueOnce(
          jsonResponse({
            models: [{ name: "gemma4:latest", context_length: 16_384 }],
          }),
        );

      const request = fetchModels("ollama", "", {
        selectedModelId: "gemma4:latest",
      });
      const result = expect(request).resolves.toEqual([
        {
          id: "gemma4:latest",
          name: "gemma4:latest",
          contextLength: 131_072,
          effectiveContextLength: 16_384,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);

      await vi.advanceTimersByTimeAsync(5_000);
      await result;
      expect(runnerSignal?.aborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Ollama tags usable when runtime metadata probes fail", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: "offline-runner:latest" }] }),
      )
      .mockRejectedValueOnce(new TypeError("ps unavailable"))
      .mockResolvedValueOnce(jsonResponse({ error: "show unavailable" }, 500));

    await expect(fetchModels("ollama", "")).resolves.toEqual([
      { id: "offline-runner:latest", name: "offline-runner:latest" },
    ]);
  });

  it("returns a tag-only selected Ollama row when /api/show is unavailable", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: "offline-runner:latest" }] }),
      )
      .mockRejectedValueOnce(new TypeError("ps unavailable"))
      .mockResolvedValueOnce(jsonResponse({ error: "show unavailable" }, 500));

    await expect(
      fetchModels("ollama", "", {
        selectedModelId: "offline-runner:latest",
      }),
    ).resolves.toEqual([
      { id: "offline-runner:latest", name: "offline-runner:latest" },
    ]);
  });

  it("fetches models from the configured Ollama endpoint", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ models: [] }));

    await fetchModels("ollama", "", {
      ollamaEndpoint: "http://192.168.2.10:11434",
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "http://192.168.2.10:11434/api/tags",
    );
    expect(mockFetch.mock.calls[0][1].targetAddressSpace).toBe("local");
  });

  it("reports a model-list endpoint that is not implemented", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));

    await expect(
      fetchModels("ollama", "", {
        ollamaEndpoint: "http://192.0.2.10:11434",
      }),
    ).rejects.toMatchObject<Partial<BrowserAiConnectionError>>({
      code: "models-unsupported",
      status: 404,
    });
  });

  it("fetches OpenRouter model metadata", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "openai/gpt-5-mini",
            name: "GPT-5 mini",
            context_length: 400000,
            top_provider: { max_completion_tokens: 128000 },
            supported_parameters: ["tools"],
            pricing: { prompt: "0.1", completion: "0.2" },
          },
        ],
      }),
    );

    await expect(fetchModels("openrouter", "sk-or")).resolves.toEqual([
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 mini",
        contextLength: 400000,
        maxCompletionTokens: 128000,
        supportedParameters: ["tools"],
        pricingPrompt: "0.1",
        pricingCompletion: "0.2",
      },
    ]);
  });

  it("merges AI Novelist legacy and v1 models", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: "spiko_ultra", name: "Spiko Ultra" }] }),
    );

    const models = await fetchModels("ai-novelist", "novelist-key");
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "spiko", apiVariant: "legacy" }),
        expect.objectContaining({ id: "spiko_ultra", apiVariant: "v1" }),
      ]),
    );
  });
});

describe("testConnection", () => {
  it("awaits an observer carrying the exact credential-free bodyJson before fetch", async () => {
    let releaseReceipt!: () => void;
    let receiptStarted!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const started = new Promise<void>((resolve) => {
      receiptStarted = resolve;
    });
    const receipts: Array<{
      kind: string;
      bodyJson: string;
      provider: string;
      model: string;
    }> = [];
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ text: "Connection OK" }] }),
    );

    const running = testConnection(
      "anthropic",
      "claude-sonnet-4-6",
      "secret-that-must-stay-in-headers",
      {},
      {
        auditContext: {
          expectedWorkspacePath: "/workspace",
          projectId: null,
          operationId: "operation-connection",
          executionId: "execution-connection",
          parentExecutionId: null,
          pathId: "ai_connection_test",
        },
        onEffectiveRequest: async (receipt) => {
          receipts.push(receipt);
          receiptStarted();
          await receiptGate;
        },
      },
    );

    await started;
    expect(mockFetch).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: "connection",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(receipts[0].bodyJson).not.toContain(
      "secret-that-must-stay-in-headers",
    );

    releaseReceipt();
    await expect(running).resolves.toBe("Connection OK");
    expect(receipts[0].bodyJson).toBe(mockFetch.mock.calls[0][1].body);
  });

  it("sends minimal request with max_tokens 32", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: "Connection OK" } }],
      }),
    );

    const result = await testConnection("openai", "gpt-4o", "sk-test");
    expect(result).toBe("Connection OK");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(32);
    expect(body.messages[0].content).toBe("Reply with exactly: Connection OK");
  });

  it("extracts Anthropic response correctly", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ text: "Connection OK" }] }),
    );

    const result = await testConnection(
      "anthropic",
      "claude-sonnet-4-6",
      "sk-test",
    );
    expect(result).toBe("Connection OK");
  });

  it("tests and runs tools against the configured Ollama endpoint", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "Connection OK" } }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "Agent OK" } }] }),
      );

    await testConnection("ollama", "qwen3:8b", "", {
      ollamaEndpoint: "http://192.0.2.10:11434",
    });
    await sendChatWithTools(
      "ollama",
      "qwen3:8b",
      "",
      [{ role: "user", content: "hello" }],
      [],
      "auto",
      { ollamaEndpoint: "http://192.0.2.10:11434" },
    );

    expect(mockFetch.mock.calls.map((call) => call[0])).toEqual([
      "http://192.0.2.10:11434/v1/chat/completions",
      "http://192.0.2.10:11434/v1/chat/completions",
    ]);
  });

  it("runs an OpenAI-compatible connection without an API key", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: "Connection OK" } }] }),
    );

    await expect(
      testConnection("openai-compatible", "local-model", "", {
        baseUrl: "http://127.0.0.1:1234/v1/",
      }),
    ).resolves.toBe("Connection OK");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("parses the AI Novelist legacy response shape", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: ["Connection OK"] }));

    await expect(
      testConnection("ai-novelist", "spiko", "novelist-key", {
        apiVariant: "legacy",
      }),
    ).resolves.toBe("Connection OK");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.tringpt.com/api");
    expect(JSON.parse(options.body)).toMatchObject({
      model: "spiko",
      length: 32,
    });
  });
});

describe("effective Browser provider request receipts", () => {
  const auditContext = {
    expectedWorkspacePath: "/workspace",
    projectId: "project-1",
    operationId: "operation-1",
    executionId: "execution-1",
    parentExecutionId: null,
    pathId: "chat_agent_main",
  } as const;

  it("uses one serialized Anthropic completion body for the receipt and fetch", async () => {
    const receipts: Array<{ bodyJson: string; kind: string }> = [];
    const transport = createBrowserAiTransport({
      onEffectiveRequest: async (receipt) => {
        receipts.push(receipt);
      },
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    );

    await transport.complete({
      operation: "chat",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "header-only-secret",
      messages: [
        { role: "system", content: "system one" },
        { role: "system", content: "system two" },
        { role: "user", content: "hello" },
      ],
      maxOutputTokens: 73,
      auditContext,
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe("single");
    expect(receipts[0].bodyJson).toBe(mockFetch.mock.calls[0][1].body);
    expect(JSON.parse(receipts[0].bodyJson)).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 73,
      messages: [{ role: "user", content: "hello" }],
      system: "system one\nsystem two",
    });
    expect(receipts[0].bodyJson).not.toContain("header-only-secret");
  });

  it("observes the exact OpenAI-compatible stream body including usage options", async () => {
    const receipts: Array<{ bodyJson: string; kind: string }> = [];
    const transport = createBrowserAiTransport({
      onEffectiveRequest: async (receipt) => {
        receipts.push(receipt);
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await transport.stream?.(
      {
        operation: "chat",
        streamId: "execution-1",
        provider: "openai-compatible",
        model: "local-model",
        messages: [{ role: "user", content: "stream me" }],
        maxOutputTokens: 91,
        baseUrl: "http://127.0.0.1:1234/v1",
        auditContext,
      },
      { text: vi.fn(), done: vi.fn() },
    );

    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe("stream");
    expect(receipts[0].bodyJson).toBe(mockFetch.mock.calls[0][1].body);
    expect(JSON.parse(receipts[0].bodyJson)).toEqual({
      model: "local-model",
      max_tokens: 91,
      messages: [{ role: "user", content: "stream me" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it.each([
    {
      name: "Anthropic native tool history",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      toolProtocolMode: "native" as const,
      response: { content: [], stop_reason: "end_turn" },
      assertBody(body: Record<string, unknown>) {
        expect(body.system).toBe("agent system");
        expect(body.max_tokens).toBe(123);
        expect(body.tools).toEqual([
          expect.objectContaining({ name: "read_scene" }),
        ]);
        expect(body.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: "assistant" }),
            expect.objectContaining({ role: "user" }),
          ]),
        );
      },
    },
    {
      name: "Hermes transformed tool history",
      provider: "ollama" as const,
      model: "qwen-hermes",
      toolProtocolMode: "hermes" as const,
      response: { choices: [{ message: { content: "done" } }] },
      assertBody(body: Record<string, unknown>) {
        expect(body.max_tokens).toBe(123);
        expect(body).not.toHaveProperty("tools");
        expect(JSON.stringify(body.messages)).toContain("<tools>");
        expect(JSON.stringify(body.messages)).toContain("<tool_call>");
        expect(JSON.stringify(body.messages)).toContain("<tool_response>");
      },
    },
  ])("uses the exact final Agent body for $name", async (fixture) => {
    const receipts: Array<{ bodyJson: string; kind: string }> = [];
    const transport = createBrowserAiTransport({
      onEffectiveRequest: async (receipt) => {
        receipts.push(receipt);
      },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(fixture.response));
    const tools = [
      {
        name: "read_scene",
        description: "Read one scene",
        inputSchema: {
          type: "object" as const,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ];
    const messages = [
      { role: "system" as const, content: "agent system" },
      { role: "user" as const, content: "inspect" },
      {
        role: "assistant" as const,
        content: "",
        toolUses: [
          { id: "call-1", name: "read_scene", input: { id: "scene-1" } },
        ],
      },
      {
        role: "tool_result" as const,
        toolUseId: "call-1",
        content: "scene body",
      },
    ];

    await transport.completeAgent?.(
      {
        operation: "chat",
        provider: fixture.provider,
        model: fixture.model,
        apiKey: fixture.provider === "anthropic" ? "header-secret" : "",
        messages: [],
        maxOutputTokens: 123,
        toolProtocolMode: fixture.toolProtocolMode,
        auditContext,
      },
      messages,
      tools,
    );

    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe("agent");
    expect(receipts[0].bodyJson).toBe(mockFetch.mock.calls[0][1].body);
    fixture.assertBody(JSON.parse(receipts[0].bodyJson));
  });

  it("fails closed before fetch when the effective-request receipt rejects", async () => {
    const receiptError = new Error("durable receipt rejected");
    const transport = createBrowserAiTransport({
      onEffectiveRequest: async () => {
        throw receiptError;
      },
    });

    await expect(
      transport.complete({
        operation: "chat",
        provider: "ollama",
        model: "local-model",
        messages: [{ role: "user", content: "do not send" }],
        auditContext,
      }),
    ).rejects.toBe(receiptError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
