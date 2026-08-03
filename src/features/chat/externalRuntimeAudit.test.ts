import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();
let codexStartResult: unknown;
const invokeMock = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    if (command === "codex_app_start_turn") return codexStartResult;
    return undefined;
  }),
);
const beginMock = vi.hoisted(() =>
  vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    expectedWorkspacePath: "/workspace",
    operationId: input.operationId ?? "operation",
    executionId: "execution-app",
    parentExecutionId: null,
    startedAt: 1,
  })),
);
const completeMock = vi.hoisted(() => vi.fn(async () => undefined));
const recordPartialMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
);
const persistenceFailureTerminalMock = vi.hoisted(() =>
  vi.fn(async () => true),
);
const failMock = vi.hoisted(() => vi.fn(async () => undefined));
const cancelMock = vi.hoisted(() => vi.fn(async () => undefined));
const fallbackMock = vi.hoisted(() =>
  vi.fn(
    async (
      handle: Record<string, unknown>,
      input: Record<string, unknown>,
    ) => ({
      ...handle,
      ...input,
      executionId: "execution-fallback",
      parentExecutionId: handle.executionId,
    }),
  ),
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
  beginAiAuditExecutionInWorkspace: beginMock,
  markAiAuditDispatched: vi.fn(async () => undefined),
  completeAiAuditExecution: completeMock,
  failAiAuditExecution: failMock,
  cancelAiAuditExecution: cancelMock,
  fallbackAiAuditExecution: fallbackMock,
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
  sanitizeAiAuditDiagnostic: vi.fn(async (value: string) => ({
    value,
    redactions: [],
  })),
}));

import { sendCliChatStream } from "./cliApi";
import { sendCodexAppTurn } from "./codexAppApi";

const callbacks = () => ({
  onTextDelta: vi.fn(),
  onThinkingDelta: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn(),
  onFallback: vi.fn(),
});

