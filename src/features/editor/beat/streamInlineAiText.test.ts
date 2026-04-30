// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

type ListenHandler = (event: { payload: unknown }) => void;

interface Registration {
  eventName: string;
  handler: ListenHandler;
  unlisten: ReturnType<typeof vi.fn>;
  active: boolean;
}

const registrations: Registration[] = [];
const invokeMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
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
    if (reg.active && reg.eventName === event) reg.handler({ payload });
  }
}

function activeCount(eventName?: string): number {
  return registrations.filter(
    (r) => r.active && (eventName === undefined || r.eventName === eventName),
  ).length;
}

// Drain enough microtasks for sendInlineAiStream's internal `await Promise.all`
// to settle, invoke() to be called, and the streamInlineAiText `.then` that
// captures the cleanup function to fire.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("streamInlineAiText", () => {
  beforeEach(() => {
    registrations.length = 0;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("releases all listeners after onDone (regression for the 337521c leak)", async () => {
    const promise = streamInlineAiText([{ role: "user", content: "hi" }]);
    await flush();

    expect(activeCount()).toBe(3);

    emit("inline-ai:stream-chunk", { delta: "hello", block_type: "text" });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    const result = await promise;

    expect(result).toEqual({ ok: true, text: "hello" });
    expect(activeCount()).toBe(0);
  });

  it("releases all listeners after onError", async () => {
    const promise = streamInlineAiText([{ role: "user", content: "hi" }]);
    await flush();

    emit("inline-ai:stream-error", { message: "boom" });

    const result = await promise;

    expect(result).toEqual({ ok: false, error: "boom" });
    expect(activeCount()).toBe(0);
  });

  it("running multiple streams sequentially does NOT accumulate listeners", async () => {
    for (let i = 0; i < 3; i++) {
      const promise = streamInlineAiText([{ role: "user", content: `m${i}` }]);
      await flush();

      emit("inline-ai:stream-chunk", { delta: `r${i}`, block_type: "text" });
      emit("inline-ai:stream-done", {
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
    const promise = streamInlineAiText([{ role: "user", content: "hi" }]);
    await flush();

    emit("inline-ai:stream-chunk", { delta: "secret", block_type: "thinking" });
    emit("inline-ai:stream-chunk", { delta: "answer", block_type: "text" });
    emit("inline-ai:stream-done", {
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
    });
    await flush();

    expect(invokeMock).toHaveBeenCalledWith(
      "send_inline_ai_stream",
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
    );

    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });
    await promise;
  });

  it("invoke rejection surfaces as ok=false and releases listeners", async () => {
    invokeMock.mockRejectedValueOnce(new Error("invoke crashed"));

    const result = await streamInlineAiText([{ role: "user", content: "hi" }]);

    expect(result).toEqual({ ok: false, error: "invoke crashed" });
    expect(activeCount()).toBe(0);
  });
});
