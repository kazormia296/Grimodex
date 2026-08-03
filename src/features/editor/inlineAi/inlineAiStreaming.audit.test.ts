import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();
const order: string[] = [];
const invokeMock = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    order.push(`invoke:${command}`);
    if (command === "abort_inline_ai_stream") {
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved: true,
      };
    }
  }),
);
const beginMock = vi.hoisted(() =>
  vi.fn(async (input: Record<string, unknown>) => {
    order.push("audit:begin");
    return {
      ...input,
      expectedWorkspacePath: "/workspace",
      operationId: input.operationId ?? "operation",
      executionId: "execution",
      parentExecutionId: null,
      startedAt: 1,
    };
  }),
);
const dispatchMock = vi.hoisted(() =>
  vi.fn(async () => {
    order.push("audit:dispatch");
  }),
);
const completeMock = vi.hoisted(() =>
  vi.fn(async () => {
    order.push("audit:complete");
  }),
);
const recordPartialMock = vi.hoisted(() =>
  vi.fn(async (_handle: unknown, response: { streamSequence: number }) => {
    order.push(`audit:partial:${response.streamSequence}`);
  }),
);
const failMock = vi.hoisted(() =>
  vi.fn(async () => {
    order.push("audit:fail");
  }),
);
const cancelMock = vi.hoisted(() =>
  vi.fn(async () => {
    order.push("audit:cancel");
  }),
);

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
  listen: vi.fn(async (event: string, listener: Listener) => {
    listeners.set(event, listener);
    return () => listeners.delete(event);
  }),
}));
vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: beginMock,
  markAiAuditDispatched: dispatchMock,
  completeAiAuditExecution: completeMock,
  failAiAuditExecution: failMock,
  cancelAiAuditExecution: cancelMock,
  attemptAiAuditPersistenceFailureTerminal: vi.fn(async () => undefined),
  recordAiAuditPartial: recordPartialMock,
  recordAiAuditPartials: vi.fn(
    async (
      handle: unknown,
      partials: Array<{ response: { streamSequence: number } }>,
    ) => {
      for (const partial of partials) {
        await recordPartialMock(handle, partial.response);
      }
    },
  ),
}));

import { useAiSettingsStore } from "@/features/chat/store";
import { DEFAULT_AI_SETTINGS } from "@/features/chat/types";
import { sendInlineAiStream } from "./inlineAiStreaming";

const INLINE_PATHS = [
  "AI audit path: inline_ai_stream",
  "AI audit path: ab_inline",
  "AI audit path: beat_generation",
  "AI audit path: beat_alternative",
  "AI audit path: beats_from_synopsis",
  "AI audit path: synopsis_from_beats",
] as const;

function emitInline(
  channel:
    | "inline-ai:stream-chunk"
    | "inline-ai:stream-done"
    | "inline-ai:stream-error",
  payload: Record<string, unknown>,
  streamId = "execution",
): void {
  listeners.get(channel)?.({ streamId, ...payload });
}