describe("external runtime audit contracts", () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    codexStartResult = {
      status: "started",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      reusedThread: false,
    };
  });

  it("AI audit path: cli_chat_stream", async () => {
    const cb = callbacks();
    await sendCliChatStream(
      { cli: "codex", model: "gpt-5.6", prompt: "exact CLI prompt" },
      {
        projectId: "project-1",
        pathId: "cli_chat_stream",
        operationId: "turn-1",
      },
      cb,
    );
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathId: "cli_chat_stream",
        captureState: "partial",
        limitations: expect.arrayContaining([
          "external-runtime-internal-prompt-unobservable",
        ]),
        request: {
          provider: "cli",
          model: "gpt-5.6",
          messages: [{ role: "user", content: "exact CLI prompt" }],
          options: { cli: "codex" },
          auditMetadata: {
            runtimeObservation: {
              captureState: "partial",
              binaryPathExcluded: true,
              externalRuntimeInternalPromptObserved: false,
              providerPrivateThinkingObserved: false,
            },
          },
        },
      }),
    );
    listeners.get("cli:stream-done")?.({
      streamId: "execution-app",
      stop_reason: "end_turn",
      input_tokens: 2,
      output_tokens: 1,
    });
    listeners.get("cli:stream-chunk")?.({
      streamId: "execution-app",
      delta: "must not escape after terminal snapshot",
      block_type: "text",
    });
    await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
    expect(cb.onDone).toHaveBeenCalledOnce();
    expect(cb.onTextDelta).not.toHaveBeenCalled();
  });

  it("AI audit path: codex_app_server", async () => {
    const cb = callbacks();
    await sendCodexAppTurn(
      {
        projectId: "project-1",
        sessionId: "session-1",
        expectedWorkspacePath: "/workspace",
        grimodexTurnId: "turn-1",
        clientUserMessageId: "message-1",
        model: "gpt-5.6",
        effort: "max",
        contextPacket: "developer context",
        bootstrapHistory: "exact prior conversation",
        historyRevision: "revision-1",
        userMessage: "question",
        transport: "app-server",
      },
      cb,
    );
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathId: "codex_app_server",
        operationId: "turn-1",
        captureState: "partial",
        request: expect.objectContaining({
          provider: "cli",
          model: "gpt-5.6",
          messages: [],
          options: {
            runtime: "codex-app-server",
            effort: "max",
          },
          auditMetadata: expect.objectContaining({
            runtimeObservation: expect.objectContaining({
              effectiveRequestReceiptPending: true,
            }),
            correlation: {
              sessionId: "session-1",
              grimodexTurnId: "turn-1",
              clientUserMessageId: "message-1",
            },
          }),
        }),
      }),
      "/workspace",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "codex_app_start_turn",
      expect.objectContaining({
        projectId: "project-1",
        sessionId: "session-1",
        grimodexTurnId: "turn-1",
        contextPacket: "developer context",
        bootstrapHistory: "exact prior conversation",
        userMessage: "question",
        auditContext: {
          expectedWorkspacePath: "/workspace",
          projectId: "project-1",
          operationId: "turn-1",
          executionId: "execution-app",
          parentExecutionId: null,
          pathId: "codex_app_server",
        },
      }),
    );
    listeners.get("codex-app:event")?.({
      projectId: "project-1",
      sessionId: "session-1",
      grimodexTurnId: "turn-1",
      event: { type: "text-delta", delta: "answer" },
    });
    listeners.get("codex-app:event")?.({
      projectId: "project-1",
      sessionId: "session-1",
      grimodexTurnId: "turn-1",
      event: {
        type: "turn-completed",
        stopReason: "end_turn",
        inputTokens: 3,
        outputTokens: 1,
      },
    });
    await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
    expect(completeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        response: expect.objectContaining({ text: "answer" }),
      }),
    );
    expect(recordPartialMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        blockType: "text",
        delta: "answer",
      }),
    );
  });

  it("AI audit path: codex_app_cli_fallback", async () => {
    codexStartResult = {
      status: "rejected-before-turn",
      code: "APP_SERVER_UNAVAILABLE",
      message: "unavailable",
    };
    const cb = callbacks();
    await sendCodexAppTurn(
      {
        projectId: "project-1",
        sessionId: "session-1",
        expectedWorkspacePath: "/workspace",
        grimodexTurnId: "turn-1",
        clientUserMessageId: "message-1",
        contextPacket: "context",
        historyRevision: "revision-1",
        userMessage: "question",
        transport: "auto",
        fallbackCli: { cli: "codex", prompt: "fallback prompt" },
      },
      cb,
    );
    await vi.waitFor(() => expect(fallbackMock).toHaveBeenCalledOnce());
    expect(fallbackMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pathId: "codex_app_cli_fallback",
        captureState: "partial",
        request: expect.objectContaining({
          provider: "cli",
          messages: [{ role: "user", content: "fallback prompt" }],
          options: { cli: "codex" },
        }),
      }),
    );
    expect(cb.onFallback).toHaveBeenCalledOnce();
  });

  it("queues Codex deltas before failure and cleanup terminals", async () => {
    const cb = callbacks();
    const onTurnStarted = vi.fn();
    const cleanup = await sendCodexAppTurn(
      {
        projectId: "project-1",
        sessionId: "session-1",
        expectedWorkspacePath: "/workspace",
        grimodexTurnId: "turn-1",
        clientUserMessageId: "message-1",
        contextPacket: "context",
        historyRevision: "revision-1",
        userMessage: "question",
      },
      { ...cb, onTurnStarted },
    );
    await vi.waitFor(() => expect(onTurnStarted).toHaveBeenCalledOnce());
    recordPartialMock.mockClear();
    failMock.mockClear();
    listeners.get("codex-app:event")?.({
      projectId: "project-1",
      sessionId: "session-1",
      grimodexTurnId: "turn-1",
      event: { type: "text-delta", delta: "before error" },
    });
    listeners.get("codex-app:event")?.({
      projectId: "project-1",
      sessionId: "session-1",
      grimodexTurnId: "turn-1",
      event: { type: "turn-error", message: "failed", retryable: false },
    });
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(recordPartialMock).toHaveBeenCalledWith(expect.anything(), {
      streamSequence: 2,
      blockType: "text",
      delta: "before error",
    });
    expect(recordPartialMock.mock.invocationCallOrder[0]).toBeLessThan(
      cb.onTextDelta.mock.invocationCallOrder[0],
    );
    expect(cb.onTextDelta.mock.invocationCallOrder[0]).toBeLessThan(
      failMock.mock.invocationCallOrder[0],
    );
    cleanup();

    listeners.clear();
    const cleanupCallbacks = callbacks();
    const cleanupStarted = vi.fn();
    const cleanupTurn = await sendCodexAppTurn(
      {
        projectId: "project-1",
        sessionId: "session-2",
        expectedWorkspacePath: "/workspace",
        grimodexTurnId: "turn-2",
        clientUserMessageId: "message-2",
        contextPacket: "context",
        historyRevision: "revision-1",
        userMessage: "question",
      },
      { ...cleanupCallbacks, onTurnStarted: cleanupStarted },
    );
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledOnce());
    recordPartialMock.mockClear();
    cancelMock.mockClear();
    listeners.get("codex-app:event")?.({
      projectId: "project-1",
      sessionId: "session-2",
      grimodexTurnId: "turn-2",
      event: { type: "text-delta", delta: "before cleanup" },
    });
    cleanupTurn();
    listeners.get("codex-app:event")?.({
      projectId: "project-1",
      sessionId: "session-2",
      grimodexTurnId: "turn-2",
      event: { type: "turn-completed", stopReason: "interrupted" },
    });
    await vi.waitFor(() => expect(cancelMock).toHaveBeenCalledOnce());
    expect(recordPartialMock.mock.invocationCallOrder[0]).toBeLessThan(
      cancelMock.mock.invocationCallOrder[0],
    );
    expect(cancelMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          transportAbortRequested: true,
          abortCommandAcknowledged: true,
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

  it("fails closed without exposing a Codex delta when partial persistence fails", async () => {
    const cb = callbacks();
    const onTurnStarted = vi.fn();
    await sendCodexAppTurn(
      {
        projectId: "project-1",
        sessionId: "session-1",
        expectedWorkspacePath: "/workspace",
        grimodexTurnId: "turn-1",
        clientUserMessageId: "message-1",
        contextPacket: "context",
        historyRevision: "revision-1",
        userMessage: "question",
      },
      { ...cb, onTurnStarted },
    );
    await vi.waitFor(() => expect(onTurnStarted).toHaveBeenCalledOnce());
    recordPartialMock.mockRejectedValueOnce(new Error("ledger unavailable"));
    listeners.get("codex-app:event")?.({
      projectId: "project-1",
      sessionId: "session-1",
      grimodexTurnId: "turn-1",
      event: { type: "text-delta", delta: "hidden" },
    });
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onTextDelta).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("codex_app_interrupt_turn", {
      projectId: "project-1",
      sessionId: "session-1",
      grimodexTurnId: "turn-1",
    });
  });
});
