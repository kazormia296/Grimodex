import { describe, it, expect, beforeEach, vi } from "vitest";

type ListenHandler = (payload: unknown) => void;

const listeners = new Map<string, ListenHandler>();
const invokeMock = vi.fn();
const listenMock = vi.fn(async (eventName: string, handler: ListenHandler) => {
  listeners.set(eventName, handler);
  return () => {
    if (listeners.get(eventName) === handler) {
      listeners.delete(eventName);
    }
  };
});

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: (...args: unknown[]) =>
    listenMock(...(args as [string, ListenHandler])),
}));

vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    expectedWorkspacePath: "/workspace",
    operationId: "operation-test",
    executionId: "execution-test",
    parentExecutionId: null,
    startedAt: 1,
  })),
  markAiAuditDispatched: vi.fn(async () => undefined),
  completeAiAuditExecution: vi.fn(async () => undefined),
  failAiAuditExecution: vi.fn(async () => undefined),
  cancelAiAuditExecution: vi.fn(async () => undefined),
  recordAiAuditPartial: vi.fn(async () => undefined),
  recordAiAuditPartials: vi.fn(async () => undefined),
}));

const auditContext = { projectId: "project-1", pathId: "inline_ai_stream" };

import { sendInlineAiStream, abortInlineAiStream } from "./inlineAiStreaming";

function emit(event: string, payload: unknown) {
  const handler = listeners.get(event);
  handler?.(payload);
}

describe("inlineAiStreaming", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    listenMock.mockClear();
  });

  it("streams text deltas in order and resolves on done", async () => {
    invokeMock.mockResolvedValue(undefined);

    const onTextDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const cleanup = await sendInlineAiStream(
      [{ role: "user", content: "hi" }],
      auditContext,
      { onTextDelta, onDone, onError },
    );

    emit("inline-ai:stream-chunk", {
      streamId: "execution-test",
      delta: "Hello",
      block_type: "text",
    });
    emit("inline-ai:stream-chunk", {
      streamId: "execution-test",
      delta: "ignored",
      block_type: "thinking",
    });
    emit("inline-ai:stream-chunk", {
      streamId: "execution-test",
      delta: ", world",
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      streamId: "execution-test",
      stop_reason: "end_turn",
      input_tokens: 10,
      output_tokens: 5,
    });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());

    expect(onTextDelta).toHaveBeenCalledTimes(2);
    expect(onTextDelta).toHaveBeenNthCalledWith(1, "Hello");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, ", world");
    expect(onDone).toHaveBeenCalledWith({
      stopReason: "end_turn",
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(onError).not.toHaveBeenCalled();

    cleanup();
    expect(listeners.size).toBe(0);
  });

  it("reports errors via onError", async () => {
    invokeMock.mockResolvedValue(undefined);

    const onTextDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    await sendInlineAiStream([{ role: "user", content: "hi" }], auditContext, {
      onTextDelta,
      onDone,
      onError,
    });

    emit("inline-ai:stream-error", {
      streamId: "execution-test",
      message: "boom",
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(onError).toHaveBeenCalledWith("boom");
  });

  it("invokes the backend abort command", async () => {
    invokeMock.mockResolvedValue({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    await expect(abortInlineAiStream("execution-test")).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("abort_inline_ai_stream", {
      streamId: "execution-test",
    });
  });

  it("calls send_inline_ai_stream with the expected shape", async () => {
    invokeMock.mockResolvedValue(undefined);

    await sendInlineAiStream([{ role: "user", content: "hi" }], auditContext, {
      onTextDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    expect(invokeMock).toHaveBeenCalledWith("send_inline_ai_stream", {
      messages: [{ role: "user", content: "hi" }],
      thinking: null,
      effort: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      model: null,
      apiVariant: null,
      provider: null,
      endpointId: null,
      streamId: "execution-test",
      auditContext: {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        operationId: "operation-test",
        executionId: "execution-test",
        parentExecutionId: null,
        pathId: "inline_ai_stream",
      },
    });
  });

  it("registers every stream listener before provider dispatch", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_inline_ai_stream") {
        expect(listeners.has("inline-ai:stream-chunk")).toBe(true);
        expect(listeners.has("inline-ai:stream-done")).toBe(true);
        expect(listeners.has("inline-ai:stream-error")).toBe(true);
      }
      return undefined;
    });

    await sendInlineAiStream(
      [{ role: "user", content: "first event must be observable" }],
      auditContext,
      {
        onTextDelta: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
    );

    expect(invokeMock).toHaveBeenCalledWith(
      "send_inline_ai_stream",
      expect.any(Object),
    );
  });
});
