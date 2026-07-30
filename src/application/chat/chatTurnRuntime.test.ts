import { describe, expect, it, vi } from "vitest";
import { createChatTurnRuntime } from "./chatTurnRuntime";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createChatTurnRuntime", () => {
  it("keeps quiescence pending until the tracked turn resolves", async () => {
    const runtime = createChatTurnRuntime();
    const turn = deferred<void>();
    const tracked = runtime.trackTurn(turn.promise);
    const settled = vi.fn();
    const flushing = runtime.awaitPendingTurns().then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    turn.resolve();
    await tracked;
    await flushing;

    expect(settled).toHaveBeenCalledOnce();
    await expect(runtime.awaitPendingTurns()).resolves.toBeUndefined();
  });

  it("waits for turns added while an earlier tracked turn is settling", async () => {
    const runtime = createChatTurnRuntime();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstTracked = runtime.trackTurn(first.promise);
    const settled = vi.fn();
    const flushing = runtime.awaitPendingTurns().then(settled);

    runtime.trackTurn(second.promise);
    first.resolve();
    await firstTracked;
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    second.resolve();
    await flushing;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("removes a rejected turn after reporting its quiescence failure", async () => {
    const runtime = createChatTurnRuntime();
    const turn = deferred<void>();
    const tracked = runtime.trackTurn(turn.promise);
    const flushing = runtime.awaitPendingTurns();
    const failure = new Error("persistence failed");

    turn.reject(failure);

    await expect(tracked).rejects.toBe(failure);
    await expect(flushing).rejects.toThrow("persistence failed");
    expect(runtime.hasPendingTurns()).toBe(false);
    await expect(runtime.awaitPendingTurns()).resolves.toBeUndefined();
  });

  it("latches a turn failure that settles before the provider starts", async () => {
    const runtime = createChatTurnRuntime();
    const failure = new Error("old-scope persistence failed");
    const tracked = runtime.trackTurn(Promise.reject(failure));

    await expect(tracked).rejects.toBe(failure);
    await Promise.resolve();

    expect(runtime.hasPendingTurns()).toBe(true);
    await expect(runtime.awaitPendingTurns()).rejects.toThrow(
      "old-scope persistence failed",
    );
    expect(runtime.hasPendingTurns()).toBe(false);
  });
});
