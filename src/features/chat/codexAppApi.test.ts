import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();
const invokeMock = vi.fn<
  (..._args: unknown[]) => Promise<
    | {
        codexThreadId?: string;
        codexTurnId?: string;
      }
    | undefined
  >
>(async (..._args: unknown[]) => undefined);
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
import { sendCodexAppTurn } from "./codexAppApi";

const basePayload = {
  projectId: "p1",
  sessionId: "s1",
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
    invokeMock.mockResolvedValue(undefined);
    listenMock.mockClear();
    vi.mocked(cliApi.sendCliChatStream).mockReset();
    vi.mocked(cliApi.sendCliChatStream).mockResolvedValue(() => {});
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
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
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

  it("falls back to codex exec only when startup invoke rejects in auto mode", async () => {
    invokeMock.mockRejectedValueOnce(new Error("app server unavailable"));
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

  it("still falls back when only thread creation completed before turn acceptance failed", async () => {
    invokeMock.mockRejectedValueOnce(new Error("turn start rejected"));
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

  it("does not start a fallback after the caller has cleaned up", async () => {
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
    await Promise.resolve();
    expect(callbacks.onFallback).not.toHaveBeenCalled();
    expect(cliApi.sendCliChatStream).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});
