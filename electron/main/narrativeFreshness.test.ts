import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";

const INITIAL_DELAY_MS = 250;
const IDLE_POLL_INTERVAL_MS = 1_000;
const BACKLOG_DELAY_MS = 10;
const ERROR_RETRY_DELAY_MS = 1_000;

function summary(hasMore: boolean): string {
  return JSON.stringify({
    projectId: "project-1",
    fromSequenceExclusive: 0,
    throughSequenceInclusive: 1,
    affectedEdgeCount: 1,
    affectedConsumerCount: 1,
    hasMore,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createNarrativeFreshnessScheduler", () => {
  const schedulers: Array<{ dispose(): void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createScheduler(backend: unknown, warn = vi.fn()) {
    const scheduler = createNarrativeFreshnessScheduler(
      backend as Parameters<typeof createNarrativeFreshnessScheduler>[0],
      { warn },
    );
    schedulers.push(scheduler);
    return { scheduler, warn };
  }

  it("startをcoalesceし、起動後に1 cycleだけ自動実行する", async () => {
    const runNarrativeFreshnessCycle = vi.fn().mockResolvedValue(null);
    const { scheduler } = createScheduler({ runNarrativeFreshnessCycle });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(runNarrativeFreshnessCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();
  });

  it("feed空は前cycle完了からidle interval後に再確認する", async () => {
    const runNarrativeFreshnessCycle = vi.fn().mockResolvedValue(null);
    const { scheduler } = createScheduler({ runNarrativeFreshnessCycle });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - 1);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(2);
  });

  it("hasMore=trueは次の有界cycleだけを短いdelayで投入する", async () => {
    const runNarrativeFreshnessCycle = vi
      .fn()
      .mockResolvedValueOnce(summary(true))
      .mockResolvedValue(null);
    const { scheduler } = createScheduler({ runNarrativeFreshnessCycle });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS - 1);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(2);
  });

  it("C2-ZCのexpected NOT_READYだけをactivation ownerへ通知する", async () => {
    const runNarrativeFreshnessCycle = vi.fn().mockResolvedValue(
      JSON.stringify({ hasMore: false, cutoverNotReady: true }),
    );
    const onCutoverNotReady = vi.fn();
    const scheduler = createNarrativeFreshnessScheduler(
      { runNarrativeFreshnessCycle },
      { warn: vi.fn(), onCutoverNotReady },
    );
    schedulers.push(scheduler);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(onCutoverNotReady).toHaveBeenCalledOnce();
  });

  it("in-flight cycleを重複実行しない", async () => {
    const first = deferred<string | null>();
    const runNarrativeFreshnessCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(null);
    const { scheduler } = createScheduler({ runNarrativeFreshnessCycle });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 3);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();

    first.resolve(summary(true));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(2);
  });

  it("cycle失敗をwarnして有界retryを継続する", async () => {
    const runNarrativeFreshnessCycle = vi
      .fn()
      .mockRejectedValueOnce(new Error("cursor CAS failed"))
      .mockResolvedValue(null);
    const { scheduler, warn } = createScheduler({
      runNarrativeFreshnessCycle,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().map(String).join(" ")).toContain(
      "cursor CAS failed",
    );

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["backendがnull", null],
    ["旧bindingにmethodがない", {}],
  ])("%s場合はfail-softで停止する", async (_label, backend) => {
    const { scheduler, warn } = createScheduler(backend);

    expect(() => scheduler.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + IDLE_POLL_INTERVAL_MS);

    expect(warn).toHaveBeenCalledOnce();
  });

  it("disposeはpending/in-flight完了後のcycleを抑止する", async () => {
    const first = deferred<string | null>();
    const runNarrativeFreshnessCycle = vi.fn().mockReturnValue(first.promise);
    const { scheduler } = createScheduler({ runNarrativeFreshnessCycle });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();

    scheduler.dispose();
    scheduler.dispose();
    first.resolve(summary(true));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 2);

    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();
  });
});
