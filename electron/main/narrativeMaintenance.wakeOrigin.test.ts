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

  type ReceiptWork = { workKey: string; status: "succeeded" | "failed" };
  const GRAPH_BUILD_WORK: ReceiptWork = {
    workKey:
      "narrative-maintenance:v1/nir1-graph-index-build/project-a/nir1-graph-index-build/epoch/epoch-1",
    status: "succeeded",
  };
  const FAILED_VERIFY_WORK: ReceiptWork = {
    workKey: "narrative-maintenance:v1/dependency-verify/project-a/verify:v1",
    status: "failed",
  };
  const VERIFY_WORK: ReceiptWork = {
    workKey: "narrative-maintenance:v1/dependency-verify/project-a/verify:v1",
    status: "succeeded",
  };

  /**
   * A backend with the attempt lifecycle, so the scheduler adopts a Native
   * terminal receipt for each accepted cycle. `receiptWorks` is what Native
   * says the cycle ran (a wake-only cycle plans its own durable work).
   */
  interface SetupOptions {
    /** What Native's receipt says a succeeded cycle ran. */
    readonly receiptWorks?: readonly ReceiptWork[];
    /** A rejected first call leaves an interrupted attempt (wake requeued). */
    readonly interruptFirstAttempt?: boolean;
    /** Interrupt this many leading attempts instead (overrides the flag). */
    readonly interruptAttempts?: number;
    /** The stop reason of that interrupted first attempt (default none). */
    readonly stopReason?: "foreground-preempted" | null;
    /** The binding the backend reports (and every attempt/receipt carries). */
    readonly binding?: typeof BINDING;
    /** The binding `wake()` registers under (default: `binding`). */
    readonly wakeBinding?: typeof BINDING;
    readonly reconcile?: ReturnType<typeof vi.fn>;
  }

  function lifecycleBackend(
    runCycle: ReturnType<typeof vi.fn>,
    options: SetupOptions = {},
  ) {
    const binding = options.binding ?? BINDING;
    const interruptedAttemptIds = new Set<string>();
    const interruptCount =
      options.interruptAttempts ?? (options.interruptFirstAttempt ? 1 : 0);
    return {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle: runCycle,
      ...(options.reconcile === undefined
        ? {}
        : { reconcileNarrativeMaintenanceRecovery: options.reconcile }),
      ackNarrativeMaintenanceDelivery: vi
        .fn()
        .mockResolvedValue({ status: "retired" }),
      beginNarrativeMaintenanceAttempt: vi.fn(
        (attemptId: string, received: typeof BINDING) => {
          if (interruptedAttemptIds.size < interruptCount) {
            interruptedAttemptIds.add(attemptId);
          }
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: received.authorityId,
            generation: received.generation,
          });
        },
      ),
      cancelNarrativeMaintenanceAttempt: vi.fn((attemptId: string) => {
        // A rejected call leaves Native's attempt interrupted (no stop
        // reason): the scheduler then requeues the claimed wake.
        const interrupted = interruptedAttemptIds.has(attemptId);
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: interrupted ? "interrupted" : "succeeded",
          stopReason: interrupted ? (options.stopReason ?? null) : null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: interrupted ? null : binding.generation,
          works: interrupted ? [] : (options.receiptWorks ?? []),
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      }),
    } as unknown as Parameters<typeof createNarrativeMaintenanceScheduler>[0];
  }

  function setup(
    runCycle: ReturnType<typeof vi.fn>,
    options: SetupOptions = {},
  ) {
    const onCycleAccepted = vi.fn(
      (_cycle: NarrativeMaintenanceAcceptedCycle) => {},
    );
    const wakeBinding = options.wakeBinding ?? options.binding ?? BINDING;
    const scheduler = createNarrativeMaintenanceScheduler(
      lifecycleBackend(runCycle, options),
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
            wakeBinding,
          )
        : scheduler.requestGraphIndexBuildWakesWithBinding?.(
            projectIds,
            wakeBinding,
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

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
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
    const { wake, accepts } = setup(run, { interruptFirstAttempt: true });
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
    const { wake, accepts } = setup(run, { interruptFirstAttempt: true });
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
    const { wake, accepts } = setup(run, { interruptFirstAttempt: true });
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

  // ---- addendum 1 (independent review) ----------------------------------

  it("a discovery wake that merges into a demand cycle's key while the cycle awaits its recovery preflight is not absorbed as demand (race A)", async () => {
    const releaseReconcile = deferred<null>();
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => releaseReconcile.promise)
      .mockResolvedValue(null);
    const run = vi.fn().mockResolvedValue(accepted());
    const { wake, accepts } = setup(run, { reconcile });
    await startedAndIdle();

    wake(["project-a"], "demand");
    await vi.advanceTimersByTimeAsync(BACKLOG);
    // The demand cycle has claimed its entry and is parked in the preflight.
    expect(run).not.toHaveBeenCalled();
    wake(["project-a"]);
    releaseReconcile.resolve(null);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY * 4);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      wakeProjectIds: ["project-a"],
    });
    expect(accepts()).toEqual([false]);
  });

  it("a discovery wake that merges into the key of a parked capacity retry of a demand cycle is not absorbed as demand (race B)", async () => {
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
    expect(run).toHaveBeenCalledOnce();
    wake(["project-a"]);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY * 6);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(accepts()).toEqual([false]);
  });

  it("a discovery cycle that Native could not admit for capacity keeps discovery when the exact request is retried (RetryableDelivery.wakeEntries)", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "maintenance-delivery-capacity",
      })
      .mockResolvedValue(accepted());
    const { wake, accepts } = setup(run);
    await startedAndIdle();

    wake(["project-a"], "discovery");
    await vi.advanceTimersByTimeAsync(BACKLOG);
    expect(accepts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY * 2);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(accepts()).toEqual([false]);
  });

  it.each([
    ["no receipt (an adapter without the attempt lifecycle)", "none", false],
    ["an empty receipt", [], true],
    [
      "a receipt of the Graph Index build only",
      ["graph"],
      true,
    ],
    [
      "a receipt where the wake also advanced the durable chain (Verify succeeded)",
      ["verify"],
      false,
    ],
    [
      "a receipt whose only durable work failed (its re-pickup must not wait for the next wake)",
      ["failed-verify"],
      false,
    ],
    [
      "a receipt of the build and a Verify",
      ["graph", "verify"],
      false,
    ],
  ] as const)(
    "a wake-only demand cycle with %s is demand-only: %s",
    async (_name, receipt, expected) => {
      const run = vi.fn().mockResolvedValue(accepted());
      const named = (kinds: readonly string[]) =>
        kinds.map((kind) =>
          kind === "graph"
            ? GRAPH_BUILD_WORK
            : kind === "failed-verify"
              ? FAILED_VERIFY_WORK
              : VERIFY_WORK,
        );
      let accepts: () => boolean[];
      let wake: ReturnType<typeof setup>["wake"];
      if (receipt === "none") {
        const onCycleAccepted = vi.fn(
          (_cycle: NarrativeMaintenanceAcceptedCycle) => {},
        );
        const scheduler = createNarrativeMaintenanceScheduler(
          {
            getNarrativeMaintenanceWorkspaceBinding: () => BINDING,
            runNarrativeMaintenanceCycle: run,
          } as unknown as Parameters<
            typeof createNarrativeMaintenanceScheduler
          >[0],
          { warn: vi.fn(), onCycleAccepted },
        );
        schedulers.push(scheduler);
        scheduler.start();
        wake = (ids, origin) =>
          scheduler.requestGraphIndexBuildWakesWithBinding?.(
            ids,
            BINDING,
            origin,
          );
        accepts = () =>
          onCycleAccepted.mock.calls.map(([cycle]) => cycle.demandOnly);
      } else {
        const fixture = setup(run, { receiptWorks: named(receipt) });
        wake = fixture.wake;
        accepts = fixture.accepts;
      }
      await startedAndIdle();

      wake(["project-a"], "demand");
      await vi.advanceTimersByTimeAsync(BACKLOG);

      expect(run).toHaveBeenCalledOnce();
      expect(accepts()).toEqual([expected]);
    },
  );

  describe("a discovery wake is never demoted, and a demand wake never promoted, by a requeue", () => {
    const cases = [
      [
        "a preempted cycle",
        { status: "accepted", hasMore: false, preempted: true },
        { stopReason: "foreground-preempted" as const },
      ],
      ["a deferred adapter", { status: "deferred", hasMore: false }, {}],
      [
        "a workspace binding mismatch",
        {
          status: "workspace-unavailable",
          reason: "maintenance-workspace-binding-mismatch",
        },
        {},
      ],
      ["a not-admitted cycle", { status: "not-admitted" }, {}],
      [
        "a workspace-unavailable cycle",
        { status: "workspace-unavailable", reason: "maintenance-test" },
        {},
      ],
    ] as const;
    it.each(
      cases.flatMap(([name, first, extra]) =>
        (
          [
            ["discovery", false],
            ["demand", true],
          ] as const
        ).map(([origin, expected]) => [name, origin, expected, first, extra] as const),
      ),
    )(
      "%s requeues a %s wake under the same origin",
      async (_name, origin, expected, first, extra) => {
        const run = vi
          .fn()
          .mockResolvedValueOnce(first)
          .mockResolvedValue(accepted());
        const { wake, accepts } = setup(run, {
          interruptFirstAttempt: true,
          ...extra,
        });
        await startedAndIdle();

        wake(["project-a"], origin);
        await vi.advanceTimersByTimeAsync(BACKLOG);
        expect(run).toHaveBeenCalledOnce();
        // A deferred adapter or a binding mismatch parks the wake until the
        // next explicit request (a demand one, which must not change the
        // parked origin).
        if (
          first.status === "deferred" ||
          ("reason" in first &&
            first.reason === "maintenance-workspace-binding-mismatch")
        ) {
          wake(["project-a"], "demand");
        }
        await vi.advanceTimersByTimeAsync(120_000);

        expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(accepts().at(-1)).toBe(expected);
        expect(accepts().filter((flag) => flag !== expected)).toEqual([]);
      },
    );
  });

  describe("a rebind of a retained wake keeps its origin", () => {
    const W1 = { authorityId: "authority-w1", generation: 3 };
    const W2 = { authorityId: "authority-w1-reopened", generation: 9 };
    it.each([
      ["demand", true],
      ["discovery", false],
    ] as const)("a %s wake stays %s after Native's rebound proof", async (origin, expected) => {
      const reconcile = vi
        .fn()
        .mockResolvedValueOnce({
          status: "reconciled",
          descriptorId: 12,
          reason: "maintenance-recovery-complete",
          recoveredBinding: W1,
          activeBinding: W2,
          reboundBinding: W2,
        })
        .mockResolvedValue({ status: "none" });
      const run = vi.fn().mockResolvedValue(accepted());
      const { wake, accepts } = setup(run, {
        binding: W2,
        wakeBinding: W1,
        reconcile,
      });
      // Registered before the first timer, so Native's one proof is spent on
      // this wake's own cycle.
      wake(["project-a"], origin);
      await vi.advanceTimersByTimeAsync(INITIAL + BACKLOG + ERROR_RETRY * 2);

      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        wakeProjectIds: ["project-a"],
        workspaceBinding: W2,
      });
      expect(accepts()).toEqual([expected]);
    });
  });

  it.each([
    ["discovery", false],
    ["demand", true],
  ] as const)(
    "a %s wake keeps its origin through every retry, including the one after the retry budget when no failure receipt can be persisted",
    async (origin, expected) => {
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockRejectedValueOnce(new Error("transient"))
        .mockRejectedValueOnce(new Error("transient"))
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue(accepted());
      const { wake, accepts } = setup(run, { interruptAttempts: 4 });
      await startedAndIdle();

      wake(["project-a"], origin);
      await vi.advanceTimersByTimeAsync(600_000);

      expect(run.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(accepts()).toEqual([expected]);
    },
  );
});
