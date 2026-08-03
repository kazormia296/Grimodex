import { beforeEach, describe, expect, it, vi } from "vitest";

type ListenHandler = (payload: unknown) => void;

const listeners = new Map<string, ListenHandler>();
const callOrder: string[] = [];
const invokeMock = vi.fn(
  async (
    ...args: [command: string, invokeArgs?: unknown]
  ): Promise<unknown> => {
    callOrder.push(`invoke:${args[0]}`);
    if (args[0] === "abort_cli_chat_stream") {
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved: true,
      };
    }
    return undefined;
  },
);
const listenMock = vi.fn(async (event: string, handler: ListenHandler) => {
  callOrder.push(`listen:${event}`);
  listeners.set(event, handler);
  return () => {
    if (listeners.get(event) === handler) listeners.delete(event);
  };
});

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: [command: string, invokeArgs?: unknown]) =>
    invokeMock(...args),
  listen: (...args: unknown[]) =>
    listenMock(...(args as [string, ListenHandler])),
}));

vi.mock("@/features/ai-audit/api", () => {
  const recordAiAuditPartial = vi.fn(
    async (_handle: unknown, _response: unknown) => undefined,
  );
  return {
    beginAiAuditExecution: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      expectedWorkspacePath: "/workspace",
      operationId: input.operationId ?? "operation-test",
      executionId: "execution-test",
      parentExecutionId: null,
      startedAt: 1,
    })),
    markAiAuditDispatched: vi.fn(async () => undefined),
    completeAiAuditExecution: vi.fn(async () => undefined),
    failAiAuditExecution: vi.fn(async () => undefined),
    cancelAiAuditExecution: vi.fn(async () => undefined),
    attemptAiAuditPersistenceFailureTerminal: vi.fn(async () => undefined),
    recordAiAuditPartial,
    recordAiAuditPartials: vi.fn(
      async (handle: unknown, partials: Array<{ response: unknown }>) => {
        for (const partial of partials) {
          await recordAiAuditPartial(handle, partial.response);
        }
      },
    ),
  };
});

const auditContext = { projectId: "project-1", pathId: "cli_chat_stream" };

import * as auditApi from "@/features/ai-audit/api";
import {
  abortCliChatStream,
  detectCliBinary,
  listCliModels,
  sendCliChatStream,
  testCliConnection,
} from "./cliApi";

function emit(event: string, payload: unknown): void {
  listeners.get(event)?.({
    streamId: "execution-test",
    ...(payload as Record<string, unknown>),
  });
}

