import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  completeBrowserAiRequest,
  createBrowserAiTransport,
  fetchModels,
  resolveBrowserAiEndpoint,
  sendChat,
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

  it("sends OpenRouter request with extra headers", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: "Response" } }],
      }),
    );

    await sendChat("openrouter", "auto", "sk-or", [
      { role: "user", content: "Test" },
    ]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/openrouter/chat/completions");
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
      resolveBrowserAiEndpoint("anthropic", "chat", {
        development: false,
      }),
    ).toBe("https://api.anthropic.com/v1/messages");
    expect(
      resolveBrowserAiEndpoint("openai", "chat", { development: true }),
    ).toBe("/api/openai/chat/completions");
  });

  it("fails explicitly for native-only providers", () => {
    expect(() =>
      resolveBrowserAiEndpoint("cli", "chat", { development: false }),
    ).toThrow("not supported in browser mode");
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
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
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

  it("fetches OpenRouter models with extra headers", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: "auto", name: "Auto" }] }),
    );

    await fetchModels("openrouter", "sk-or");
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["HTTP-Referer"]).toBe(
      "https://github.com/kazormia296/Grimodex",
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
});
