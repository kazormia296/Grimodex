import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error The product-journey harness is JavaScript without a declaration surface.
import { isMainProcessErrorMessage } from "../scripts/product-journey-harness.mjs";

import {
  canonicalNarrativeMaintenanceWorkKey,
  coalesceNarrativeMaintenanceWork,
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_MAX_RETRIES,
  scheduleNarrativeMaintenanceProcessInterruption,
  type NarrativeMaintenanceCycleResult,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceSchedulerOptions,
} from "./narrativeMaintenance.js";

const INITIAL_DELAY_MS = 250;
const IDLE_POLL_INTERVAL_MS = 1_000;
const BACKLOG_DELAY_MS = 10;
const ERROR_RETRY_DELAY_MS = 1_000;

function work(
  projectId: string,
  runKind: NarrativeMaintenanceRequest["runKind"],
  workKey: string,
  reason: string,
): NarrativeMaintenanceRequest {
  return { projectId, runKind, workKey, reason };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function acceptedCycle(hasMore = false): NarrativeMaintenanceCycleResult {
  return { status: "accepted", hasMore };
}

function acceptedFailureReceiptBackend() {
  return {
    recordNarrativeMaintenanceDeliveryFailure: vi.fn().mockResolvedValue({
      status: "accepted",
      receiptId: "delivery-failure-test",
    }),
  };
}

function renderedWarnings(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map((args) => args.map(String).join(" "));
}

function hasErrorClassWarning(warn: ReturnType<typeof vi.fn>): boolean {
  return renderedWarnings(warn).some(isMainProcessErrorMessage);
}

describe("narrative maintenance scheduler", () => {
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

  function createScheduler(
    backend: unknown,
    warn = vi.fn(),
    options: Omit<NarrativeMaintenanceSchedulerOptions, "warn"> = {},
  ) {
    const scheduler = createNarrativeMaintenanceScheduler(
      backend as Parameters<typeof createNarrativeMaintenanceScheduler>[0],
      { warn, ...options },
    );
    schedulers.push(scheduler);
    return { scheduler, warn };
  }

  it("schedules interruption exit only for an authorized exact live binding", async () => {
    const expectedBinding = { authorityId: "authority-1", generation: 7 };
    let currentBinding = expectedBinding;
    const ack: Parameters<
      typeof scheduleNarrativeMaintenanceProcessInterruption
    >[1] = {
      status: "ci-process-interruption-pending",
      fault: "process-interruption",
      runId: "run-1",
      authorityId: expectedBinding.authorityId,
      generation: expectedBinding.generation,
    };
    const scheduled: Array<() => void> = [];
    const exit = vi.fn();
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
    };

    await expect(
      scheduleNarrativeMaintenanceProcessInterruption(
        backend,
        ack,
        expectedBinding,
        () => false,
        (callback) => {
          scheduled.push(callback);
        },
        exit,
      ),
    ).resolves.toBe(false);
    expect(scheduled).toHaveLength(0);

    const invalidated = scheduleNarrativeMaintenanceProcessInterruption(
      backend,
      ack,
      expectedBinding,
      () => true,
      (callback) => {
        scheduled.push(callback);
      },
      exit,
    );
    expect(scheduled).toHaveLength(1);
    currentBinding = { authorityId: "rotated", generation: 8 };
    scheduled[0]?.();
    await expect(invalidated).resolves.toBe(false);
    expect(exit).not.toHaveBeenCalled();

    currentBinding = expectedBinding;
    const authorized = scheduleNarrativeMaintenanceProcessInterruption(
      backend,
      ack,
      expectedBinding,
      () => true,
      (callback) => {
        scheduled.push(callback);
      },
      exit,
    );
    expect(scheduled).toHaveLength(2);
    scheduled[1]?.();
    await expect(authorized).resolves.toBe(true);
    expect(exit).toHaveBeenCalledExactlyOnceWith(86);
  });

  it("keeps an interruption cycle in flight until the scheduled exit boundary", async () => {
    const binding = { authorityId: "authority-1", generation: 7 };
    const ack: NarrativeMaintenanceCycleResult = {
      status: "ci-process-interruption-pending",
      fault: "process-interruption",
      runId: "run-1",
      authorityId: binding.authorityId,
      generation: binding.generation,
    };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(ack)
      .mockResolvedValue(acceptedCycle());
    let exitBoundary: (() => void) | undefined;
    const exit = vi.fn();
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    };
    const { scheduler } = createScheduler(backend, vi.fn(), {
      onCiProcessInterruption: (cycleAck, expectedBinding) =>
        scheduleNarrativeMaintenanceProcessInterruption(
          backend,
          cycleAck,
          expectedBinding,
          () => true,
          (callback) => {
            exitBoundary = callback;
          },
          exit,
        ),
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(exitBoundary).toBeTypeOf("function");

    scheduler.request(
      work("project-1", "dependency-verify", "verify:v2", "freshness"),
    );
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    exitBoundary?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledExactlyOnceWith(86);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
  });

  it("rejects when timer-time authorization revalidation throws", async () => {
    const binding = { authorityId: "authority-1", generation: 7 };
    const ack: Parameters<
      typeof scheduleNarrativeMaintenanceProcessInterruption
    >[1] = {
      status: "ci-process-interruption-pending",
      fault: "process-interruption",
      runId: "run-1",
      authorityId: binding.authorityId,
      generation: binding.generation,
    };
    let exitBoundary: (() => void) | undefined;
    const isAuthorized = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("authorization reader failed");
      });

    const pending = scheduleNarrativeMaintenanceProcessInterruption(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
      },
      ack,
      binding,
      isAuthorized,
      (callback) => {
        exitBoundary = callback;
      },
      vi.fn(),
    );

    exitBoundary?.();
    await expect(pending).rejects.toThrow("authorization reader failed");
  });

  it.each([
    ["false", () => false],
    [
      "throw",
      () => {
        throw new Error("scheduler rejected");
      },
    ],
  ])(
    "retains a process-interruption batch for retry when the main owner returns %s",
    async (_label, onCiProcessInterruption) => {
      const binding = { authorityId: "authority-1", generation: 7 };
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce({
          status: "ci-process-interruption-pending",
          fault: "process-interruption",
          runId: "run-1",
          authorityId: binding.authorityId,
          generation: binding.generation,
        })
        .mockResolvedValue(acceptedCycle());
      const { scheduler } = createScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => binding,
          runNarrativeMaintenanceCycle,
        },
        vi.fn(),
        { onCiProcessInterruption },
      );

      scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    },
  );

  it("does not handle a terminal ACK when its binding cannot prove the durable Run", async () => {
    const binding = { authorityId: "authority-1", generation: 7 };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ci-terminal-fault-handled",
        fault: "contract-violation",
        runId: "run-1",
        authorityId: "forged-authority",
        generation: binding.generation,
      })
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("does not retry a terminal ACK whose exact binding is proven", async () => {
    const binding = { authorityId: "authority-1", generation: 7 };
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "ci-terminal-fault-handled",
      fault: "contract-violation",
      runId: "run-1",
      authorityId: binding.authorityId,
      generation: binding.generation,
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
  });

  it("canonical key includes project, run kind, and work key", () => {
    const backfill = work("project-1", "backfill", "same", "open");
    const verify = work("project-1", "dependency-verify", "same", "verify");
    const rebuildEpoch1 = {
      ...work("project-1", "semantic-index-rebuild", "same", "rebuild"),
      semanticEpochId: "epoch-1",
    };
    const rebuildEpoch2 = {
      ...rebuildEpoch1,
      semanticEpochId: "epoch-2",
    };
    expect(canonicalNarrativeMaintenanceWorkKey(backfill)).not.toBe(
      canonicalNarrativeMaintenanceWorkKey(verify),
    );
    expect(canonicalNarrativeMaintenanceWorkKey(rebuildEpoch1)).not.toBe(
      canonicalNarrativeMaintenanceWorkKey(rebuildEpoch2),
    );
  });

  it("rejects path separators and non-automatic run kinds at the runtime boundary", () => {
    expect(() =>
      canonicalNarrativeMaintenanceWorkKey(
        work("project/one", "backfill", "work", "open"),
      ),
    ).toThrow(/slash|separator|must not/i);

    const { scheduler } = createScheduler({
      runNarrativeMaintenanceCycle: vi.fn().mockResolvedValue(acceptedCycle()),
    });
    expect(() =>
      scheduler.request({
        projectId: "project-1",
        runKind: "dependency-repair" as NarrativeMaintenanceRequest["runKind"],
        workKey: "repair",
        reason: "must-never-run",
      }),
    ).toThrow(/runKind|automatic|Repair/i);
  });

  it("same project and kind/key coalesce reasons while different kinds remain distinct", () => {
    const entries = coalesceNarrativeMaintenanceWork([
      work("project-1", "backfill", "backfill:v2", "workspace-open"),
      work("project-1", "backfill", "backfill:v2", "retry"),
      work("project-1", "dependency-verify", "verify:epoch-1", "backfill-done"),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.reasons).toEqual(["workspace-open", "retry"]);
    expect(entries[1]?.reasons).toEqual(["backfill-done"]);

    const epochEntries = coalesceNarrativeMaintenanceWork([
      {
        ...work("project-1", "semantic-index-rebuild", "rebuild", "epoch-1"),
        semanticEpochId: "epoch-1",
      },
      {
        ...work("project-1", "semantic-index-rebuild", "rebuild", "epoch-2"),
        semanticEpochId: "epoch-2",
      },
    ]);
    expect(epochEntries).toHaveLength(2);
  });

  it("one in-flight main cycle serializes cross-kind work for a project", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({ runNarrativeMaintenanceCycle });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });

    scheduler.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "backfill-done"),
    );
    scheduler.request(
      work("project-1", "semantic-index-rebuild", "rebuild", "derived-invalid"),
    );
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    first.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["backfill-done"],
        },
        {
          projectId: "project-1",
          runKind: "semantic-index-rebuild",
          workKey: "rebuild",
          semanticEpochId: null,
          reasons: ["derived-invalid"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it("pending work is coalesced before the first cycle", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({ runNarrativeMaintenanceCycle });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.request(
      work("project-1", "backfill", "backfill:v2", "manual-retry"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open", "manual-retry"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it.each([
    ["legacy null", null],
    ["explicit unavailable status", { status: "workspace-unavailable" }],
  ])(
    "%s requeues the claimed batch until the backend accepts it",
    async (_label, unavailableResponse) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce(unavailableResponse)
        .mockResolvedValueOnce(acceptedCycle());
      const { scheduler, warn } = createScheduler({
        runNarrativeMaintenanceCycle,
      });
      const originalWork = work(
        "project-1",
        "backfill",
        "backfill:v2",
        "workspace-open",
      );

      scheduler.request(originalWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual(
        runNarrativeMaintenanceCycle.mock.calls[0]?.[0],
      );
    },
  );

  it("keeps an unavailable-workspace trigger beyond the bounded error budget", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "workspace-unavailable" });
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(
      work("project-1", "backfill", "backfill:v2", "workspace-open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (
      let retry = 0;
      retry < NARRATIVE_MAINTENANCE_MAX_RETRIES + 1;
      retry += 1
    ) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 2,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(false);
  });

  it("drains a null-binding enqueue fully once the workspace becomes available", async () => {
    // Regression: work enqueued while the binding getter returns null is
    // keyed under the "unavailable" scope. Delete/retry must recompute that
    // exact key from the queue item, or the original entry survives forever
    // and the retry re-sends a duplicate batch.
    let binding: { authorityId: string; generation: number } | null = null;
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({ status: "workspace-unavailable" })
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(
      work("project-1", "backfill", "backfill:v2", "workspace-open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(1);

    binding = { authorityId: "authority-1", generation: 1 };
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    // The retried batch carries the single original work item, not a
    // duplicate produced by a second differently-scoped queue entry.
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].work).toHaveLength(
      1,
    );

    // Acceptance drains the queue completely, including the original
    // unavailable-scoped entry: no further cycle fires.
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 3);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("retains a project-scoped durable wake when its workspace is unavailable", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(acceptedCycle(true))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(acceptedCycle());
    const { scheduler } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(
      work("project-1", "backfill", "backfill:v2", "workspace-open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[2]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });
  });

  it("hasMore keeps a durable backlog wake and invokes the next cycle with an empty batch", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(acceptedCycle(true))
      .mockResolvedValueOnce(acceptedCycle());
    const { scheduler } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });
  });

  it("coalesced with hasMore keeps a durable backlog wake so the work chain continues", async () => {
    // Coalesced is a no-double-dispatch ACK, not a work-chain-complete ACK:
    // when another Run owns the batch and native still reports backlog, a
    // follow-up wake must poll until the chain's next phase is discoverable.
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({ status: "coalesced", hasMore: true })
      .mockResolvedValueOnce(acceptedCycle());
    const { scheduler } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });
  });

  it("scopes an empty hasMore wake to its project and leaves another project independent", async () => {
    const p1Wake = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(acceptedCycle(true))
      .mockReturnValueOnce(p1Wake.promise)
      .mockResolvedValue(acceptedCycle());
    const backend = { runNarrativeMaintenanceCycle };
    const { scheduler: firstScheduler } = createScheduler(backend);
    const { scheduler: sameProjectScheduler } = createScheduler(backend);
    const { scheduler: otherProjectScheduler } = createScheduler(backend);

    firstScheduler.request(
      work("project-1", "backfill", "backfill:v2", "open"),
    );
    firstScheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });

    sameProjectScheduler.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "verify"),
    );
    sameProjectScheduler.start();
    otherProjectScheduler.request(
      work("project-2", "backfill", "backfill:v2", "open"),
    );
    otherProjectScheduler.start();

    // The same project is still claimed by the empty wake.  Its scheduler
    // waits for release instead of spinning a timer; project-2 can proceed.
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(3);
    expect(runNarrativeMaintenanceCycle.mock.calls[2]?.[0]).toEqual({
      work: [
        {
          projectId: "project-2",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });

    p1Wake.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(4);
    expect(runNarrativeMaintenanceCycle.mock.calls[3]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["verify"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it("cycle failure warns and retries only the pending work", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValueOnce(new Error("native unavailable"))
      .mockResolvedValue(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("renders only a canonical requeued transient failure as a bounded warning", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "NEX_MAINTENANCE_TRANSIENT: injected maintenance fault\nTypeError: unsafe detail",
        ),
      )
      .mockResolvedValue(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    const rendered = renderedWarnings(warn).join("\n");
    expect(rendered).toContain("NEX_MAINTENANCE_TRANSIENT");
    expect(rendered).toContain("1/3");
    expect(rendered).not.toContain("unsafe detail");
    expect(rendered.length).toBeLessThanOrEqual(256);
    expect(hasErrorClassWarning(warn)).toBe(false);

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("renders a graph-state-change verify failure as a bounded retry", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "NEX_VERIFY_GRAPH_STATE_CHANGED: graph state changed after Verify observed it; run Verify again",
        ),
      )
      .mockResolvedValue(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    const rendered = renderedWarnings(warn).join("\n");
    expect(rendered).toContain("NEX_MAINTENANCE_TRANSIENT");
    expect(rendered).toContain("1/3");
    expect(rendered).not.toContain("background cycle failed");
    expect(hasErrorClassWarning(warn)).toBe(false);

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("keeps malformed native responses error-class even when requeued", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({ status: "accepted", hasMore: "invalid" })
      .mockResolvedValue(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(hasErrorClassWarning(warn)).toBe(true);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("keeps a terminal ACK binding mismatch error-class even when requeued", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ci-terminal-fault-handled",
        fault: "contract-violation",
        runId: "run-1",
        authorityId: "forged-authority",
        generation: 7,
      })
      .mockResolvedValue(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => ({
        authorityId: "authority-1",
        generation: 7,
      }),
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(hasErrorClassWarning(warn)).toBe(true);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("keeps error-class diagnostics when a transient failure exhausts retries", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(
        new Error("NEX_MAINTENANCE_TRANSIENT: injected maintenance fault"),
      );
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
      ...acceptedFailureReceiptBackend(),
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    const rendered = renderedWarnings(warn).join("\n");
    expect(rendered).toMatch(/retry exhausted/i);
    expect(rendered).toMatch(/\b(?:error|errors|failed|failure)\b/i);
  });

  it("malformed native cycle JSON is retried instead of being treated as a successful drain", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce("{not-json")
      .mockResolvedValueOnce(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it.each([
    "{}",
    "[]",
    "0",
    '"ok"',
    "null",
    '{"hasMore":1}',
    '{"other":false}',
  ])(
    "retries valid JSON with an invalid cycle shape (%s)",
    async (malformedResponse) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce(malformedResponse)
        .mockResolvedValueOnce(acceptedCycle());
      const { scheduler, warn } = createScheduler({
        runNarrativeMaintenanceCycle,
      });

      scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
        work: [
          {
            projectId: "project-1",
            runKind: "backfill",
            workKey: "backfill:v2",
            semanticEpochId: null,
            reasons: ["open"],
          },
        ],
        wakeProjectIds: [],
      });
    },
  );

  it.each([
    ["object", { hasMore: false }],
    ["JSON string", '{"hasMore":false}'],
  ])(
    "retries status-less hasMore response (%s) instead of ACKing it",
    async (_label, malformedResponse) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce(malformedResponse)
        .mockResolvedValueOnce(acceptedCycle());
      const { scheduler, warn } = createScheduler({
        runNarrativeMaintenanceCycle,
      });

      scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds retries for valid JSON with an invalid cycle shape", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue("{}");
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
      ...acceptedFailureReceiptBackend(),
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(true);
  });

  it("bounds retries for malformed native responses before declaring exhaustion", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue("{not-json");
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
      ...acceptedFailureReceiptBackend(),
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
  });

  it("bounds retries to three per canonical key and stops after exhaustion", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(new Error("database is locked"));
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
      ...acceptedFailureReceiptBackend(),
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
  });

  it("retains the trigger when Native has not accepted the failure receipt", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(new Error("database is locked"));
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (
      let retry = 0;
      retry <= NARRATIVE_MAINTENANCE_MAX_RETRIES;
      retry += 1
    ) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 2,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).includes("Native failure receipt API is unavailable"),
      ),
    ).toBe(true);
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(false);
  });

  it("retains the exact trigger when Native rejects its stale failure-receipt binding", async () => {
    const binding = { authorityId: "authority-live", generation: 9 };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(new Error("database is locked"));
    const recordNarrativeMaintenanceDeliveryFailure = vi
      .fn()
      .mockResolvedValue({ status: "workspace-binding-mismatch" });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      recordNarrativeMaintenanceDeliveryFailure,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(recordNarrativeMaintenanceDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        workspaceBinding: binding,
      }),
    );
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 2,
    );
  });

  it.each([
    ["backendがnull", null],
    ["future bindingにmethodがない", {}],
  ])("%s場合はfail-softで停止する", async (_label, backend) => {
    const { scheduler, warn } = createScheduler(backend);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + IDLE_POLL_INTERVAL_MS);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("disposeはin-flight完了後の再scheduleを抑止する", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi.fn().mockReturnValue(first.promise);
    const { scheduler } = createScheduler({ runNarrativeMaintenanceCycle });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    scheduler.dispose();
    first.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
  });

  it("複数schedulerで同一projectを共有single-flightし、dispose後に解放する", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(acceptedCycle());
    const backend = { runNarrativeMaintenanceCycle };
    const { scheduler: firstScheduler } = createScheduler(backend);
    const { scheduler: secondScheduler } = createScheduler(backend);

    firstScheduler.request(
      work("project-1", "backfill", "backfill:v2", "open"),
    );
    secondScheduler.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "backfill-done"),
    );
    firstScheduler.start();
    secondScheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    firstScheduler.dispose();
    first.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["backfill-done"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it("partial claim rechecks a project released before blocked-wait registration", async () => {
    const firstProject = deferred<NarrativeMaintenanceCycleResult>();
    const partialClaim = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockReturnValueOnce(firstProject.promise)
      .mockReturnValueOnce(partialClaim.promise)
      .mockResolvedValue(acceptedCycle());
    const backend = { runNarrativeMaintenanceCycle };
    const { scheduler: owner } = createScheduler(backend);
    const { scheduler: partial } = createScheduler(backend);

    owner.request(work("project-1", "backfill", "backfill:v2", "open"));
    owner.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    partial.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "verify"),
    );
    partial.request(work("project-2", "backfill", "backfill:v2", "open"));
    partial.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-2",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });

    // Release project-1 before the partial scheduler reaches its finally
    // block.  Its subsequent wait registration must notice that the project
    // is already free and schedule the pending verify work.
    firstProject.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    partialClaim.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(3);
    expect(runNarrativeMaintenanceCycle.mock.calls[2]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["verify"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it("linearizes begin registration before dispose cancellation", async () => {
    const binding = { authorityId: "authority-attempt", generation: 11 };
    const begin = deferred<string>();
    let begunAttemptId: string | undefined;
    const cancel = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "closed",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const runNarrativeMaintenanceCycle = vi.fn();
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: vi.fn((attemptId: string) => {
        begunAttemptId = attemptId;
        return begin.promise;
      }),
      cancelNarrativeMaintenanceAttempt: cancel,
      runNarrativeMaintenanceCycle,
    };
    const { scheduler } = createScheduler(backend);
    scheduler.request(work("project-attempt", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    const disposing = scheduler.dispose();
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();

    // Native ownership is established only by the exact begin binding ack.
    // The deferred response also exercises the begin-vs-dispose linearization.
    begin.resolve(
      JSON.stringify({
        status: "open",
        attemptId: begunAttemptId,
        authorityId: binding.authorityId,
        generation: binding.generation,
      }),
    );
    await expect(disposing).resolves.toBeUndefined();
    expect(cancel.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(cancel.mock.calls[0]?.[0]).toEqual(expect.any(String));
    expect(cancel.mock.calls[0]?.[0]).not.toBe("UNKNOWN");
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
  });

  it("waits for the exact pending begin before a direct cancel reaches Native", async () => {
    const binding = { authorityId: "authority-direct-cancel", generation: 14 };
    const begin = deferred<string>();
    const cancel = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "closed",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const backend = {
      beginNarrativeMaintenanceAttempt: vi.fn(() => begin.promise),
      cancelNarrativeMaintenanceAttempt: cancel,
    };
    const { scheduler } = createScheduler(backend);
    const beginRequest = scheduler.beginNarrativeMaintenanceAttempt?.(
      "attempt-direct-cancel",
      binding,
    );
    const cancellation = scheduler.cancelNarrativeMaintenanceAttempt?.(
      "attempt-direct-cancel",
      "closed",
    );
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();

    begin.resolve(
      JSON.stringify({
        status: "open",
        attemptId: "attempt-direct-cancel",
        authorityId: binding.authorityId,
        generation: binding.generation,
      }),
    );
    await expect(beginRequest).resolves.toBeUndefined();
    await expect(cancellation).resolves.toMatchObject({
      attemptId: "attempt-direct-cancel",
      state: "interrupted",
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      "attempt-direct-cancel",
      "closed",
    );
  });

  it("resumes retained backlog only through the newest quiesce lease", async () => {
    const binding = { authorityId: "authority-resume", generation: 15 };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(acceptedCycle());
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    };
    const { scheduler } = createScheduler(backend);
    scheduler.request(
      work("project-resume", "backfill", "backfill:v2", "open"),
    );
    scheduler.start();

    const firstLease = await scheduler.quiesceForWorkspaceSwitch?.();
    const secondLease = await scheduler.quiesceForWorkspaceSwitch?.();
    expect(scheduler.getQuiescenceState?.().queueIdle).toBe(false);
    firstLease?.resume();
    expect(scheduler.getQuiescenceState?.().timerScheduled).toBe(false);
    secondLease?.resume();
    expect(scheduler.getQuiescenceState?.().timerScheduled).toBe(true);

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
  });

  it("keeps an empty Native durable wake Native-owned", async () => {
    const binding = { authorityId: "authority-empty-wake", generation: 13 };
    let cycleCount = 0;
    const begin = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const runNarrativeMaintenanceCycle = vi.fn((_payload) => {
      cycleCount += 1;
      return Promise.resolve(
        JSON.stringify({ status: "accepted", hasMore: cycleCount === 1 }),
      );
    });
    const cancel = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "succeeded",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: binding.generation,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: begin,
      cancelNarrativeMaintenanceAttempt: cancel,
      runNarrativeMaintenanceCycle,
    };
    const { scheduler } = createScheduler(backend);
    scheduler.request(work("project-empty-wake", "backfill", "wake", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toMatchObject({
      work: [],
      wakeProjectIds: ["project-empty-wake"],
      workspaceBinding: binding,
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(scheduler.getQuiescenceState?.().inFlight).toBe(false);
  });

  it("retains the Native attempt when cleanup is not reusable", async () => {
    const binding = { authorityId: "authority-unusable", generation: 12 };
    const failedReceipt = (attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "closed",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "failed", error: "rollback failed" },
        connectionReusable: false,
      });
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ status: "accepted", hasMore: false }));
    const cleanReceipt = (attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "closed",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    const cancel = vi
      .fn()
      .mockImplementationOnce(failedReceipt)
      .mockImplementationOnce(failedReceipt)
      .mockImplementationOnce(failedReceipt)
      .mockImplementation(cleanReceipt);
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: vi
        .fn()
        .mockImplementation((attemptId: string, receivedBinding) =>
          JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          }),
        ),
      cancelNarrativeMaintenanceAttempt: cancel,
      runNarrativeMaintenanceCycle,
    };
    const { scheduler } = createScheduler(backend);
    scheduler.request(work("project-unusable", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.runAllTimersAsync();
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(scheduler.getQuiescenceState?.().inFlight).toBe(false);
    await expect(scheduler.dispose()).rejects.toThrow(/CONNECTION_UNUSABLE|rollback failed/i);
    expect(cancel.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
