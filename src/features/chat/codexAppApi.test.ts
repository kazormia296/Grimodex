import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();
const invokeMock = vi.fn<(..._args: unknown[]) => Promise<unknown>>(
  async (..._args: unknown[]) => undefined,
);
const listenMock = vi.fn(async (event: string, listener: Listener) => {
  listeners.set(event, listener);
  return () => {
    if (listeners.get(event) === listener) listeners.delete(event);
  };
});

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: (event: string, listener: Listener) => listenMock(event, listener),
}));

vi.mock("./cliApi", () => ({
  sendCliChatStream: vi.fn(async () => () => {}),
}));

import * as cliApi from "./cliApi";
import {
  advanceCodexHistoryRevision,
  archiveCodexSessionThread,
  sendCodexAppTurn,
  setCodexSessionThreadName,
} from "./codexAppApi";

const basePayload = {
  projectId: "p1",
  sessionId: "s1",
  expectedWorkspacePath: "/workspace/one",
  grimodexTurnId: "g1",
  clientUserMessageId: "u1",
  contextPacket: "context",
  historyRevision: "rev-1",
  userMessage: "質問",
};

function emit(event: unknown): void {
  listeners.get("codex-app:event")?.(event);
}

describe("codexAppApi", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      status: "started",
      codexThreadId: "thread-default",
      codexTurnId: "turn-default",
      reusedThread: false,
    });
    listenMock.mockClear();
    vi.mocked(cliApi.sendCliChatStream).mockReset();
    vi.mocked(cliApi.sendCliChatStream).mockResolvedValue(() => {});
  });

  it("advances history through the high-level CAS command", async () => {
    invokeMock.mockResolvedValueOnce({ status: "advanced" });
    await advanceCodexHistoryRevision({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      expectedHistoryRevision: "revision-before",
      nextHistoryRevision: "revision-after",
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "codex_app_update_history_revision",
      {
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "g1",
        codexThreadId: "thread-1",
        codexTurnId: "turn-1",
        expectedHistoryRevision: "revision-before",
        nextHistoryRevision: "revision-after",
      },
    );
  });

  it("forwards workspace preconditions for binding mutations", async () => {
    await archiveCodexSessionThread({
      projectId: "p1",
      sessionId: "s1",
      expectedWorkspacePath: "/workspace/one",
    });
    await setCodexSessionThreadName({
      projectId: "p1",
      sessionId: "s1",
      expectedWorkspacePath: "/workspace/one",
      name: "Renamed",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "codex_app_archive_session_thread",
      {
        projectId: "p1",
        sessionId: "s1",
        expectedWorkspacePath: "/workspace/one",
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "codex_app_set_thread_name", {
      projectId: "p1",
      sessionId: "s1",
      expectedWorkspacePath: "/workspace/one",
      name: "Renamed",
    });
  });

  it("filters correlation, adapts usage/done, and removes renderer-only fields from IPC", async () => {
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onWarning: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(
      { ...basePayload, transport: "app-server" },
      callbacks,
    );
    await Promise.resolve();

    emit({
      projectId: "other",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "text-delta", delta: "leak" },
    });
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "thinking-delta", delta: "考え" },
    });
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "usage", inputTokens: 10, outputTokens: 4 },
    });
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "turn-completed", stopReason: "completed" },
    });

    expect(callbacks.onTextDelta).not.toHaveBeenCalled();
    expect(callbacks.onThinkingDelta).toHaveBeenCalledWith("考え");
    expect(callbacks.onDone).toHaveBeenCalledWith({
      stopReason: "completed",
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "codex_app_start_turn",
      basePayload,
    );
    cleanup();
  });

  it("adapts the authoritative thread and turn ids returned by main", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "started",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      reusedThread: false,
    });
    const onTurnStarted = vi.fn();
    const cleanup = await sendCodexAppTurn(
      { ...basePayload, transport: "app-server" },
      {
        onTextDelta: vi.fn(),
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        onTurnStarted,
      },
    );
    await vi.waitFor(() =>
      expect(onTurnStarted).toHaveBeenCalledWith({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );
    cleanup();
  });

  it("aborts fail-closed when main returns a malformed start result", async () => {
    invokeMock.mockResolvedValueOnce({ status: "started", codexTurnId: 7 });
    const onError = vi.fn();

    await sendCodexAppTurn(
      { ...basePayload, transport: "app-server" },
      {
        onTextDelta: vi.fn(),
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    );

    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("codex_app_interrupt_turn", {
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "g1",
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      "Codex App Server returned an invalid start result",
    );
  });

  it("falls back only when main proves rejection happened before turn acceptance", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_PRE_TURN",
      message: "app server unavailable",
    });
    const onFallback = vi.fn();
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onFallback,
    };
    await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );
    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledOnce());
    expect(cliApi.sendCliChatStream).toHaveBeenCalledWith(
      { cli: "codex", prompt: "fallback" },
      callbacks,
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "codex_app_start_turn",
      basePayload,
    );
  });

  it("does not fallback when the renderer workspace became stale", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_WORKSPACE_STALE",
      message: "workspace changed",
    });
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onFallback: vi.fn(),
    };

    await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );

    await vi.waitFor(() =>
      expect(callbacks.onError).toHaveBeenCalledWith("workspace changed"),
    );
    expect(callbacks.onFallback).not.toHaveBeenCalled();
    expect(cliApi.sendCliChatStream).not.toHaveBeenCalled();
  });

  it("does not fallback on an unclassified invoke rejection before events", async () => {
    invokeMock.mockRejectedValueOnce(new Error("turn start response lost"));
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onFallback: vi.fn(),
    };

    await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );

    await vi.waitFor(() =>
      expect(callbacks.onError).toHaveBeenCalledWith(
        "turn start response lost",
      ),
    );
    expect(callbacks.onFallback).not.toHaveBeenCalled();
    expect(cliApi.sendCliChatStream).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("codex_app_interrupt_turn", {
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
    });
  });

  it("still falls back when only thread creation completed before turn acceptance failed", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_PRE_TURN",
      message: "turn start rejected",
    });
    const onFallback = vi.fn();
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onFallback,
    };
    await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "thread-started", threadId: "thread-1" },
    });
    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledOnce());
    expect(cliApi.sendCliChatStream).toHaveBeenCalledWith(
      { cli: "codex", prompt: "fallback" },
      callbacks,
    );
  });

  it("does not fallback after a correlated output event", async () => {
    let rejectInvoke!: (cause: Error) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectInvoke = reject;
        }),
    );
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "text-delta", delta: "partial" },
    });
    rejectInvoke(new Error("connection closed"));
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalled());
    expect(cliApi.sendCliChatStream).not.toHaveBeenCalled();
  });

  it("does not fallback after a correlated approval request", async () => {
    let rejectInvoke!: (cause: Error) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectInvoke = reject;
        }),
    );
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onApprovalRequested: vi.fn(),
      onFallback: vi.fn(),
    };
    await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: {
        type: "approval-requested",
        requestId: "approval-1",
        kind: "command",
        title: "Run command",
        summary: "Run a command",
      },
    });
    rejectInvoke(new Error("turn start response lost"));

    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
    expect(callbacks.onApprovalRequested).toHaveBeenCalledOnce();
    expect(callbacks.onFallback).not.toHaveBeenCalled();
    expect(cliApi.sendCliChatStream).not.toHaveBeenCalled();
  });

  it("keeps listening after a retryable turn error", async () => {
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onWarning: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(
      { ...basePayload, transport: "app-server" },
      callbacks,
    );
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: {
        type: "turn-error",
        message: "temporary overload",
        retryable: true,
      },
    });
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "turn-completed", stopReason: "completed" },
    });

    expect(callbacks.onWarning).toHaveBeenCalledWith("temporary overload");
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith({
      stopReason: "completed",
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
    });
    cleanup();
  });

  it("interrupts an ambiguous rejection without fallback after cleanup", async () => {
    let rejectInvoke!: (cause: Error) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectInvoke = reject;
        }),
    );
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onFallback: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );
    cleanup();
    rejectInvoke(new Error("stopped"));
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("codex_app_interrupt_turn", {
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "g1",
      }),
    );
    expect(callbacks.onFallback).not.toHaveBeenCalled();
    expect(cliApi.sendCliChatStream).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("cleans up a fallback that finishes starting after cancellation", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_PRE_TURN",
      message: "app server unavailable",
    });
    let resolveFallback!: (cleanup: () => void) => void;
    const fallbackCleanup = vi.fn();
    vi.mocked(cliApi.sendCliChatStream).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFallback = resolve;
        }),
    );
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onFallback: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );
    await vi.waitFor(() =>
      expect(cliApi.sendCliChatStream).toHaveBeenCalledOnce(),
    );

    cleanup();
    resolveFallback(fallbackCleanup);

    await vi.waitFor(() => expect(fallbackCleanup).toHaveBeenCalledOnce());
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("does not report a fallback startup rejection after cancellation", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_PRE_TURN",
      message: "app server unavailable",
    });
    let rejectFallback!: (cause: Error) => void;
    const fallbackStartup = new Promise<() => void>((_resolve, reject) => {
      rejectFallback = reject;
    });
    vi.mocked(cliApi.sendCliChatStream).mockReturnValueOnce(fallbackStartup);
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onFallback: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(
      {
        ...basePayload,
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback" },
      },
      callbacks,
    );
    await vi.waitFor(() =>
      expect(cliApi.sendCliChatStream).toHaveBeenCalledOnce(),
    );

    cleanup();
    rejectFallback(new Error("fallback startup failed"));
    await expect(fallbackStartup).rejects.toThrow("fallback startup failed");
    await Promise.resolve();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("interrupts a turn that finishes starting after cleanup", async () => {
    let resolveStart!: (result: {
      status: "started";
      codexThreadId: string;
      codexTurnId: string;
      reusedThread: boolean;
    }) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(
      { ...basePayload, transport: "app-server" },
      callbacks,
    );

    cleanup();
    resolveStart({
      status: "started",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      reusedThread: false,
    });

    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("codex_app_interrupt_turn", {
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "g1",
      }),
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});
