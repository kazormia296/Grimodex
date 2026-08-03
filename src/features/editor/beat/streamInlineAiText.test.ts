// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

type ListenHandler = (payload: unknown) => void;

interface Registration {
  eventName: string;
  handler: ListenHandler;
  unlisten: ReturnType<typeof vi.fn>;
  active: boolean;
}

const registrations: Registration[] = [];
const invokeMock = vi.fn();
const auditMocks = vi.hoisted(() => ({
  begin: vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    expectedWorkspacePath: "/workspace",
    operationId: "operation-test",
    executionId: "execution-test",
    parentExecutionId: null,
    startedAt: 1,
  })),
  dispatched: vi.fn(async () => undefined),
  complete: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  partial: vi.fn(async () => undefined),
  recovery: vi.fn(async () => undefined),
}));

vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: auditMocks.begin,
  markAiAuditDispatched: auditMocks.dispatched,
  completeAiAuditExecution: auditMocks.complete,
  failAiAuditExecution: auditMocks.fail,
  cancelAiAuditExecution: auditMocks.cancel,
  recordAiAuditPartials: auditMocks.partial,
  attemptAiAuditPersistenceFailureTerminal: auditMocks.recovery,
}));

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: vi.fn(async (eventName: string, handler: ListenHandler) => {
    const reg: Registration = {
      eventName,
      handler,
      active: true,
      unlisten: vi.fn(() => {
        reg.active = false;
      }),
    };
    registrations.push(reg);
    return reg.unlisten;
  }),
}));

import { streamInlineAiText } from "./streamInlineAiText";

function emit(event: string, payload: unknown) {
  // Match the actual Tauri behaviour: deliver to every active listener for
  // this event. If listeners have leaked from prior calls, they fire too —
  // which is exactly the regression we want to catch.
  for (const reg of registrations) {
    if (reg.active && reg.eventName === event) reg.handler(payload);
  }
}

function activeCount(eventName?: string): number {
  return registrations.filter(
    (r) => r.active && (eventName === undefined || r.eventName === eventName),
  ).length;
}

describe("streamInlineAiText", () => {
  beforeEach(() => {
    registrations.length = 0;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("releases all listeners after onDone (regression for the 337521c leak)", async () => {
    const promise = streamInlineAiText([{ role: "user", content: "hi" }], {
      auditPathId: "beat_alternative",
      auditExpectedWorkspacePath: "/workspace",
    });
    await vi.waitFor(() => expect(activeCount()).toBe(3));

    emit("inline-ai:stream-chunk", {
      streamId: "execution-test",
      delta: "hello",
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      streamId: "execution-test",
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    const result = await promise;

    expect(result).toEqual({ ok: true, text: "hello" });
    expect(activeCount()).toBe(0);
  });

  it("releases all listeners after onError", async () => {
    const promise = streamInlineAiText([{ role: "user", content: "hi" }], {
      auditPathId: "beat_alternative",
      auditExpectedWorkspacePath: "/workspace",
    });
    await vi.waitFor(() => expect(activeCount()).toBe(3));

    emit("inline-ai:stream-error", {
      streamId: "execution-test",
      message: "boom",
    });

    const result = await promise;

    expect(result).toEqual({ ok: false, error: "boom" });
    expect(activeCount()).toBe(0);
  });

  it("running multiple streams sequentially does NOT accumulate listeners", async () => {
    for (let i = 0; i < 3; i++) {
      const promise = streamInlineAiText([{ role: "user", content: `m${i}` }], {
        auditPathId: "beat_alternative",
        auditExpectedWorkspacePath: "/workspace",
      });
      await vi.waitFor(() => expect(activeCount()).toBe(3));

      emit("inline-ai:stream-chunk", {
        streamId: "execution-test",
        delta: `r${i}`,
        block_type: "text",
      });
      emit("inline-ai:stream-done", {
        streamId: "execution-test",
        stop_reason: "end_turn",
        input_tokens: 0,
        output_tokens: 0,
      });
      const result = await promise;
      expect(result).toEqual({ ok: true, text: `r${i}` });
      // Every previous run's listeners must be gone before the next run.
      expect(activeCount()).toBe(0);
    }

    // 3 runs × 3 events. None active.
    expect(registrations.length).toBe(9);
    expect(activeCount()).toBe(0);
  });

  it("ignores thinking-block deltas", async () => {
    const promise = streamInlineAiText([{ role: "user", content: "hi" }], {
      auditPathId: "beat_alternative",
      auditExpectedWorkspacePath: "/workspace",
    });
    await vi.waitFor(() => expect(activeCount()).toBe(3));

    emit("inline-ai:stream-chunk", {
      streamId: "execution-test",
      delta: "secret",
      block_type: "thinking",
    });
    emit("inline-ai:stream-chunk", {
      streamId: "execution-test",
      delta: "answer",
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      streamId: "execution-test",
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    const result = await promise;
    expect(result).toEqual({ ok: true, text: "answer" });
  });

  it("forwards model option to invoke", async () => {
    const promise = streamInlineAiText([{ role: "user", content: "hi" }], {
      model: "claude-haiku-4-5-20251001",
      auditPathId: "beat_alternative",
      auditExpectedWorkspacePath: "/workspace",
    });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "send_inline_ai_stream",
        expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
      ),
    );

    emit("inline-ai:stream-done", {
      streamId: "execution-test",
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });
    await promise;
  });

  it("invoke rejection surfaces as ok=false and releases listeners", async () => {
    invokeMock.mockRejectedValueOnce(new Error("invoke crashed"));

    const result = await streamInlineAiText([{ role: "user", content: "hi" }], {
      auditPathId: "beat_alternative",
      auditExpectedWorkspacePath: "/workspace",
    });

    expect(result).toEqual({ ok: false, error: "invoke crashed" });
    expect(activeCount()).toBe(0);
  });
});
