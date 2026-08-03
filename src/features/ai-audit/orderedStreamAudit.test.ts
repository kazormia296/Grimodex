import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrderedStreamAuditBatchQueue } from "./orderedStreamAudit";

interface Item {
  readonly id: number;
  readonly bytes?: number;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createOrderedStreamAuditBatchQueue", () => {
  it("flushes a partial batch after 25ms and then exposes callbacks in receive order", async () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const callbacks: number[] = [];
    const queue = createOrderedStreamAuditBatchQueue<Item>({
      persistBatch: async (items) => {
        batches.push(items.map((item) => item.id));
      },
      onPersistenceFailure: vi.fn(),
    });

    queue.enqueue({ id: 1 }, () => callbacks.push(1));
    queue.enqueue({ id: 2 }, () => callbacks.push(2));
    await vi.advanceTimersByTimeAsync(24);
    expect(batches).toEqual([]);
    expect(callbacks).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await queue.whenIdle();
    expect(batches).toEqual([[1, 2]]);
    expect(callbacks).toEqual([1, 2]);
  });

  it("flushes immediately at 64 items without waiting for the timer", async () => {
    vi.useFakeTimers();
    const persistBatch = vi.fn(async (_items: readonly Item[]) => undefined);
    const queue = createOrderedStreamAuditBatchQueue<Item>({
      persistBatch,
      onPersistenceFailure: vi.fn(),
    });

    for (let id = 1; id <= 64; id += 1) {
      expect(queue.enqueue({ id })).toBe(true);
    }
    await queue.whenIdle();

    expect(vi.getTimerCount()).toBe(0);
    expect(persistBatch).toHaveBeenCalledTimes(1);
    const persistedItems = persistBatch.mock.calls[0]?.[0] ?? [];
    expect(persistedItems).toHaveLength(64);
    expect(persistedItems.map((item) => item.id)).toEqual(
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
  });

  it("flushes pending and in-flight batches before the terminal barrier", async () => {
    vi.useFakeTimers();
    const firstBatch = deferred();
    const order: string[] = [];
    const persistBatch = vi.fn(async (items: readonly Item[]) => {
      order.push(`persist:${items.map((item) => item.id).join(",")}:start`);
      await firstBatch.promise;
      order.push("persist:done");
    });
    const queue = createOrderedStreamAuditBatchQueue<Item>({
      persistBatch,
      onPersistenceFailure: vi.fn(),
    });

    queue.enqueue({ id: 1 }, () => order.push("callback:1"));
    queue.enqueue({ id: 2 }, () => order.push("callback:2"));
    expect(
      queue.close(
        async () => {
          order.push("terminal:persist");
        },
        () => order.push("terminal:callback"),
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(order).toEqual(["persist:1,2:start"]);
    expect(vi.getTimerCount()).toBe(0);

    firstBatch.resolve();
    await queue.whenIdle();
    expect(order).toEqual([
      "persist:1,2:start",
      "persist:done",
      "callback:1",
      "callback:2",
      "terminal:persist",
      "terminal:callback",
    ]);
  });

  it("does not treat a consumer callback exception as an audit failure", async () => {
    vi.useFakeTimers();
    const onPersistenceFailure = vi.fn();
    const terminal = vi.fn(async () => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const queue = createOrderedStreamAuditBatchQueue<Item>({
      persistBatch: async () => undefined,
      onPersistenceFailure,
    });

    queue.enqueue({ id: 1 }, () => {
      throw new Error("UI callback failed");
    });
    queue.close(terminal);
    await queue.whenIdle();

    expect(onPersistenceFailure).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(queue.failed).toBe(false);
    consoleError.mockRestore();
  });

  it("fails closed once on batch persistence failure and suppresses callbacks and terminal", async () => {
    vi.useFakeTimers();
    const onPersistenceFailure = vi.fn();
    const callbacks = vi.fn();
    const terminal = vi.fn(async () => undefined);
    const queue = createOrderedStreamAuditBatchQueue<Item>({
      persistBatch: async () => {
        throw new Error("ledger unavailable");
      },
      onPersistenceFailure,
    });

    queue.enqueue({ id: 1 }, callbacks);
    queue.enqueue({ id: 2 }, callbacks);
    queue.close(terminal);
    await queue.whenIdle();

    expect(onPersistenceFailure).toHaveBeenCalledTimes(1);
    expect(onPersistenceFailure.mock.calls[0][0]).toMatchObject({
      message: "ledger unavailable",
    });
    expect(callbacks).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(queue.failed).toBe(true);
    expect(queue.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts queued plus in-flight items and fails closed at the item backlog cap", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const onPersistenceFailure = vi.fn();
    const callbacks = vi.fn();
    const queue = createOrderedStreamAuditBatchQueue<Item>({
      persistBatch: () => inFlight.promise,
      onPersistenceFailure,
      maxBatchItems: 1,
      maxPendingItems: 2,
    });

    expect(queue.enqueue({ id: 1 }, callbacks)).toBe(true);
    await Promise.resolve();
    expect(queue.enqueue({ id: 2 }, callbacks)).toBe(true);
    expect(queue.pendingItemCount).toBe(2);
    expect(queue.enqueue({ id: 3 }, callbacks)).toBe(false);

    expect(onPersistenceFailure).toHaveBeenCalledTimes(1);
    expect(onPersistenceFailure.mock.calls[0][0]).toMatchObject({
      code: "AI_AUDIT_STREAM_BACKLOG_EXCEEDED",
    });
    expect(vi.getTimerCount()).toBe(0);
    inFlight.resolve();
    await queue.whenIdle();
    expect(callbacks).not.toHaveBeenCalled();
    expect(onPersistenceFailure).toHaveBeenCalledTimes(1);
  });

  it("uses the injected byte measurement for the queued plus in-flight byte cap", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const onPersistenceFailure = vi.fn();
    const queue = createOrderedStreamAuditBatchQueue<Item>({
      persistBatch: () => inFlight.promise,
      onPersistenceFailure,
      measureItem: (item) => item.bytes ?? 0,
      maxBatchItems: 1,
      maxPendingBytes: 10,
    });

    expect(queue.enqueue({ id: 1, bytes: 6 })).toBe(true);
    await Promise.resolve();
    expect(queue.enqueue({ id: 2, bytes: 4 })).toBe(true);
    expect(queue.pendingByteCount).toBe(10);
    expect(queue.enqueue({ id: 3, bytes: 1 })).toBe(false);
    expect(onPersistenceFailure).toHaveBeenCalledTimes(1);
    expect(onPersistenceFailure.mock.calls[0][0]).toMatchObject({
      code: "AI_AUDIT_STREAM_BACKLOG_EXCEEDED",
    });

    inFlight.resolve();
    await queue.whenIdle();
  });
});