describe("chat/cliApi", () => {
  beforeEach(() => {
    listeners.clear();
    callOrder.length = 0;
    invokeMock.mockClear();
    listenMock.mockClear();
    vi.mocked(auditApi.recordAiAuditPartial).mockReset();
    vi.mocked(auditApi.recordAiAuditPartial).mockResolvedValue(undefined);
    vi.mocked(auditApi.completeAiAuditExecution).mockClear();
    vi.mocked(auditApi.failAiAuditExecution).mockClear();
    vi.mocked(auditApi.cancelAiAuditExecution).mockClear();
  });

  it("3 listenerを先に登録し、camelCase payloadでCLI streamを開始する", async () => {
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const payload = {
      cli: "codex" as const,
      binaryPath: "/opt/codex",
      model: "gpt-5",
      prompt: "hello",
    };

    const cleanup = await sendCliChatStream(payload, auditContext, callbacks);

    expect(callOrder).toEqual([
      "listen:cli:stream-chunk",
      "listen:cli:stream-done",
      "listen:cli:stream-error",
      "invoke:send_cli_chat_stream",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("send_cli_chat_stream", {
      payload,
      streamId: "execution-test",
    });

    emit("cli:stream-chunk", { delta: "text", block_type: "text" });
    emit("cli:stream-chunk", { delta: "think", block_type: "thinking" });
    emit("cli:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 12,
      output_tokens: 4,
    });
    emit("cli:stream-error", { message: "boom" });
    await vi.waitFor(() => expect(callbacks.onDone).toHaveBeenCalledOnce());

    expect(callbacks.onTextDelta).toHaveBeenCalledWith("text");
    expect(callbacks.onThinkingDelta).toHaveBeenCalledWith("think");
    expect(callbacks.onDone).toHaveBeenCalledWith({
      stopReason: "end_turn",
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(vi.mocked(auditApi.recordAiAuditPartial).mock.calls).toEqual([
      [
        expect.anything(),
        { streamSequence: 1, blockType: "text", delta: "text" },
      ],
      [
        expect.anything(),
        { streamSequence: 2, blockType: "thinking", delta: "think" },
      ],
    ]);
    expect(
      vi.mocked(auditApi.recordAiAuditPartial).mock.invocationCallOrder[1],
    ).toBeLessThan(callbacks.onThinkingDelta.mock.invocationCallOrder[0]);
    expect(callbacks.onThinkingDelta.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(auditApi.completeAiAuditExecution).mock.invocationCallOrder[0],
    );

    cleanup();
    expect(listeners.size).toBe(0);
  });

  it("invoke rejectもonErrorへ渡す", async () => {
    invokeMock.mockRejectedValueOnce(new Error("spawn failed"));
    const onError = vi.fn();
    await sendCliChatStream({ cli: "claude", prompt: "hello" }, auditContext, {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError,
    });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith("spawn failed"),
    );
  });

  it("deltaを永続化してからerror/cleanup terminalを記録する", async () => {
    const onTextDelta = vi.fn();
    const onError = vi.fn();
    await sendCliChatStream({ cli: "codex", prompt: "hello" }, auditContext, {
      onTextDelta,
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError,
    });
    emit("cli:stream-chunk", { delta: "before error", block_type: "text" });
    emit("cli:stream-error", { message: "boom" });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(
      vi.mocked(auditApi.recordAiAuditPartial).mock.invocationCallOrder[0],
    ).toBeLessThan(onTextDelta.mock.invocationCallOrder[0]);
    expect(onTextDelta.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(auditApi.failAiAuditExecution).mock.invocationCallOrder[0],
    );

    listeners.clear();
    vi.mocked(auditApi.recordAiAuditPartial).mockClear();
    vi.mocked(auditApi.cancelAiAuditExecution).mockClear();
    const cleanup = await sendCliChatStream(
      { cli: "codex", prompt: "hello" },
      auditContext,
      {
        onTextDelta,
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    );
    emit("cli:stream-chunk", {
      delta: "before cleanup",
      block_type: "text",
    });
    cleanup();
    emit("cli:stream-chunk", {
      delta: "in flight after cleanup",
      block_type: "text",
    });
    expect(auditApi.cancelAiAuditExecution).not.toHaveBeenCalled();
    emit("cli:stream-done", {
      stop_reason: "stopped",
      input_tokens: null,
      output_tokens: null,
    });
    await vi.waitFor(() =>
      expect(auditApi.cancelAiAuditExecution).toHaveBeenCalledOnce(),
    );
    expect(auditApi.recordAiAuditPartial).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(auditApi.recordAiAuditPartial).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(auditApi.cancelAiAuditExecution).mock.invocationCallOrder[0],
    );
    expect(auditApi.cancelAiAuditExecution).toHaveBeenCalledWith(
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
    expect(auditApi.cancelAiAuditExecution).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          providerAbortRequested: expect.anything(),
        }),
      }),
    );
    expect(auditApi.cancelAiAuditExecution).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          providerAbortConfirmed: expect.anything(),
        }),
      }),
    );
  });

  it("partial persistence failure hides the CLI delta and aborts fail-closed", async () => {
    vi.mocked(auditApi.recordAiAuditPartial).mockRejectedValueOnce(
      new Error("ledger unavailable"),
    );
    const onTextDelta = vi.fn();
    const onError = vi.fn();
    await sendCliChatStream({ cli: "codex", prompt: "hello" }, auditContext, {
      onTextDelta,
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError,
    });
    emit("cli:stream-chunk", { delta: "hidden", block_type: "text" });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("abort_cli_chat_stream", {
      streamId: "execution-test",
    });
  });

  it("error eventとinvoke rejectが同じ失敗を運んでもonErrorは一度だけ呼ぶ", async () => {
    let rejectInvoke!: (cause: Error) => void;
    invokeMock.mockImplementationOnce(
      async () =>
        new Promise<never>((_resolve, reject) => {
          rejectInvoke = reject;
        }),
    );
    const onError = vi.fn();
    const cleanup = await sendCliChatStream(
      { cli: "claude", prompt: "hello" },
      auditContext,
      {
        onTextDelta: vi.fn(),
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    );

    emit("cli:stream-error", { message: "spawn failed" });
    rejectInvoke(new Error("spawn failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("spawn failed");
    cleanup();
  });

  it("abort/detect/testは正確なcommand shapeを使う", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("/usr/local/bin/claude")
      .mockResolvedValueOnce("claude 1.2.3");

    await abortCliChatStream("execution-test");
    await expect(detectCliBinary("claude")).resolves.toBe(
      "/usr/local/bin/claude",
    );
    await expect(testCliConnection("/usr/local/bin/claude")).resolves.toBe(
      "claude 1.2.3",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "abort_cli_chat_stream", {
      streamId: "execution-test",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "detect_cli_binary", {
      cli: "claude",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "test_cli_connection", {
      binaryPath: "/usr/local/bin/claude",
    });
  });

  it("model一覧は空pathをnullへ正規化する", async () => {
    const models = [{ id: "opus", name: "Opus" }];
    invokeMock.mockResolvedValueOnce(models);

    await expect(listCliModels("claude", "")).resolves.toEqual(models);
    expect(invokeMock).toHaveBeenCalledWith("list_cli_models", {
      cli: "claude",
      binaryPath: null,
    });
  });
});
