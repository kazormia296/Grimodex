import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAuditExecutionHandle } from "@/features/ai-audit/types";

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
const beginInWorkspaceMock = vi.hoisted(() =>
  vi.fn(
    async (input: Record<string, unknown>, expectedWorkspacePath: string) => ({
      ...input,
      expectedWorkspacePath,
      operationId: input.operationId ?? "operation-test",
      executionId: "execution-app",
      parentExecutionId: null,
      startedAt: 1,
    }),
  ),
);
const recordPartialMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
);
const persistenceFailureTerminalMock = vi.hoisted(() =>
  vi.fn(async () => true),
);
const sanitizeDiagnosticMock = vi.hoisted(() =>
  vi.fn(async (value: string) => ({
    value: value.includes("secret") ? "[REDACTED:credential]" : value,
    redactions: value.includes("secret")
      ? [{ path: "diagnostic", category: "credential" }]
      : [],
  })),
);

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: (event: string, listener: Listener) => listenMock(event, listener),
}));

vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecutionInWorkspace: beginInWorkspaceMock,
  markAiAuditDispatched: vi.fn(async () => undefined),
  completeAiAuditExecution: vi.fn(async () => undefined),
  failAiAuditExecution: vi.fn(async () => undefined),
  cancelAiAuditExecution: vi.fn(async () => undefined),
  recordAiAuditPartial: recordPartialMock,
  recordAiAuditPartials: vi.fn(
    async (
      handle: unknown,
      partials: Array<{
        response: unknown;
        receivedAt: number;
        captureState?: string;
        redactions?: unknown[];
      }>,
    ) => {
      for (const partial of partials) {
        if (
          partial.captureState === undefined &&
          partial.redactions === undefined
        ) {
          await recordPartialMock(handle, partial.response);
        } else {
          await recordPartialMock(handle, partial.response, {
            receivedAt: partial.receivedAt,
            captureState: partial.captureState,
            redactions: partial.redactions,
          });
        }
      }
    },
  ),
  attemptAiAuditPersistenceFailureTerminal: persistenceFailureTerminalMock,
  sanitizeAiAuditDiagnostic: sanitizeDiagnosticMock,
  fallbackAiAuditExecution: vi.fn(async (parent: Record<string, unknown>) => ({
    ...parent,
    pathId: "codex_app_cli_fallback",
    executionId: "execution-cli",
    parentExecutionId: parent.executionId,
  })),
}));

vi.mock("./cliApi", () => ({
  sendCliChatStream: vi.fn(async () => () => {}),
  cliAuditRequest: vi.fn((payload: { prompt: string }) => ({
    messages: [{ role: "user", content: payload.prompt }],
  })),
}));

import * as cliApi from "./cliApi";
import * as auditApi from "@/features/ai-audit/api";
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

const expectedAuditContext = {
  expectedWorkspacePath: "/workspace/one",
  projectId: "p1",
  operationId: "g1",
  executionId: "execution-app",
  parentExecutionId: null,
  pathId: "codex_app_server",
};

