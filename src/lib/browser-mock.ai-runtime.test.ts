// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

// Every createBrowserMock() allocates a full sql.js database inside the
// ASM.js build's fixed heap. Left open they accumulate across the file and
// eventually abort the whole suite with Aborted(OOM) -- the same
// `owned` + afterEach discipline browser-mock.ai-audit.test.ts already
// uses. close() is idempotent, so tests that close explicitly still work.
const owned: PersistentBrowserMock[] = [];

afterEach(() => {
  while (owned.length > 0) owned.pop()?.close();
});

async function createOwnedMock(
  ...args: Parameters<typeof createBrowserMock>
): Promise<PersistentBrowserMock> {
  const mock = await createBrowserMock(...args);
  owned.push(mock);
  return mock;
}

function browserAuditContext(executionId: string) {
  return {
    expectedWorkspacePath: "/dev/workspace",
    projectId: "default-project",
    operationId: `operation-${executionId}`,
    executionId,
    parentExecutionId: null,
    pathId: "browser_byok_web",
  } as const;
}

async function prepareAuditedDispatch(
  mock: Awaited<ReturnType<typeof createBrowserMock>>,
  executionId: string,
) {
  const context = browserAuditContext(executionId);
  const event = (eventType: string, sequence: number) => ({
    eventId: `${executionId}-${sequence}`,
    executionId,
    operationId: context.operationId,
    parentExecutionId: context.parentExecutionId,
    pathId: context.pathId,
    eventType,
    timestamp: sequence,
    payload: {
      captureState: "complete",
      credentialsExcluded: true,
      request: { messages: [{ role: "user", content: executionId }] },
    },
  });
  await mock.invoke("ai_audit_append_batch", {
    expectedWorkspacePath: context.expectedWorkspacePath,
    projectId: context.projectId,
    events: [
      event("execution.started", 1),
      event("request.prepared", 2),
      event("request.dispatched", 3),
    ],
  });
  return context;
}

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
    const mock = await createOwnedMock();

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
  }, 15_000);

  it("resolves the selected OpenAI-compatible endpoint for browser requests", async () => {
    const authorizeAiRequest = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "local response" }],
      stopReason: "end_turn",
    });
    const mock = await createOwnedMock({
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
      auditContext: await prepareAuditedDispatch(mock, "compatible-endpoint"),
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

  it("rejects an Ollama route snapshot after the configured endpoint changes", async () => {
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "must not send" }],
      stopReason: "end_turn",
    });
    const listModels = vi.fn().mockResolvedValue([]);
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete, listModels },
    });
    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "ollama",
        model: "shared-model:latest",
        ollamaEndpoint: "http://127.0.0.1:21434",
      },
    });

    await expect(
      mock.invoke("send_chat_message", {
        messages: [{ role: "user", content: "hello" }],
        provider: "ollama",
        model: "shared-model:latest",
        expectedOllamaEndpoint: "http://127.0.0.1:11434",
        auditContext: await prepareAuditedDispatch(
          mock,
          "ollama-endpoint-mismatch",
        ),
      }),
    ).rejects.toThrow(/Ollama endpoint changed before request/u);
    await expect(
      mock.invoke("list_ai_models", {
        provider: "ollama",
        selectedModelId: "shared-model:latest",
        expectedOllamaEndpoint: "http://127.0.0.1:11434",
      }),
    ).rejects.toThrow(/Ollama endpoint changed before request/u);

    expect(complete).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    mock.close();
  });

  it("removes a retired WebGPU preference and uses the HTTP transport", async () => {
    const authorizeAiRequest = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "local" }],
      stopReason: "end_turn",
    });
    const listModels = vi
      .fn()
      .mockResolvedValue([{ id: "qwen3:8b", name: "qwen3:8b" }]);
    const mock = await createOwnedMock({
      authorizeAiRequest,
      aiTransport: { complete, listModels },
    });

    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "ollama",
        browserAiMode: "webgpu",
        model: "qwen3:8b",
        ollamaEndpoint: "http://localhost:11434",
      },
    });
    const settings =
      await mock.invoke<Record<string, unknown>>("get_ai_settings");
    expect(settings).not.toHaveProperty("browserAiMode");
    expect(
      JSON.parse(localStorage.getItem("grimodex:ai-settings") ?? "{}"),
    ).not.toHaveProperty("browserAiMode");

    await expect(
      mock.invoke("list_ai_models", {
        provider: "ollama",
        selectedModelId: "qwen3:8b",
      }),
    ).resolves.toEqual([{ id: "qwen3:8b", name: "qwen3:8b" }]);
    await mock.invoke("send_chat_message", {
      messages: [{ role: "user", content: "hello" }],
      auditContext: await prepareAuditedDispatch(mock, "retired-webgpu"),
    });

    expect(listModels).toHaveBeenCalledOnce();
    expect(listModels.mock.calls[0]?.[0]).toMatchObject({
      model: "qwen3:8b",
      selectedModelId: "qwen3:8b",
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(listModels.mock.calls[0]?.[0]).not.toHaveProperty("browserAiMode");
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("browserAiMode");
    expect(authorizeAiRequest.mock.calls[0]?.[0]).not.toHaveProperty(
      "browserAiMode",
    );
    mock.close();
  });

  it("falls back from a desktop Responses preference to Web chat transport", async () => {
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "sakana response" }],
      stopReason: "end_turn",
    });
    const mock = await createOwnedMock({
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
      auditContext: await prepareAuditedDispatch(mock, "responses-fallback"),
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
    const mock = await createOwnedMock({
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
      auditContext: await prepareAuditedDispatch(mock, "structured-chat"),
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
    const mock = await createOwnedMock({
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
        auditContext: await prepareAuditedDispatch(mock, "consent-rejected"),
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
    const mock = await createOwnedMock({ authorizeAiRequest });
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
    const mock = await createOwnedMock({ authorizeAiRequest });
    await mock.invoke("save_ai_settings", {
      settings: {
        provider: "ollama",
        model: "qwen3:8b",
        ollamaEndpoint: "http://192.0.2.10:11434",
      },
    });

    await mock.invoke("list_ai_models", { provider: "ollama" });
    await mock.invoke("test_ai_connection", {
      provider: "ollama",
      auditContext: await prepareAuditedDispatch(mock, "ollama-connection"),
    });
    await mock.invoke("send_agent_message", {
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      auditContext: await prepareAuditedDispatch(mock, "ollama-agent"),
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
    const abort = vi.fn(async () => {
      releaseStream?.();
      return {
        abortCommandAcknowledged: true as const,
        transportTerminationObserved: true,
      };
    });
    const mock = await createOwnedMock({
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
      streamId: "stream-chat-1",
      auditContext: await prepareAuditedDispatch(mock, "stream-chat-1"),
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });
    await vi.waitFor(() =>
      expect(chunks).toEqual([
        {
          streamId: "stream-chat-1",
          delta: "本物",
          block_type: "text",
        },
      ]),
    );
    await expect(
      mock.invoke("abort_chat_stream", { streamId: "stream-chat-1" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await running;

    expect(abort).toHaveBeenCalledWith("stream-chat-1");
    expect(done).toEqual([
      {
        streamId: "stream-chat-1",
        stop_reason: "stopped",
        input_tokens: 3,
        output_tokens: 1,
      },
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
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream },
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
      streamId: "stream-inline-1",
      auditContext: await prepareAuditedDispatch(mock, "stream-inline-1"),
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });

    expect(chunks).toEqual([
      {
        streamId: "stream-inline-1",
        delta: "続き",
        block_type: "text",
      },
    ]);
    expect(done).toEqual([
      {
        streamId: "stream-inline-1",
        stop_reason: "end_turn",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });

  it("turns a consent-time abort tombstone into zero provider dispatch and one correlated stopped event", async () => {
    let releaseConsent!: () => void;
    const authorizeAiRequest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseConsent = resolve;
        }),
    );
    const stream = vi.fn(async () => undefined);
    const transportAbort = vi.fn(async () => ({
      abortCommandAcknowledged: true as const,
      transportTerminationObserved: false,
    }));
    const mock = await createOwnedMock({
      authorizeAiRequest,
      aiTransport: { complete: vi.fn(), stream, abort: transportAbort },
    });
    const done: unknown[] = [];
    window.addEventListener("chat:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });

    const running = mock.invoke("send_chat_message_stream", {
      streamId: "stream-consent",
      auditContext: await prepareAuditedDispatch(mock, "stream-consent"),
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });
    await vi.waitFor(() => expect(authorizeAiRequest).toHaveBeenCalledOnce());
    let abortResolved = false;
    const abort = mock
      .invoke("abort_chat_stream", { streamId: "stream-consent" })
      .then((receipt) => {
        abortResolved = true;
        return receipt;
      });
    await Promise.resolve();
    expect(abortResolved).toBe(false);

    releaseConsent();
    await expect(abort).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await running;
    expect(stream).not.toHaveBeenCalled();
    expect(transportAbort).not.toHaveBeenCalled();
    expect(done).toEqual([
      {
        streamId: "stream-consent",
        stop_reason: "stopped",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });

  it("keeps an unknown abort tombstone pending so a later same-ID send performs zero provider dispatch", async () => {
    const stream = vi.fn(async () => undefined);
    const transportAbort = vi.fn(async () => ({
      abortCommandAcknowledged: true as const,
      transportTerminationObserved: false,
    }));
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort: transportAbort },
    });
    const done: unknown[] = [];
    window.addEventListener("inline-ai:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });

    await expect(
      mock.invoke("abort_inline_ai_stream", {
        streamId: "stream-before-send",
      }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    await mock.invoke("send_inline_ai_stream", {
      streamId: "stream-before-send",
      auditContext: await prepareAuditedDispatch(mock, "stream-before-send"),
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });

    expect(stream).not.toHaveBeenCalled();
    expect(transportAbort).not.toHaveBeenCalled();
    expect(done).toEqual([
      {
        streamId: "stream-before-send",
        stop_reason: "stopped",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });

  it("keeps the outer lifecycle receipt when transport abort rejects", async () => {
    let release!: () => void;
    const stream = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const abort = vi.fn(async () => {
      release();
      throw new Error("Authorization: Bearer must-not-surface");
    });
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort },
    });
    const done: unknown[] = [];
    const errors: unknown[] = [];
    window.addEventListener("chat:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });
    window.addEventListener("chat:stream-error", (event) => {
      errors.push((event as CustomEvent).detail);
    });
    const running = mock.invoke("send_chat_message_stream", {
      streamId: "stream-abort-error",
      auditContext: await prepareAuditedDispatch(mock, "stream-abort-error"),
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());

    await expect(
      mock.invoke("abort_chat_stream", { streamId: "stream-abort-error" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await running;
    expect(done).toEqual([
      {
        streamId: "stream-abort-error",
        stop_reason: "stopped",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("isolates concurrent same-operation streams and keeps late aborted deltas correlated for audit", async () => {
    type Sink = {
      text(delta: string): void;
      done(payload: { stopReason: string }): void;
    };
    const controls = new Map<string, { sink: Sink; resolve: () => void }>();
    const stream = vi.fn(
      (request: { streamId?: string }, sink: Sink) =>
        new Promise<void>((resolve) => {
          const streamId = request.streamId ?? "missing";
          controls.set(streamId, { sink, resolve });
          sink.text(`${streamId}:start`);
        }),
    );
    const abort = vi.fn(async (streamId: string) => {
      const control = controls.get(streamId);
      if (!control) {
        return {
          abortCommandAcknowledged: true as const,
          transportTerminationObserved: false,
        };
      }
      control.sink.text(`${streamId}:late-after-abort`);
      control.resolve();
      return {
        abortCommandAcknowledged: true as const,
        transportTerminationObserved: true,
      };
    });
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort },
    });
    const events: Array<{ channel: string; detail: Record<string, unknown> }> =
      [];
    for (const channel of ["chat:stream-chunk", "chat:stream-done"]) {
      window.addEventListener(channel, (event) => {
        events.push({
          channel,
          detail: (event as CustomEvent).detail as Record<string, unknown>,
        });
      });
    }
    await prepareAuditedDispatch(mock, "A");
    await prepareAuditedDispatch(mock, "B");
    const request = (streamId: string) => ({
      streamId,
      auditContext: browserAuditContext(streamId),
      messages: [{ role: "user", content: streamId }],
      provider: "ollama",
      model: "local-model",
    });

    const runningA = mock.invoke("send_chat_message_stream", request("A"));
    await vi.waitFor(() => expect(controls.has("A")).toBe(true));
    const runningB = mock.invoke("send_chat_message_stream", request("B"));
    await vi.waitFor(() => expect(controls.has("B")).toBe(true));

    await expect(
      mock.invoke("abort_chat_stream", { streamId: "wrong" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    expect(controls.get("A")).toBeDefined();
    expect(controls.get("B")).toBeDefined();
    await expect(
      mock.invoke("abort_chat_stream", { streamId: "A" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await runningA;

    controls.get("B")?.sink.text("B:finish");
    controls.get("B")?.sink.done({ stopReason: "end_turn" });
    controls.get("B")?.resolve();
    await runningB;

    expect(events).toEqual([
      {
        channel: "chat:stream-chunk",
        detail: { streamId: "A", delta: "A:start", block_type: "text" },
      },
      {
        channel: "chat:stream-chunk",
        detail: { streamId: "B", delta: "B:start", block_type: "text" },
      },
      {
        channel: "chat:stream-chunk",
        detail: {
          streamId: "A",
          delta: "A:late-after-abort",
          block_type: "text",
        },
      },
      {
        channel: "chat:stream-done",
        detail: {
          streamId: "A",
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        },
      },
      {
        channel: "chat:stream-chunk",
        detail: { streamId: "B", delta: "B:finish", block_type: "text" },
      },
      {
        channel: "chat:stream-done",
        detail: {
          streamId: "B",
          stop_reason: "end_turn",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });

  it("preserves provider success when its terminal is observed before abort", async () => {
    let release!: () => void;
    const stream = vi.fn(
      async (
        _request: unknown,
        sink: { done(payload: { stopReason: string }): void },
      ) => {
        sink.done({ stopReason: "end_turn" });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    );
    const abort = vi.fn(async () => {
      release();
      return {
        abortCommandAcknowledged: true as const,
        transportTerminationObserved: true,
      };
    });
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort },
    });
    const done: unknown[] = [];
    window.addEventListener("chat:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });
    const running = mock.invoke("send_chat_message_stream", {
      streamId: "stream-provider-first",
      auditContext: await prepareAuditedDispatch(mock, "stream-provider-first"),
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });
    await vi.waitFor(() => expect(done).toHaveLength(1));

    await expect(
      mock.invoke("abort_chat_stream", {
        streamId: "stream-provider-first",
      }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await running;
    expect(done).toEqual([
      {
        streamId: "stream-provider-first",
        stop_reason: "end_turn",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });

  it("preserves a provider terminal marker delivered during abort quiescence", async () => {
    let release!: () => void;
    let activeSink:
      | {
          done(payload: {
            stopReason: string;
            providerTerminalObservedBeforeAbort?: boolean;
          }): void;
        }
      | undefined;
    const stream = vi.fn(
      (
        _request: unknown,
        sink: {
          done(payload: {
            stopReason: string;
            providerTerminalObservedBeforeAbort?: boolean;
          }): void;
        },
      ) =>
        new Promise<void>((resolve) => {
          activeSink = sink;
          release = resolve;
        }),
    );
    const abort = vi.fn(async () => {
      activeSink?.done({
        stopReason: "end_turn",
        providerTerminalObservedBeforeAbort: true,
      });
      release();
      return {
        abortCommandAcknowledged: true as const,
        transportTerminationObserved: true,
      };
    });
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort },
    });
    const done: unknown[] = [];
    window.addEventListener("chat:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });
    const running = mock.invoke("send_chat_message_stream", {
      streamId: "stream-provider-marker-first",
      auditContext: await prepareAuditedDispatch(
        mock,
        "stream-provider-marker-first",
      ),
      messages: [{ role: "user", content: "continue" }],
      provider: "ollama",
      model: "local-model",
    });
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());

    await expect(
      mock.invoke("abort_chat_stream", {
        streamId: "stream-provider-marker-first",
      }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await running;
    expect(done).toEqual([
      {
        streamId: "stream-provider-marker-first",
        stop_reason: "end_turn",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });

  it("keeps the first done event and suppresses late content or transport error", async () => {
    const stream = vi.fn(
      async (
        _request: unknown,
        sink: {
          text(delta: string): void;
          done(payload: { stopReason: string }): void;
        },
      ) => {
        sink.done({ stopReason: "end_turn" });
        sink.text("must-not-escape");
        throw new Error("Authorization: Bearer must-not-surface");
      },
    );
    const mock = await createOwnedMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream },
    });
    const chunks: unknown[] = [];
    const done: unknown[] = [];
    const errors: unknown[] = [];
    window.addEventListener("chat:stream-chunk", (event) => {
      chunks.push((event as CustomEvent).detail);
    });
    window.addEventListener("chat:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });
    window.addEventListener("chat:stream-error", (event) => {
      errors.push((event as CustomEvent).detail);
    });

    await expect(
      mock.invoke("send_chat_message_stream", {
        streamId: "stream-terminal-error",
        auditContext: await prepareAuditedDispatch(
          mock,
          "stream-terminal-error",
        ),
        messages: [{ role: "user", content: "continue" }],
        provider: "ollama",
        model: "local-model",
      }),
    ).resolves.toBeUndefined();
    expect(chunks).toEqual([]);
    expect(errors).toEqual([]);
    expect(done).toEqual([
      {
        streamId: "stream-terminal-error",
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
    const mock = await createOwnedMock({
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
      auditContext: await prepareAuditedDispatch(mock, "byok-agent"),
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
