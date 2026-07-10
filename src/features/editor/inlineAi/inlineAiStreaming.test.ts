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
      { onTextDelta, onDone, onError },
    );

    emit("inline-ai:stream-chunk", { delta: "Hello", block_type: "text" });
    emit("inline-ai:stream-chunk", {
      delta: "ignored",
      block_type: "thinking",
    });
    emit("inline-ai:stream-chunk", { delta: ", world", block_type: "text" });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 10,
      output_tokens: 5,
    });

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

    await sendInlineAiStream([{ role: "user", content: "hi" }], {
      onTextDelta,
      onDone,
      onError,
    });

    emit("inline-ai:stream-error", { message: "boom" });

    expect(onError).toHaveBeenCalledWith("boom");
  });

  it("invokes the backend abort command", async () => {
    invokeMock.mockResolvedValue(undefined);
    await abortInlineAiStream();
    expect(invokeMock).toHaveBeenCalledWith("abort_inline_ai_stream");
  });

  it("calls send_inline_ai_stream with the expected shape", async () => {
    invokeMock.mockResolvedValue(undefined);

    await sendInlineAiStream([{ role: "user", content: "hi" }], {
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
    });
  });
});