describe("inline stream audit contracts", () => {
  beforeEach(() => {
    listeners.clear();
    order.length = 0;
    vi.clearAllMocks();
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openrouter",
        model: "gpt-5.6",
      },
    });
  });

  it.each(INLINE_PATHS)("%s", async (label) => {
    const pathId = label.slice("AI audit path: ".length);
    const onDone = vi.fn();
    const onTextDelta = vi.fn(() => order.push("ui:text"));
    const cleanup = await sendInlineAiStream(
      [{ role: "user", content: `prompt:${pathId}` }],
      { projectId: "project-1", pathId, operationId: "operation-inline" },
      {
        onTextDelta,
        onDone,
        onError: vi.fn(),
      },
    );

    expect(order).toEqual([
      "audit:begin",
      "audit:dispatch",
      "invoke:send_inline_ai_stream",
    ]);
    expect(invokeMock).toHaveBeenCalledWith(
      "send_inline_ai_stream",
      expect.objectContaining({
        streamId: "execution",
        auditContext: expect.objectContaining({
          expectedWorkspacePath: "/workspace",
          projectId: "project-1",
          operationId: "operation-inline",
          pathId,
        }),
      }),
    );
    emitInline("inline-ai:stream-chunk", {
      delta: "answer",
      block_type: "text",
    });
    emitInline("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 3,
      output_tokens: 1,
    });
    emitInline("inline-ai:stream-chunk", {
      delta: "must not escape after terminal snapshot",
      block_type: "text",
    });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(order).toContain("audit:complete");
    expect(onDone).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(completeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        response: { text: "answer", thinking: "", stopReason: "end_turn" },
      }),
    );
    expect(recordPartialMock).toHaveBeenCalledWith(expect.anything(), {
      streamSequence: 1,
      blockType: "text",
      delta: "answer",
    });
    expect(order.indexOf("audit:partial:1")).toBeLessThan(
      order.indexOf("ui:text"),
    );
    expect(order.indexOf("ui:text")).toBeLessThan(
      order.indexOf("audit:complete"),
    );
    cleanup();
  });

  it("flushes inline deltas before failure and cleanup terminals", async () => {
    const onTextDelta = vi.fn(() => order.push("ui:text"));
    const onError = vi.fn(() => order.push("ui:error"));
    await sendInlineAiStream(
      [{ role: "user", content: "prompt" }],
      { projectId: "project-1", pathId: "inline_ai_stream" },
      { onTextDelta, onDone: vi.fn(), onError },
    );
    emitInline("inline-ai:stream-chunk", {
      delta: "before error",
      block_type: "text",
    });
    emitInline("inline-ai:stream-error", { message: "failed" });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(order.indexOf("audit:partial:1")).toBeLessThan(
      order.indexOf("ui:text"),
    );
    expect(order.indexOf("ui:text")).toBeLessThan(order.indexOf("audit:fail"));

    listeners.clear();
    order.length = 0;
    vi.clearAllMocks();
    const cleanup = await sendInlineAiStream(
      [{ role: "user", content: "prompt" }],
      { projectId: "project-1", pathId: "inline_ai_stream" },
      { onTextDelta, onDone: vi.fn(), onError },
    );
    emitInline("inline-ai:stream-chunk", {
      delta: "before cleanup",
      block_type: "text",
    });
    cleanup();
    emitInline("inline-ai:stream-chunk", {
      delta: "observed after cleanup",
      block_type: "text",
    });
    expect(cancelMock).not.toHaveBeenCalled();
    emitInline("inline-ai:stream-done", {
      stop_reason: "stopped",
      input_tokens: null,
      output_tokens: null,
    });
    await vi.waitFor(() => expect(cancelMock).toHaveBeenCalledOnce());
    expect(recordPartialMock).toHaveBeenCalledTimes(2);
    expect(order).not.toContain("ui:text");
    expect(order.indexOf("audit:partial:2")).toBeLessThan(
      order.indexOf("audit:cancel"),
    );
    expect(cancelMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          transportAbortRequested: true,
          abortCommandAcknowledged: true,
          transportTerminationObserved: true,
          providerAbortReceiptObserved: false,
        }),
      }),
    );
    expect(cancelMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          providerAbortRequested: expect.anything(),
        }),
      }),
    );
    expect(cancelMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          providerAbortConfirmed: expect.anything(),
        }),
      }),
    );
  });

  it("starts the provider abort immediately even when an earlier partial audit is pending", async () => {
    let releasePartial!: () => void;
    recordPartialMock.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          releasePartial = resolve;
        }),
    );
    const cleanup = await sendInlineAiStream(
      [{ role: "user", content: "prompt" }],
      { projectId: "project-1", pathId: "ab_inline" },
      { onTextDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    );
    emitInline("inline-ai:stream-chunk", {
      delta: "pending",
      block_type: "text",
    });
    await vi.waitFor(() => expect(recordPartialMock).toHaveBeenCalledOnce());

    cleanup();

    // This call must happen synchronously from cleanup, before the ordered
    // terminal is allowed to wait for the pending partial persistence.
    expect(invokeMock).toHaveBeenCalledWith("abort_inline_ai_stream", {
      streamId: "execution",
    });
    expect(cancelMock).not.toHaveBeenCalled();
    releasePartial();
    emitInline("inline-ai:stream-done", {
      stop_reason: "stopped",
      input_tokens: null,
      output_tokens: null,
    });
    await vi.waitFor(() => expect(cancelMock).toHaveBeenCalledOnce());
    expect(order.indexOf("invoke:abort_inline_ai_stream")).toBeLessThan(
      order.indexOf("audit:cancel"),
    );
  });

  it("records a rejected local abort command without claiming a provider receipt", async () => {
    const cleanup = await sendInlineAiStream(
      [{ role: "user", content: "prompt" }],
      { projectId: "project-1", pathId: "inline_ai_stream" },
      { onTextDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    );
    invokeMock.mockRejectedValueOnce(new Error("abort command unavailable"));

    cleanup();
    emitInline("inline-ai:stream-done", {
      stop_reason: "stopped",
      input_tokens: null,
      output_tokens: null,
    });

    await vi.waitFor(() => expect(cancelMock).toHaveBeenCalledOnce());
    expect(cancelMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          transportAbortRequested: true,
          abortCommandAcknowledged: false,
          transportTerminationObserved: true,
          providerAbortReceiptObserved: false,
        }),
      }),
    );
  });

  it("fails closed before exposing an inline delta when partial persistence fails", async () => {
    recordPartialMock.mockRejectedValueOnce(new Error("ledger unavailable"));
    const onTextDelta = vi.fn();
    const onError = vi.fn();
    await sendInlineAiStream(
      [{ role: "user", content: "prompt" }],
      { projectId: "project-1", pathId: "inline_ai_stream" },
      { onTextDelta, onDone: vi.fn(), onError },
    );
    emitInline("inline-ai:stream-chunk", {
      delta: "must stay hidden",
      block_type: "text",
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("abort_inline_ai_stream", {
      streamId: "execution",
    });
  });
});
