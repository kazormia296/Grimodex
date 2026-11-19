import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS,
  NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS,
  NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS,
  type NarrativeMaintenanceAcceptedCycle,
  type NarrativeMaintenanceCycleResult,
  type NarrativeMaintenanceWakeOrigin,
} from "./narrativeMaintenance.js";

/**
 * DR-PUBG-5-17: a wake carries an origin (`"demand"` from the Graph Index demand
 * timer, `"discovery"` for everything else), and the scheduler tells
 * `onCycleAccepted` whether the accepted cycle was demand-only. Bootstrap uses
 * that to skip `requestRediscovery()`.
 */

const BINDING = { authorityId: "authority-wake-origin", generation: 3 };
const INITIAL = NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS;
const BACKLOG = NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS;
const ERROR_RETRY = NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS;

const accepted = (hasMore = false): NarrativeMaintenanceCycleResult => ({
  status: "accepted",
  hasMore,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DR-PUBG-5-17: wake origin and demandOnly", () => {
  const schedulers: Array<{ dispose(): void | Promise<void> }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const scheduler of schedulers.splice(0)) {
      try {
        await scheduler.dispose();
      } catch {
        // fail-closed cleanup is not what these tests observe
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(runCycle: ReturnType<typeof vi.fn>) {
    const onCycleAccepted = vi.fn(
      (_cycle: NarrativeMaintenanceAcceptedCycle) => {},
    );
    const scheduler = createNarrativeMaintenanceScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => BINDING,
        runNarrativeMaintenanceCycle: runCycle,
      } as unknown as Parameters<typeof createNarrativeMaintenanceScheduler>[0],
      { warn: vi.fn(), onCycleAccepted },
    );
    schedulers.push(scheduler);
    scheduler.start();
    const wake = (
      projectIds: readonly string[],
      origin?: NarrativeMaintenanceWakeOrigin,
    ) =>
      origin === undefined
        ? scheduler.requestGraphIndexBuildWakesWithBinding?.(
            projectIds,
            BINDING,
          )
        : scheduler.requestGraphIndexBuildWakesWithBinding?.(
            projectIds,
            BINDING,
            origin,
          );
    const accepts = () =>
      onCycleAccepted.mock.calls.map(([cycle]) => cycle.demandOnly);
    return { scheduler, onCycleAccepted, wake, accepts };
  }

  async function startedAndIdle() {
    await vi.advanceTimersByTimeAsync(INITIAL);
  }

  it("a wake that only came from demand is a demand-only accepted cycle", async () => {
    const run = vi.fn().mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"], "demand");
    await vi.advanceTimersByTimeAsync(BACKLOG);

    expect(run).toHaveBeenCalledExactlyOnceWith({
      work: [],
      wakeProjectIds: ["project-a"],
      workspaceBinding: BINDING,
    });
    expect(accepts()).toEqual([true]);
  });

  it("a wake with no origin, and an explicit discovery wake, are not demand-only (W1 and the seam stay as they were)", async () => {
    const run = vi.fn().mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"]);
    await vi.advanceTimersByTimeAsync(BACKLOG);
    wake(["project-a"], "discovery");
    await vi.advanceTimersByTimeAsync(BACKLOG);

    expect(run).toHaveBeenCalledTimes(2);
    expect(accepts()).toEqual([false, false]);
  });

  it.each([
    ["demand then discovery", ["demand", "discovery"]],
    ["discovery then demand", ["discovery", "demand"]],
  ] as const)(
    "the same key asked for twice (%s) before its cycle is one discovery wake, not demand-only",
    async (_name, order) => {
      const run = vi.fn().mockResolvedValue(accepted());
      const { wake, accepts } = setup(run);
      await startedAndIdle();

      wake(["project-a"], order[0]);
      wake(["project-a"], order[1]);
      await vi.advanceTimersByTimeAsync(BACKLOG);

      expect(run).toHaveBeenCalledOnce();
      expect(accepts()).toEqual([false]);
    },
  );

  it("a cycle that carries a demand project and a discovery project together is not demand-only", async () => {
    const run = vi.fn().mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-d"], "demand");
    wake(["project-w"], "discovery");
    await vi.advanceTimersByTimeAsync(BACKLOG);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].wakeProjectIds.slice().sort()).toEqual([
      "project-d",
      "project-w",
    ]);
    expect(accepts()).toEqual([false]);
  });

  it("a work cycle is never demand-only, even while a demand wake is waiting behind it", async () => {
    const run = vi.fn().mockResolvedValue(accepted());
    const { scheduler, wake, accepts } = setup(run);
    await startedAndIdle();

    scheduler.requestWithBinding(
      {
        projectId: "project-a",
        runKind: "backfill",
        workKey: "backfill:v2",
        reason: "workspace-opened",
      },
      BINDING,
    );
    wake(["project-a"], "demand");
    await vi.advanceTimersByTimeAsync(BACKLOG + INITIAL);
    await vi.advanceTimersByTimeAsync(BACKLOG);

    // The work goes first (its wake waits for an empty batch), then the demand
    // wake runs by itself.
    expect(run.mock.calls[0]?.[0].work).toHaveLength(1);
    expect(run.mock.calls[0]?.[0].wakeProjectIds).toEqual([]);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      work: [],
      wakeProjectIds: ["project-a"],
    });
    expect(accepts()).toEqual([false, true]);
  });

  it("a failed demand cycle is requeued as a demand wake", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"], "demand");
    await vi.advanceTimersByTimeAsync(BACKLOG);
    expect(accepts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY);

    expect(run).toHaveBeenCalledTimes(2);
    expect(accepts()).toEqual([true]);
  });

  it("a discovery wake that arrives while a demand cycle is in flight is not demoted when that cycle fails and is requeued", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"], "demand");
    await vi.advanceTimersByTimeAsync(BACKLOG);
    expect(run).toHaveBeenCalledOnce();

    // The in-flight cycle owns the demand entry; discovery registers the same
    // key behind it, then the cycle fails and requeues under its own origin.
    wake(["project-a"], "discovery");
    first.reject(new Error("transient"));
    await vi.advanceTimersByTimeAsync(ERROR_RETRY + BACKLOG);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(accepts()).toEqual([false]);
  });

  it("a demand wake that arrives while a discovery cycle is in flight does not turn it into demand when that cycle fails", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"], "discovery");
    await vi.advanceTimersByTimeAsync(BACKLOG);
    wake(["project-a"], "demand");
    first.reject(new Error("transient"));
    await vi.advanceTimersByTimeAsync(ERROR_RETRY + BACKLOG);

    expect(accepts()).toEqual([false]);
  });

  it("a hasMore continuation of a demand-only cycle stays demand; one of a work cycle is discovery", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(accepted(true))
      .mockResolvedValueOnce(accepted(false))
      .mockResolvedValueOnce(accepted(true))
      .mockResolvedValueOnce(accepted(false));
    const { scheduler, wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"], "demand");
    await vi.advanceTimersByTimeAsync(BACKLOG * 5);
    expect(run).toHaveBeenCalledTimes(2);
    expect(accepts()).toEqual([true, true]);

    scheduler.requestWithBinding(
      {
        projectId: "project-b",
        runKind: "backfill",
        workKey: "backfill:v2",
        reason: "workspace-opened",
      },
      BINDING,
    );
    await vi.advanceTimersByTimeAsync(INITIAL + BACKLOG * 5);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[2]?.[0].work).toHaveLength(1);
    expect(run.mock.calls[3]?.[0]).toMatchObject({
      work: [],
      wakeProjectIds: ["project-b"],
    });
    expect(accepts()).toEqual([true, true, false, false]);
  });

  it("a demand cycle that Native could not admit for capacity keeps its origin when the exact request is retried", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "maintenance-delivery-capacity",
      })
      .mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"], "demand");
    await vi.advanceTimersByTimeAsync(BACKLOG);
    expect(accepts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY * 2);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(accepts()).toEqual([true]);
  });

  it("a terminal-proof restore of a demand wake keeps its origin (the proof owner's completionWakeOrigins)", async () => {
    const firstCancelStarted = deferred<void>();
    const firstCancelResponse = deferred<string>();
    const cycleSettled = deferred<void>();
    let firstAttemptId: string | null = null;
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "maintenance-workspace-changed-during-cycle",
      })
      .mockResolvedValue(accepted());
    const terminalReceipt = (attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: attemptId === firstAttemptId ? "interrupted" : "succeeded",
        stopReason: null,
        generation: BINDING.generation,
        workspaceBinding: BINDING,
        publishedGeneration:
          attemptId === firstAttemptId ? null : BINDING.generation,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    const cancel = vi.fn((attemptId: string) => {
      if (attemptId === firstAttemptId && cancel.mock.calls.length === 1) {
        firstCancelStarted.resolve();
        return firstCancelResponse.promise;
      }
      return terminalReceipt(attemptId);
    });
    const onCycleAccepted = vi.fn(
      (_cycle: NarrativeMaintenanceAcceptedCycle) => {},
    );
    const scheduler = createNarrativeMaintenanceScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => BINDING,
        runNarrativeMaintenanceCycle: run,
        beginNarrativeMaintenanceAttempt: vi.fn(
          (attemptId: string, received: typeof BINDING) => {
            firstAttemptId ??= attemptId;
            return JSON.stringify({
              status: "open",
              attemptId,
              authorityId: received.authorityId,
              generation: received.generation,
            });
          },
        ),
        cancelNarrativeMaintenanceAttempt: cancel,
        ackNarrativeMaintenanceDelivery: vi
          .fn()
          .mockResolvedValueOnce({ status: "pending" })
          .mockResolvedValue({ status: "retired" }),
      } as unknown as Parameters<typeof createNarrativeMaintenanceScheduler>[0],
      {
        warn: vi.fn(),
        onCycleAccepted,
        onCycleSettled: ({ cycleGeneration }) => {
          if (cycleGeneration === 1) cycleSettled.resolve();
        },
      },
    );
    schedulers.push(scheduler);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL);
    scheduler.requestGraphIndexBuildWakesWithBinding?.(
      ["project-late-wake"],
      BINDING,
      "demand",
    );
    await vi.advanceTimersByTimeAsync(BACKLOG);
    await firstCancelStarted.promise;
    firstCancelResponse.resolve("not-json");
    await cycleSettled.promise;

    const lease = await scheduler.quiesceForWorkspaceSwitch?.();
    lease?.resume(true);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY + BACKLOG);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      work: [],
      wakeProjectIds: ["project-late-wake"],
    });
    expect(onCycleAccepted.mock.calls.map(([c]) => c.demandOnly)).toEqual([
      true,
    ]);
  });

  it("an unknown origin value is treated as discovery", async () => {
    const run = vi.fn().mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(
      ["project-a"],
      "whatever" as unknown as NarrativeMaintenanceWakeOrigin,
    );
    await vi.advanceTimersByTimeAsync(BACKLOG);

    expect(accepts()).toEqual([false]);
  });
});
