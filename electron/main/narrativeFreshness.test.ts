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
  const schedulers: Array<{ dispose(): void | Promise<void> }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await Promise.all(
      schedulers.splice(0).map((scheduler) => Promise.resolve(scheduler.dispose())),
    );
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createScheduler(
    backend: unknown,
    warn = vi.fn(),
    options: Record<string, unknown> = {},
  ) {
    const scheduler = createNarrativeFreshnessScheduler(
      backend as Parameters<typeof createNarrativeFreshnessScheduler>[0],
      { warn, ...options },
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

  it("coalesces validated Native invalidations into one early idle cycle", async () => {
    const runNarrativeFreshnessCycle = vi.fn().mockResolvedValue(null);
    const { scheduler } = createScheduler({ runNarrativeFreshnessCycle });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    scheduler.handleBackendEvent("related-scenes:invalidated", {
      queryBinding: "query-1",
    });
    scheduler.handleBackendEvent("related-scenes:invalidated", {
      queryBinding: "query-2",
    });
    expect(scheduler.getQuiescenceState?.().wakePending).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(2);
    expect(scheduler.getQuiescenceState?.().wakePending).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - 1);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(3);
  });

  it("keeps one follow-up without overlapping an in-flight cycle or claiming quiescence", async () => {
    const first = deferred<string | null>();
    const idle = JSON.stringify({
      hasMore: false,
      noWrite: true,
      quiescenceState: { stateDigest: "digest" },
    });
    const runNarrativeFreshnessCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(idle);
    const onCycleCompleted = vi.fn();
    const { scheduler } = createScheduler(
      { runNarrativeFreshnessCycle },
      vi.fn(),
      { onCycleCompleted },
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    scheduler.handleBackendEvent("related-scenes:invalidated", {
      queryBinding: "query-1",
    });
    scheduler.handleBackendEvent("related-scenes:invalidated", {
      queryBinding: "query-2",
    });
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 2);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();
    first.resolve(idle);
    await vi.advanceTimersByTimeAsync(0);
    expect(onCycleCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        wakePending: true,
        nextCycleGuardStateDigest: null,
      }),
    );
    expect(scheduler.getQuiescenceState?.()).toMatchObject({
      inFlight: false,
      wakePending: true,
      nextCycleGuardStateDigest: null,
      quiescenceState: null,
    });
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledTimes(2);
    expect(scheduler.getQuiescenceState?.()).toMatchObject({
      wakePending: false,
      nextCycleGuardStateDigest: "digest",
    });
    scheduler.handleBackendEvent("related-scenes:invalidated", {
      queryBinding: "query-3",
    });
    expect(scheduler.getQuiescenceState?.()).toMatchObject({
      wakePending: true,
      nextCycleGuardStateDigest: null,
      quiescenceState: null,
    });
  });

  it("ignores unrelated or malformed notifications and notifications outside its lifetime", async () => {
    const runNarrativeFreshnessCycle = vi.fn().mockResolvedValue(null);
    const { scheduler } = createScheduler({ runNarrativeFreshnessCycle });
    const valid = { queryBinding: "query-1" };
    scheduler.handleBackendEvent("related-scenes:invalidated", valid);
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeFreshnessCycle).not.toHaveBeenCalled();
    scheduler.start();
    scheduler.handleBackendEvent("related-scenes:index-ready", valid);
    scheduler.handleBackendEvent("related-scenes:invalidated", {
      projectId: "project-1",
    });
    scheduler.handleBackendEvent("related-scenes:invalidated", {
      ...valid,
      projectId: "project-1",
    });
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(runNarrativeFreshnessCycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    scheduler.handleBackendEvent("related-scenes:invalidated", valid);
    scheduler.dispose();
    scheduler.handleBackendEvent("related-scenes:invalidated", valid);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS);
    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();
    expect(scheduler.getQuiescenceState?.().wakePending).toBe(false);
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
    const runNarrativeFreshnessCycle = vi
      .fn()
      .mockResolvedValue(
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

  it("cycle完了後かつin-flight解放後にだけmain observationを通知する", async () => {
    const first = deferred<string | null>();
    const runNarrativeFreshnessCycle = vi.fn().mockReturnValue(first.promise);
    const onCycleCompleted = vi.fn();
    const { scheduler } = createScheduler(
      { runNarrativeFreshnessCycle },
      vi.fn(),
      { onCycleCompleted },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(onCycleCompleted).not.toHaveBeenCalled();

    first.resolve(summary(false));
    await Promise.resolve();
    await Promise.resolve();
    expect(onCycleCompleted).toHaveBeenCalledOnce();
    const [observation] = onCycleCompleted.mock.calls[0] as [
      { cycleStartedAtMs: number; observedAtMs: number },
    ];
    expect(observation.cycleStartedAtMs).toBeLessThanOrEqual(
      observation.observedAtMs,
    );
    expect(onCycleCompleted).toHaveBeenCalledWith({
      cycleGeneration: 1,
      cycleStartedAtMs: expect.any(Number),
      observedAtMs: expect.any(Number),
      inFlight: false,
      hasMore: false,
      noWrite: false,
      heldProjectId: null,
      cutoverNotReady: false,
      wakePending: false,
      timerScheduled: true,
      nextCycleGuardStateDigest: null,
      quiescenceState: undefined,
    });
  });

  it("captures cycle start before the native callback advances the clock", async () => {
    const t1 = 10_000;
    const t2 = 20_000;
    vi.setSystemTime(t1 - INITIAL_DELAY_MS);
    let nativeEnteredAtMs = 0;
    const runNarrativeFreshnessCycle = vi.fn().mockImplementation(async () => {
      vi.setSystemTime(t2);
      nativeEnteredAtMs = Date.now();
      return summary(false);
    });
    const onCycleCompleted = vi.fn();
    const { scheduler } = createScheduler(
      { runNarrativeFreshnessCycle },
      vi.fn(),
      { onCycleCompleted },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    const [observation] = onCycleCompleted.mock.calls[0] as [
      { cycleStartedAtMs: number },
    ];
    expect(observation.cycleStartedAtMs).toBe(t1);
    expect(observation.cycleStartedAtMs).toBeLessThan(nativeEnteredAtMs);
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

    const firstDispose = scheduler.dispose();
    const secondDispose = scheduler.dispose();
    let disposed = false;
    void firstDispose.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    first.resolve(summary(true));
    await expect(firstDispose).resolves.toBeUndefined();
    await expect(secondDispose).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 2);

    expect(runNarrativeFreshnessCycle).toHaveBeenCalledOnce();
  });
});
