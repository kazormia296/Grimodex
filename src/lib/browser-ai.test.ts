import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  completeBrowserAiRequest,
  createBrowserAiTransport,
  fetchModels,
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
  it("uses provider HTTPS APIs in production while keeping Vite dev proxies", () => {
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

  it("fetches models from the configured Ollama endpoint", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ models: [] }));

    await fetchModels("ollama", "", "http://192.0.2.10:11434");

    expect(mockFetch.mock.calls[0][0]).toBe("http://192.0.2.10:11434/api/tags");
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
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: ["Connection OK"] }),
    );

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
