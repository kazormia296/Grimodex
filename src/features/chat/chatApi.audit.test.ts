import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();
const order: string[] = [];
const invokeMock = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    order.push(`invoke:${command}`);
    if (command === "abort_chat_stream") {
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved: true,
      };
    }
    if (command === "send_agent_message") {
      return {
        blocks: [
          { type: "tool_use", id: "tool-1", name: "search", input: {} },
          { type: "thinking", content: "visible" },
          { type: "text", content: "answer" },
        ],
        stopReason: "tool_use",
        inputTokens: 20,
        outputTokens: 8,
      };
    }
    return undefined;
  }),
);
const listenMock = vi.hoisted(() =>
  vi.fn(async (event: string, listener: Listener) => {
    listeners.set(event, listener);
    return () => listeners.delete(event);
  }),
);
const beginMock = vi.hoisted(() =>
  vi.fn(async (input: Record<string, unknown>) => {
    order.push("audit:begin");
    return {
      ...input,
      expectedWorkspacePath: "/workspace",
      operationId: input.operationId ?? "operation",
      executionId: input.executionId ?? "execution",
      parentExecutionId: input.parentExecutionId ?? null,
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

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock, listen: listenMock }));
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

import { sendAgentMessage, sendChatMessageStream } from "./chatApi";
import { DEFAULT_AI_SETTINGS } from "./types";
import { useAiSettingsStore } from "./store";

const AGENT_PATHS = [
  "AI audit path: chat_agent_main",
  "AI audit path: agent_research_subagent",
  "AI audit path: context_creator",
] as const;

function emitChat(
  channel: "chat:stream-chunk" | "chat:stream-done" | "chat:stream-error",
  payload: Record<string, unknown>,
  streamId = "execution",
): void {
  listeners.get(channel)?.({ streamId, ...payload });
}

describe("chat and Agent audit contracts", () => {
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

  it.each(AGENT_PATHS)("%s", async (label) => {
    const pathId = label.slice("AI audit path: ".length);
    await sendAgentMessage(
      [{ role: "user", content: "review everything" }],
      [
        {
          name: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
      {
        projectId: "project-1",
        pathId,
        operationId: "turn-1",
        executionId: `execution-${pathId}`,
        parentExecutionId: "parent-1",
      },
      undefined,
    );

    expect(order).toEqual([
      "audit:begin",
      "audit:dispatch",
      "invoke:send_agent_message",
      "audit:complete",
    ]);
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathId,
        operationId: "turn-1",
        parentExecutionId: "parent-1",
        request: expect.objectContaining({
          messages: [{ role: "user", content: "review everything" }],
          tools: [
            {
              name: "search",
              description: "Search",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        }),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "send_agent_message",
      expect.objectContaining({
        auditContext: expect.objectContaining({
          expectedWorkspacePath: "/workspace",
          projectId: "project-1",
          operationId: "turn-1",
          executionId: `execution-${pathId}`,
          parentExecutionId: "parent-1",
          pathId,
        }),
      }),
    );
  });

  it("AI audit path: chat_stream_non_agent", async () => {
    let releaseComplete: (() => void) | undefined;
    completeMock.mockImplementationOnce(() => {
      order.push("audit:complete");
      return new Promise<void>((resolve) => {
        releaseComplete = resolve;
      });
    });
    const onDone = vi.fn();
    const onTextDelta = vi.fn(() => order.push("ui:text"));
    const onThinkingDelta = vi.fn(() => order.push("ui:thinking"));
    await sendChatMessageStream(
      [{ role: "user", content: "stream" }],
      undefined,
      {
        onTextDelta,
        onThinkingDelta,
        onDone,
        onError: vi.fn(),
      },
      {
        projectId: "project-1",
        pathId: "chat_stream_non_agent",
        operationId: "turn-stream",
      },
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "send_chat_message_stream",
      expect.objectContaining({
        streamId: "execution",
        auditContext: expect.objectContaining({
          expectedWorkspacePath: "/workspace",
          projectId: "project-1",
          operationId: "turn-stream",
          pathId: "chat_stream_non_agent",
        }),
      }),
    );

    emitChat("chat:stream-chunk", {
      delta: "visible thinking",
      block_type: "thinking",
    });
    emitChat("chat:stream-chunk", {
      delta: "answer",
      block_type: "text",
    });
    emitChat("chat:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 4,
      output_tokens: 2,
    });
    emitChat("chat:stream-chunk", {
      delta: "must not escape after terminal snapshot",
      block_type: "text",
    });
    await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
    expect(onDone).not.toHaveBeenCalled();
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(onThinkingDelta).toHaveBeenCalledOnce();
    expect(completeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        response: {
          text: "answer",
          thinking: "visible thinking",
          stopReason: "end_turn",
        },
      }),
    );
    expect(
      recordPartialMock.mock.calls.map(([, response]) => response),
    ).toEqual([
      {
        streamSequence: 1,
        blockType: "thinking",
        delta: "visible thinking",
      },
      { streamSequence: 2, blockType: "text", delta: "answer" },
    ]);
    expect(order.indexOf("audit:partial:1")).toBeLessThan(
      order.indexOf("ui:thinking"),
    );
    expect(order.indexOf("audit:partial:2")).toBeLessThan(
      order.indexOf("ui:text"),
    );
    expect(order.indexOf("ui:text")).toBeLessThan(
      order.indexOf("audit:complete"),
    );

    releaseComplete?.();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it("flushes observed deltas before an error terminal and blocks late chunks", async () => {
    const onTextDelta = vi.fn(() => order.push("ui:text"));
    const onError = vi.fn(() => order.push("ui:error"));
    await sendChatMessageStream(
      [{ role: "user", content: "stream" }],
      undefined,
      {
        onTextDelta,
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
      { projectId: "project-1", pathId: "chat_stream_non_agent" },
    );

    emitChat("chat:stream-chunk", {
      delta: "before error",
      block_type: "text",
    });
    emitChat("chat:stream-error", { message: "provider failed" });
    emitChat("chat:stream-chunk", {
      delta: "late",
      block_type: "text",
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(recordPartialMock).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenCalledOnce();
    expect(order.indexOf("audit:partial:1")).toBeLessThan(
      order.indexOf("ui:text"),
    );
    expect(order.indexOf("ui:text")).toBeLessThan(order.indexOf("audit:fail"));
    expect(order.indexOf("audit:fail")).toBeLessThan(order.indexOf("ui:error"));
  });

  it("keeps correlated audit observation through abort quiescence while stopping UI immediately", async () => {
    const onTextDelta = vi.fn(() => order.push("ui:text"));
    const cleanup = await sendChatMessageStream(
      [{ role: "user", content: "stream" }],
      undefined,
      {
        onTextDelta,
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
      { projectId: "project-1", pathId: "chat_stream_non_agent" },
    );
    emitChat("chat:stream-chunk", {
      delta: "before cleanup",
      block_type: "text",
    });
    await vi.waitFor(() => expect(onTextDelta).toHaveBeenCalledOnce());
    cleanup();
    emitChat("chat:stream-chunk", {
      delta: "in flight after cleanup",
      block_type: "text",
    });
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(cancelMock).not.toHaveBeenCalled();
    emitChat("chat:stream-done", {
      stop_reason: "stopped",
      input_tokens: null,
      output_tokens: null,
    });

    await vi.waitFor(() => expect(cancelMock).toHaveBeenCalledOnce());
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(recordPartialMock).toHaveBeenCalledTimes(2);
    expect(order.indexOf("audit:partial:1")).toBeLessThan(
      order.indexOf("ui:text"),
    );
    expect(order.indexOf("ui:text")).toBeLessThan(
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
          cleanupReturnedBeforeTerminalAuditDurable: true,
          hardProcessKillMayLeaveDispatchedWithoutTerminal: true,
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

  it("ignores missing and mismatched stream events so an old A stream cannot enter B", async () => {
    const onTextDelta = vi.fn();
    const onDone = vi.fn();
    await sendChatMessageStream(
      [{ role: "user", content: "stream B" }],
      undefined,
      {
        onTextDelta,
        onThinkingDelta: vi.fn(),
        onDone,
        onError: vi.fn(),
      },
      { projectId: "project-1", pathId: "chat_stream_non_agent" },
    );

    listeners.get("chat:stream-chunk")?.({
      delta: "missing id",
      block_type: "text",
    });
    emitChat(
      "chat:stream-chunk",
      { delta: "old A", block_type: "text" },
      "execution-a",
    );
    emitChat("chat:stream-chunk", {
      delta: "B only",
      block_type: "text",
    });
    emitChat("chat:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 1,
      output_tokens: 1,
    });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith("B only");
    expect(recordPartialMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ delta: "B only" }),
    );
  });

  it("fails closed without exposing a delta when its durable partial append fails", async () => {
    recordPartialMock.mockRejectedValueOnce(new Error("ledger unavailable"));
    const onTextDelta = vi.fn();
    const onError = vi.fn();
    await sendChatMessageStream(
      [{ role: "user", content: "stream" }],
      undefined,
      {
        onTextDelta,
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
      { projectId: "project-1", pathId: "chat_stream_non_agent" },
    );
    emitChat("chat:stream-chunk", {
      delta: "must stay hidden",
      block_type: "text",
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("AI audit persistence failed"),
    );
    expect(invokeMock).toHaveBeenCalledWith("abort_chat_stream", {
      streamId: "execution",
    });
  });
});