function expectedStartPayload(
  payload: typeof basePayload = basePayload,
): Record<string, unknown> {
  return { ...payload, auditContext: expectedAuditContext };
}

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
    beginInWorkspaceMock.mockClear();
    recordPartialMock.mockClear();
    persistenceFailureTerminalMock.mockClear();
    sanitizeDiagnosticMock.mockClear();
    vi.mocked(auditApi.completeAiAuditExecution).mockClear();
    vi.mocked(auditApi.failAiAuditExecution).mockClear();
    vi.mocked(auditApi.cancelAiAuditExecution).mockClear();
    vi.mocked(auditApi.fallbackAiAuditExecution).mockClear();
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

  it("fails closed before Codex start when the audit workspace authority changed", async () => {
    beginInWorkspaceMock.mockRejectedValueOnce(
      new Error("AI_AUDIT_WORKSPACE_CHANGED"),
    );
    await expect(
      sendCodexAppTurn(
        { ...basePayload, expectedWorkspacePath: "/workspace/old" },
        {
          onTextDelta: vi.fn(),
          onThinkingDelta: vi.fn(),
          onDone: vi.fn(),
          onError: vi.fn(),
        },
      ),
    ).rejects.toThrow("AI_AUDIT_WORKSPACE_CHANGED");
    expect(beginInWorkspaceMock).toHaveBeenCalledWith(
      expect.anything(),
      "/workspace/old",
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
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
    await vi.waitFor(() =>
      expect(callbacks.onDone).toHaveBeenCalledWith({
        stopReason: "completed",
        inputTokens: 10,
        outputTokens: 4,
      }),
    );
    expect(callbacks.onThinkingDelta).toHaveBeenCalledWith("考え");
    expect(invokeMock).toHaveBeenCalledWith(
      "codex_app_start_turn",
      expectedStartPayload(),
    );
    cleanup();
  });

  it("sanitizes runtime diagnostics in audit partials without altering model deltas", async () => {
    const onWarning = vi.fn();
    const onTextDelta = vi.fn();
    const cleanup = await sendCodexAppTurn(basePayload, {
      onTextDelta,
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onWarning,
    });
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "text-delta", delta: "model says api_key secret" },
    });
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: {
        type: "warning",
        message: '{"api_key":"secret"}',
      },
    });

    await vi.waitFor(() => expect(onWarning).toHaveBeenCalledOnce());
    expect(onTextDelta).toHaveBeenCalledWith("model says api_key secret");
    expect(recordPartialMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        blockType: "text",
        delta: "model says api_key secret",
      }),
    );
    expect(recordPartialMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeDiagnostic: expect.objectContaining({
          message: "[REDACTED:credential]",
        }),
      }),
      expect.objectContaining({
        captureState: "redacted",
        redactions: [expect.objectContaining({ category: "credential" })],
      }),
    );
    expect(onWarning).toHaveBeenCalledWith('{"api_key":"secret"}');
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

  it("delivers a turn-started callback only after its audit append ACK", async () => {
    invokeMock.mockImplementationOnce(() => new Promise(() => {}));
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    recordPartialMock.mockImplementationOnce(async () => appendGate);
    const onTurnStarted = vi.fn();
    await sendCodexAppTurn(basePayload, {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onTurnStarted,
    });

    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      codexTurnId: "turn-authoritative",
      event: { type: "turn-started", turnId: "turn-event" },
    });
    await vi.waitFor(() => expect(recordPartialMock).toHaveBeenCalledOnce());
    expect(onTurnStarted).not.toHaveBeenCalled();

    releaseAppend();
    await vi.waitFor(() =>
      expect(onTurnStarted).toHaveBeenCalledWith({
        turnId: "turn-authoritative",
      }),
    );
    expect(recordPartialMock.mock.invocationCallOrder[0]).toBeLessThan(
      onTurnStarted.mock.invocationCallOrder[0],
    );
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
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "Codex App Server returned an invalid start result",
      ),
    );
    expect(auditApi.failAiAuditExecution).toHaveBeenCalledOnce();
    expect(auditApi.failAiAuditExecution).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "execution-app" }),
      expect.objectContaining({
        error: expect.objectContaining({
          name: "CodexAppStartOutcomeUnknown",
          code: "CODEX_APP_SERVER_INVALID_START_RESULT",
        }),
        metadata: expect.objectContaining({
          providerOutcomeUnknown: true,
          modelDispatched: null,
        }),
      }),
    );
    expect(auditApi.completeAiAuditExecution).not.toHaveBeenCalled();
    expect(auditApi.cancelAiAuditExecution).not.toHaveBeenCalled();
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
      expect.objectContaining({
        projectId: "p1",
        pathId: "codex_app_cli_fallback",
        operationId: "g1",
      }),
      callbacks,
      expect.objectContaining({
        executionId: "execution-cli",
        parentExecutionId: "execution-app",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "codex_app_start_turn",
      expectedStartPayload(),
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
    expect(auditApi.failAiAuditExecution).toHaveBeenCalledOnce();
    expect(auditApi.failAiAuditExecution).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "execution-app" }),
      expect.objectContaining({
        error: expect.objectContaining({
          name: "CodexAppStartOutcomeUnknown",
          code: "CODEX_APP_SERVER_START_REJECTED",
        }),
        metadata: expect.objectContaining({
          providerOutcomeUnknown: true,
        }),
      }),
    );
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
      expect.objectContaining({
        projectId: "p1",
        pathId: "codex_app_cli_fallback",
        operationId: "g1",
      }),
      callbacks,
      expect.objectContaining({
        executionId: "execution-cli",
        parentExecutionId: "execution-app",
      }),
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
    await vi.waitFor(() =>
      expect(recordPartialMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          runtimeEvent: expect.objectContaining({
            phase: "approval-requested",
          }),
        }),
      ),
    );
    expect(recordPartialMock.mock.invocationCallOrder[0]).toBeLessThan(
      callbacks.onApprovalRequested.mock.invocationCallOrder[0],
    );
    expect(
      callbacks.onApprovalRequested.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(auditApi.failAiAuditExecution).mock.invocationCallOrder[0],
    );
    expect(auditApi.failAiAuditExecution).toHaveBeenCalledOnce();
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

    await vi.waitFor(() =>
      expect(callbacks.onDone).toHaveBeenCalledWith({
        stopReason: "completed",
        inputTokens: undefined,
        outputTokens: undefined,
        cacheReadTokens: undefined,
      }),
    );
    expect(callbacks.onWarning).toHaveBeenCalledWith("temporary overload");
    expect(callbacks.onError).not.toHaveBeenCalled();
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

  it("terminalizes a fallback audit when cleanup wins during fallback creation", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_PRE_TURN",
      message: "app server unavailable",
    });
    let resolveFallbackAudit!: (handle: AiAuditExecutionHandle) => void;
    vi.mocked(auditApi.fallbackAiAuditExecution).mockImplementationOnce(
      (_parent) =>
        new Promise((resolve) => {
          resolveFallbackAudit = resolve;
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
      expect(auditApi.fallbackAiAuditExecution).toHaveBeenCalledOnce(),
    );

    cleanup();
    resolveFallbackAudit({
      projectId: "p1",
      pathId: "codex_app_cli_fallback",
      operationId: "g1",
      executionId: "execution-cli",
      parentExecutionId: "execution-app",
      startedAt: 2,
      expectedWorkspacePath: "/workspace/one",
    });

    await vi.waitFor(() =>
      expect(auditApi.cancelAiAuditExecution).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: "execution-cli" }),
        expect.objectContaining({
          reason: "fallback-cancelled-before-dispatch",
          metadata: expect.objectContaining({
            modelDispatched: false,
            uiDeliveryEnded: true,
          }),
        }),
      ),
    );
    expect(cliApi.sendCliChatStream).not.toHaveBeenCalled();
    expect(callbacks.onFallback).not.toHaveBeenCalled();
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
      expect(
        invokeMock.mock.calls.filter(
          ([command]) => command === "codex_app_interrupt_turn",
        ),
      ).toHaveLength(2),
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("keeps cleanup audit-only until an interrupted turn terminal", async () => {
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(basePayload, callbacks);
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "text-delta", delta: "before cleanup" },
    });
    cleanup();
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "text-delta", delta: "late audit-only" },
    });
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "turn-completed", stopReason: "interrupted" },
    });

    await vi.waitFor(() =>
      expect(auditApi.cancelAiAuditExecution).toHaveBeenCalledOnce(),
    );
    expect(callbacks.onTextDelta).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(recordPartialMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delta: "before cleanup" }),
    );
    expect(recordPartialMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delta: "late audit-only" }),
    );
    expect(auditApi.cancelAiAuditExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          uiDeliveryEnded: true,
          auditObservationContinuedUntilTransportTerminal: true,
          transportTerminationObserved: true,
          providerAbortReceiptObserved: false,
        }),
      }),
    );
  });

  it("records provider completion after cleanup as succeeded abort race", async () => {
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const cleanup = await sendCodexAppTurn(basePayload, callbacks);
    cleanup();
    emit({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "g1",
      event: { type: "turn-completed", stopReason: "completed" },
    });

    await vi.waitFor(() =>
      expect(auditApi.completeAiAuditExecution).toHaveBeenCalledOnce(),
    );
    expect(auditApi.cancelAiAuditExecution).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(auditApi.completeAiAuditExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          abortRacedWithProviderCompletion: true,
          providerAbortReceiptObserved: false,
        }),
      }),
    );
  });
});
