import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error The product-journey harness is JavaScript without a declaration surface.
import { isMainProcessErrorMessage } from "../scripts/product-journey-harness.mjs";

import {
  canonicalNarrativeMaintenanceWorkKey,
  coalesceNarrativeMaintenanceWork,
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_MAX_RETRIES,
  scheduleNarrativeMaintenanceProcessInterruption,
  type NarrativeMaintenanceCycleRequest,
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  afterEach(async () => {
    for (const scheduler of schedulers.splice(0)) {
      try {
        await scheduler.dispose();
      } catch {
        // A failed cleanup receipt intentionally keeps the scheduler fail-closed.
      }
    }
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

  it("does not warn for an authorized process interruption terminal receipt", async () => {
    const binding = { authorityId: "authority-process-interruption", generation: 4 };
    const workItem = work(
      "project-process-interruption",
      "backfill",
      "backfill:v2",
      "open",
    );
    const canonicalWorkKey = canonicalNarrativeMaintenanceWorkKey(workItem);
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "ci-process-interruption-pending",
      fault: "process-interruption",
      runId: "run-process-interruption",
      authorityId: binding.authorityId,
      generation: binding.generation,
    });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [{ workKey: canonicalWorkKey, status: "interrupted" }],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const { scheduler, warn } = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
      },
      vi.fn(),
      { onCiProcessInterruption: () => true },
    );

    scheduler.request(workItem);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    expect(
      renderedWarnings(warn).some((message) =>
        message.includes("background cycle failed"),
      ),
    ).toBe(false);
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

  it("does not retry a lifecycle terminal ACK whose exact binding is proven", async () => {
    const binding = { authorityId: "authority-1", generation: 7 };
    const canonicalWorkKey =
      "narrative-maintenance:v1/backfill/project-1/backfill:v2";
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [
          {
            workKey: canonicalWorkKey,
            status: "failed",
            error: "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
          },
        ],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
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
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
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
    [
      "explicit not-admitted status",
      { status: "not-admitted", reason: "active-operation", stateRevision: 7 },
    ],
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

  it("does not replay a Verify reported complete by an interrupted post-cycle receipt", async () => {
    const binding = { authorityId: "authority-replay", generation: 4 };
    const verifyWork = {
      ...work(
        "project-maintenance-replay",
        "dependency-verify",
        "verify:epoch-replay",
        "verify-requested",
      ),
      semanticEpochId: "epoch-replay",
    };
    const workKey = canonicalNarrativeMaintenanceWorkKey(verifyWork);

    const runCase = async (
      reason: string,
      workStatus: "succeeded" | "not-started",
    ) => {
      const firstCycleStarted = deferred<NarrativeMaintenanceCycleRequest>();
      const firstCycleResult = deferred<NarrativeMaintenanceCycleResult>();
      const firstCancellation = deferred<string>();
      const firstReceipt = deferred<string>();
      const firstCycleSettled = deferred<void>();
      const retryCycleSettled = deferred<void>();
      const retryRequests: NarrativeMaintenanceCycleRequest[] = [];
      let firstAttemptId: string | null = null;
      let cycleCalls = 0;

      const receipt = (
        attemptId: string,
        state: "interrupted" | "succeeded",
        status: "succeeded" | "not-started",
      ) =>
        JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state,
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: state === "succeeded" ? binding.generation : null,
          works: [{ workKey, status }],
          cleanup: { status: "clean" },
          connectionReusable: true,
        });

      const runNarrativeMaintenanceCycle = vi.fn(
        (request: NarrativeMaintenanceCycleRequest) => {
          cycleCalls += 1;
          if (cycleCalls === 1) {
            firstCycleStarted.resolve(request);
            return firstCycleResult.promise;
          }
          retryRequests.push(request);
          return Promise.resolve(acceptedCycle());
        },
      );
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) => {
          firstAttemptId ??= attemptId;
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
        if (attemptId === firstAttemptId) {
          firstCancellation.resolve(attemptId);
          return firstReceipt.promise;
        }
        return Promise.resolve(receipt(attemptId, "succeeded", "succeeded"));
      });
      const { scheduler } = createScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => binding,
          runNarrativeMaintenanceCycle,
          beginNarrativeMaintenanceAttempt,
          cancelNarrativeMaintenanceAttempt,
        },
        vi.fn(),
        {
          onCycleSettled: ({ cycleGeneration }) => {
            if (cycleGeneration === 1) firstCycleSettled.resolve();
            if (cycleGeneration === 2) retryCycleSettled.resolve();
          },
        },
      );

      let cycleReleased = false;
      let receiptReleased = false;
      try {
        scheduler.request(verifyWork);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
        const firstRequest = await firstCycleStarted.promise;

        // Model Rust's late post-cycle workspace check: the Verify work is
        // complete, but dropping its not-yet-success-finalized guard yields an
        // interrupted attempt receipt with per-work success and clean cleanup.
        firstCycleResult.resolve({ status: "workspace-unavailable", reason });
        cycleReleased = true;
        const cancelledAttemptId = await firstCancellation.promise;
        firstReceipt.resolve(
          receipt(cancelledAttemptId, "interrupted", workStatus),
        );
        receiptReleased = true;
        await firstCycleSettled.promise;

        await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
        if (retryRequests.length > 0) await retryCycleSettled.promise;
        return { firstRequest, retryRequests };
      } finally {
        if (!cycleReleased) {
          firstCycleResult.resolve({ status: "workspace-unavailable", reason });
        }
        if (!receiptReleased) {
          firstReceipt.resolve(
            receipt(
              firstAttemptId ?? "maintenance-replay-test-attempt",
              "interrupted",
              workStatus,
            ),
          );
        }
        await scheduler.dispose();
      }
    };

    const postCycleLoss = await runCase(
      "maintenance-workspace-changed-during-cycle",
      "succeeded",
    );
    const preExecutionLoss = await runCase(
      "lifecycle-no-workspace",
      "not-started",
    );

    expect(postCycleLoss.firstRequest.work).toEqual([
      expect.objectContaining({
        projectId: verifyWork.projectId,
        runKind: verifyWork.runKind,
        workKey: verifyWork.workKey,
        semanticEpochId: verifyWork.semanticEpochId,
      }),
    ]);
    expect(preExecutionLoss.retryRequests.map((request) => request.work)).toEqual(
      [preExecutionLoss.firstRequest.work],
    );
    expect(postCycleLoss.retryRequests.map((request) => request.work)).toEqual(
      [],
    );
  });

  it("retries only unfinished work covered by a complete post-cycle receipt", async () => {
    const binding = { authorityId: "authority-mixed-replay", generation: 5 };
    const completedWork = work(
      "project-mixed-replay",
      "backfill",
      "backfill:v2",
      "opened",
    );
    const interruptedWork = work(
      "project-mixed-replay",
      "dependency-verify",
      "verify:v2",
      "verify-requested",
    );
    const completedKey = canonicalNarrativeMaintenanceWorkKey(completedWork);
    const interruptedKey = canonicalNarrativeMaintenanceWorkKey(interruptedWork);
    let firstAttemptId: string | null = null;
    let cycleCount = 0;
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        requests.push(request);
        cycleCount += 1;
        return Promise.resolve(
          cycleCount === 1
            ? {
                status: "workspace-unavailable" as const,
                reason: "maintenance-workspace-changed-during-cycle",
              }
            : acceptedCycle(),
        );
      },
    );
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) => {
        firstAttemptId ??= attemptId;
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const isFirstAttempt = attemptId === firstAttemptId;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: isFirstAttempt ? "interrupted" : "succeeded",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: isFirstAttempt ? null : binding.generation,
        works: isFirstAttempt
          ? [
              { workKey: completedKey, status: "succeeded" },
              { workKey: interruptedKey, status: "interrupted" },
            ]
          : [{ workKey: interruptedKey, status: "succeeded" }],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(completedWork);
    scheduler.request(interruptedWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.work).toHaveLength(2);
    expect(requests[1]?.work.map(canonicalNarrativeMaintenanceWorkKey)).toEqual([
      interruptedKey,
    ]);
  });

  it("handles repeated Verify executions as distinct receipt rows and rediscovery trigger", async () => {
    const binding = { authorityId: "authority-repeated-work", generation: 10 };
    const replacementBinding = {
      authorityId: "authority-repeated-work-replacement",
      generation: 11,
    };
    let currentBinding = binding;
    const verifyWork = work(
      "project-repeated-work",
      "dependency-verify",
      "verify:epoch-repeated",
      "verify-requested",
    );
    const rebuildWork = work(
      "project-repeated-work",
      "semantic-index-rebuild",
      "rebuild:epoch-repeated",
      "verify-followup",
    );
    const verifyKey = canonicalNarrativeMaintenanceWorkKey(verifyWork);
    const rebuildKey = canonicalNarrativeMaintenanceWorkKey(rebuildWork);

    const runCase = async (
      lastVerifyStatus: "succeeded" | "interrupted" | "not-started",
    ) => {
      currentBinding = binding;
      let firstAttemptId: string | null = null;
      const requests: NarrativeMaintenanceCycleRequest[] = [];
      const rediscover = vi.fn();
      const runNarrativeMaintenanceCycle = vi.fn(
        (request: NarrativeMaintenanceCycleRequest) => {
          requests.push(request);
          if (requests.length === 1) {
            currentBinding = replacementBinding;
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: "maintenance-workspace-changed-during-cycle",
            });
          }
          return Promise.resolve(acceptedCycle());
        },
      );
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) => {
          firstAttemptId ??= attemptId;
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
        const isFirstAttempt = attemptId === firstAttemptId;
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: isFirstAttempt ? "interrupted" : "succeeded",
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: isFirstAttempt ? null : binding.generation,
          works: isFirstAttempt
            ? [
                { workKey: verifyKey, status: "succeeded" },
                { workKey: rebuildKey, status: "succeeded" },
                { workKey: verifyKey, status: lastVerifyStatus },
              ]
            : (requests[1]?.work ?? []).map((item) => ({
                workKey: canonicalNarrativeMaintenanceWorkKey(item),
                status: "succeeded",
              })),
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      });
      const scheduler = createScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
          runNarrativeMaintenanceCycle,
          beginNarrativeMaintenanceAttempt,
          cancelNarrativeMaintenanceAttempt,
          ackNarrativeMaintenanceDelivery: vi.fn().mockResolvedValue({
            status: "retired",
          }),
        },
        vi.fn(),
        { onWorkspaceBindingMismatch: rediscover },
      ).scheduler;

      scheduler.request(verifyWork);
      scheduler.request(rebuildWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      await scheduler.dispose();
      return { requests, rediscover };
    };

    const allSucceeded = await runCase("succeeded");
    const interruptedFollowup = await runCase("interrupted");
    const notStartedFollowup = await runCase("not-started");

    expect(allSucceeded.requests).toHaveLength(1);
    expect(allSucceeded.rediscover).toHaveBeenCalledOnce();
    for (const unfinished of [interruptedFollowup, notStartedFollowup]) {
      expect(unfinished.requests).toHaveLength(2);
      expect(unfinished.requests[1]?.workspaceBinding).toEqual(binding);
      expect(
        unfinished.requests[1]?.work.map(
          canonicalNarrativeMaintenanceWorkKey,
        ),
      ).toEqual([verifyKey]);
      expect(unfinished.rediscover).toHaveBeenCalledOnce();
    }
  });

  it.each(["incomplete", "cross-binding", "malformed"] as const)(
    "parks a post-cycle %s receipt without replaying the batch",
    async (receiptFault) => {
      const binding = { authorityId: "authority-unresolved", generation: 6 };
      const otherBinding = { authorityId: "authority-other", generation: 6 };
      const firstWork = work(
        "project-unresolved",
        "backfill",
        "backfill:v2",
        "opened",
      );
      const secondWork = work(
        "project-unresolved",
        "dependency-verify",
        "verify:v2",
        "verify-requested",
      );
      const firstKey = canonicalNarrativeMaintenanceWorkKey(firstWork);
      const secondKey = canonicalNarrativeMaintenanceWorkKey(secondWork);
      let attemptId: string | null = null;
      const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
        status: "workspace-unavailable",
        reason: "maintenance-workspace-changed-during-cycle",
      });
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (receivedAttemptId: string, receivedBinding: typeof binding) => {
          attemptId = receivedAttemptId;
          return JSON.stringify({
            status: "open",
            attemptId: receivedAttemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn(
        (receivedAttemptId: string) =>
          receiptFault === "malformed"
            ? "not-json"
            : JSON.stringify({
                schemaVersion: 1,
                attemptId: receivedAttemptId,
                state: "interrupted",
                stopReason: null,
                generation: binding.generation,
                workspaceBinding:
                  receiptFault === "cross-binding" ? otherBinding : binding,
                publishedGeneration: null,
                works:
                  receiptFault === "incomplete"
                    ? [{ workKey: firstKey, status: "succeeded" }]
                    : [
                        { workKey: firstKey, status: "succeeded" },
                        { workKey: secondKey, status: "interrupted" },
                      ],
                cleanup: { status: "clean" },
                connectionReusable: true,
              }),
      );
      const ackNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
        status: "retired",
      });
      const onWorkspaceBindingMismatch = vi.fn();
      const { scheduler } = createScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => binding,
          runNarrativeMaintenanceCycle,
          beginNarrativeMaintenanceAttempt,
          cancelNarrativeMaintenanceAttempt,
          ackNarrativeMaintenanceDelivery,
        },
        vi.fn(),
        { onWorkspaceBindingMismatch },
      );

      scheduler.request(firstWork);
      scheduler.request(secondWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

      expect(attemptId).toBeTypeOf("string");
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();
      expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
      await expect(scheduler.dispose()).rejects.toThrow();
    },
  );

  it("keeps a clean incomplete receipt parked when quiescence adopts it before invalidation", async () => {
    const originalBinding = { authorityId: "authority-quiesce-receipt", generation: 11 };
    let binding = originalBinding;
    const firstWork = work(
      "project-quiesce-receipt",
      "backfill",
      "backfill:v2",
      "opened",
    );
    const secondWork = work(
      "project-quiesce-receipt",
      "dependency-verify",
      "verify:v2",
      "verify-requested",
    );
    const firstKey = canonicalNarrativeMaintenanceWorkKey(firstWork);
    const cycleResult = deferred<NarrativeMaintenanceCycleResult>();
    const cycleStarted = deferred<void>();
    let attemptId: string | null = null;
    const runNarrativeMaintenanceCycle = vi.fn(() => {
      cycleStarted.resolve();
      return cycleResult.promise;
    });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (receivedAttemptId: string, receivedBinding: typeof originalBinding) => {
        attemptId = receivedAttemptId;
        return JSON.stringify({
          status: "open",
          attemptId: receivedAttemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn(
      (receivedAttemptId: string) =>
        JSON.stringify({
          schemaVersion: 1,
          attemptId: receivedAttemptId,
          state: "interrupted",
          stopReason: null,
          generation: originalBinding.generation,
          workspaceBinding: originalBinding,
          publishedGeneration: null,
          works: [{ workKey: firstKey, status: "succeeded" }],
          cleanup: { status: "clean" },
          connectionReusable: true,
        }),
    );
    const ackNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
      status: "retired",
    });
    const onWorkspaceBindingMismatch = vi.fn();
    const { scheduler } = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        ackNarrativeMaintenanceDelivery,
      },
      vi.fn(),
      { onWorkspaceBindingMismatch },
    );

    scheduler.request(firstWork);
    scheduler.request(secondWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await cycleStarted.promise;

    const quiescence = scheduler.quiesceForWorkspaceSwitch?.();
    await Promise.resolve();
    const adopted = await scheduler.cancelNarrativeMaintenanceAttempt?.(
      attemptId!,
      "closed",
    );
    expect(adopted).toMatchObject({ state: "interrupted" });

    cycleResult.resolve({
      status: "workspace-unavailable",
      reason: "maintenance-workspace-changed-during-cycle",
    });
    const lease = await quiescence;

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
    binding = { authorityId: "authority-quiesce-replacement", generation: 12 };
    lease?.resume(true);
    await expect(scheduler.dispose()).rejects.toThrow(
      /TERMINAL_RECEIPT_UNRESOLVED/,
    );
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
  });

  it("retires a parked delivery only after later exact terminal proof", async () => {
    const binding = { authorityId: "authority-late-terminal", generation: 13 };
    const firstWork = work(
      "project-late-terminal",
      "backfill",
      "backfill:v2",
      "opened",
    );
    const secondWork = work(
      "project-late-terminal",
      "dependency-verify",
      "verify:v2",
      "verify-requested",
    );
    const firstKey = canonicalNarrativeMaintenanceWorkKey(firstWork);
    const secondKey = canonicalNarrativeMaintenanceWorkKey(secondWork);
    const cycleSettled = deferred<void>();
    const firstCancelStarted = deferred<void>();
    const firstCancelResponse = deferred<string>();
    const secondCycleSettled = deferred<void>();
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1
            ? {
                status: "workspace-unavailable" as const,
                reason: "maintenance-workspace-changed-during-cycle",
              }
            : acceptedCycle(),
        );
      },
    );
    let firstAttemptId: string | null = null;
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) => {
        firstAttemptId ??= attemptId;
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        });
      },
    );
    const terminalReceipt = (
      attemptId: string,
      state: "interrupted" | "succeeded",
      works: Array<{ workKey: string; status: "succeeded" | "not-started" }>,
    ) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state,
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: state === "succeeded" ? binding.generation : null,
        works,
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      if (
        attemptId === firstAttemptId &&
        cancelNarrativeMaintenanceAttempt.mock.calls.length === 1
      ) {
        firstCancelStarted.resolve();
        return firstCancelResponse.promise;
      }
      return attemptId === firstAttemptId
        ? terminalReceipt(attemptId, "interrupted", [
            { workKey: firstKey, status: "succeeded" },
            { workKey: secondKey, status: "not-started" },
          ])
        : terminalReceipt(attemptId, "succeeded", [
            { workKey: secondKey, status: "succeeded" },
          ]);
    });
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "retired" });
    const { scheduler } = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        ackNarrativeMaintenanceDelivery,
      },
      vi.fn(),
      {
        onCycleSettled: ({ cycleGeneration }) => {
          if (cycleGeneration === 1) cycleSettled.resolve();
          if (cycleGeneration === 2) secondCycleSettled.resolve();
        },
      },
    );

    scheduler.request(firstWork);
    scheduler.request(secondWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await firstCancelStarted.promise;

    // The new occurrence arrives after A left the queue but before its failed
    // receipt has created the completion owner.
    scheduler.request(firstWork);
    scheduler.request(firstWork);
    firstCancelResponse.resolve("not-json");
    await cycleSettled.promise;
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();

    const lease = await scheduler.quiesceForWorkspaceSwitch?.();

    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    lease?.resume(true);
    expect(scheduler.getQuiescenceState?.().queueIdle).toBe(false);
    await vi.advanceTimersByTimeAsync(
      ERROR_RETRY_DELAY_MS + BACKLOG_DELAY_MS,
    );
    await secondCycleSettled.promise;
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(requests[1]?.work.map(canonicalNarrativeMaintenanceWorkKey)).toEqual([
      secondKey,
      firstKey,
    ]);
    expect(
      requests[1]?.work.filter(
        (item) => canonicalNarrativeMaintenanceWorkKey(item) === firstKey,
      ),
    ).toHaveLength(1);
    await expect(scheduler.dispose()).resolves.toBeUndefined();
    expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual([
      [1],
      [1],
      [2],
    ]);
  });

  it.each(["same-binding", "replacement-binding"] as const)(
    "does not let unrelated manual attempt B resolve parked attempt A (%s)",
    async (bindingCase) => {
      const originalBinding = {
        authorityId: "authority-parked-attempt-a",
        generation: 15,
      };
      const replacementBinding = {
        authorityId: "authority-manual-attempt-b",
        generation: 16,
      };
      let currentBinding: typeof originalBinding = originalBinding;
      const parkedWork = work(
        "project-parked-attempt-a",
        "backfill",
        "backfill:v2",
        "opened",
      );
      const parkedKey = canonicalNarrativeMaintenanceWorkKey(parkedWork);
      const cycleSettled = deferred<void>();
      let parkedAttemptId: string | null = null;
      const attemptBindings = new Map<string, typeof originalBinding>();
      const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
        status: "workspace-unavailable",
        reason: "maintenance-workspace-changed-during-cycle",
      });
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, binding: typeof originalBinding) => {
          parkedAttemptId ??= attemptId;
          attemptBindings.set(attemptId, binding);
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: binding.authorityId,
            generation: binding.generation,
          });
        },
      );
      const terminalReceipt = (
        attemptId: string,
        binding: typeof originalBinding,
        state: "interrupted" | "succeeded",
        works: Array<{ workKey: string; status: "succeeded" | "not-started" }>,
      ) =>
        JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state,
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: state === "succeeded" ? binding.generation : null,
          works,
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
        attemptId === parkedAttemptId &&
        cancelNarrativeMaintenanceAttempt.mock.calls.length === 1
          ? terminalReceipt(attemptId, originalBinding, "interrupted", [])
          : attemptId === parkedAttemptId
            ? terminalReceipt(attemptId, originalBinding, "interrupted", [
                { workKey: parkedKey, status: "succeeded" },
              ])
            : terminalReceipt(
                attemptId,
                attemptBindings.get(attemptId)!,
                "succeeded",
                [{ workKey: parkedKey, status: "succeeded" }],
              ),
      );
      const ackNarrativeMaintenanceDelivery = vi
        .fn()
        .mockResolvedValue({ status: "retired" });
      const { scheduler } = createScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
          runNarrativeMaintenanceCycle,
          beginNarrativeMaintenanceAttempt,
          cancelNarrativeMaintenanceAttempt,
          ackNarrativeMaintenanceDelivery,
        },
        vi.fn(),
        {
          onCycleSettled: ({ cycleGeneration }) => {
            if (cycleGeneration === 1) cycleSettled.resolve();
          },
        },
      );

      scheduler.request(parkedWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      await cycleSettled.promise;
      expect(parkedAttemptId).toEqual(expect.any(String));

      scheduler.request(parkedWork);
      const manualBinding =
        bindingCase === "same-binding"
          ? originalBinding
          : replacementBinding;
      currentBinding = manualBinding;
      await scheduler.beginNarrativeMaintenanceAttempt?.(
        "manual-attempt-b",
        manualBinding,
      );
      await expect(
        scheduler.cancelNarrativeMaintenanceAttempt?.(
          "manual-attempt-b",
          "closed",
        ),
      ).resolves.toMatchObject({
        attemptId: "manual-attempt-b",
        state: "succeeded",
      });

      expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
      await expect(scheduler.dispose()).rejects.toThrow(
        /TERMINAL_RECEIPT_UNRESOLVED/,
      );
    },
  );

  it("retires an unavailable delivery after a clean Native terminal receipt", async () => {
    const binding = { authorityId: "authority-unavailable", generation: 2 };
    const workItem = work(
      "project-unavailable",
      "backfill",
      "backfill:v2",
      "workspace-open",
    );
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "workspace-unavailable",
    });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [
          {
            workKey: canonicalNarrativeMaintenanceWorkKey(workItem),
            status: "not-started",
          },
        ],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const ackNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
      status: "retired",
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      ackNarrativeMaintenanceDelivery,
    });

    scheduler.request(workItem);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);
  });

  it.each(["pending", "rejected"] as const)(
    "does not replay a proven exact result while its Native ACK is %s",
    async (firstAckOutcome) => {
      const binding = {
        authorityId: "authority-proven-ack-pending",
        generation: 14,
      };
      const workItem = work(
        "project-proven-ack-pending",
        "backfill",
        "backfill:v2",
        "opened",
      );
      const workKey = canonicalNarrativeMaintenanceWorkKey(workItem);
      const cycleRequests: NarrativeMaintenanceCycleRequest[] = [];
      const replayedResult = {
        status: "workspace-unavailable" as const,
        reason: "lifecycle-no-workspace",
      };
      const runNarrativeMaintenanceCycle = vi.fn(
        (request: NarrativeMaintenanceCycleRequest) => {
          cycleRequests.push(request);
          return Promise.resolve(replayedResult);
        },
      );
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) =>
          JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          }),
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
        JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: "interrupted",
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: null,
          works: [{ workKey, status: "succeeded" }],
          cleanup: { status: "clean" },
          connectionReusable: true,
        }),
      );
      const resolveNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
        OutOfOrder: { expected: 2, received: 1 },
      });
      let ackCalls = 0;
      const ackNarrativeMaintenanceDelivery = vi.fn(async (sequence: number) => {
        if (sequence !== 1) return { status: "retired" as const };
        ackCalls += 1;
        if (ackCalls === 1 && firstAckOutcome === "rejected") {
          throw new Error("delivery ACK response lost");
        }
        return ackCalls <= 3
          ? { status: "pending" as const }
          : { status: "retired" as const };
      });
      const { scheduler } = createScheduler({
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        resolveNarrativeMaintenanceDelivery,
        ackNarrativeMaintenanceDelivery,
      });

      scheduler.request(workItem);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
      expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 4);

      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(cycleRequests[0]?.attemptId).toBeTypeOf("string");
      expect(
        ackNarrativeMaintenanceDelivery.mock.calls.every(
          ([sequence]) => sequence === 1,
        ),
      ).toBe(true);
      await expect(scheduler.dispose()).resolves.toBeUndefined();
    },
  );

  it("requests rediscovery when later exact proof belongs to a replaced workspace", async () => {
    const originalBinding = {
      authorityId: "authority-late-proof-original",
      generation: 20,
    };
    const replacementBinding = {
      authorityId: "authority-late-proof-replacement",
      generation: 21,
    };
    let currentBinding = originalBinding;
    const completedWork = work(
      "project-late-proof-replacement",
      "backfill",
      "backfill:v2",
      "opened",
    );
    const unfinishedWork = work(
      "project-late-proof-replacement",
      "dependency-verify",
      "verify:v2",
      "verify-requested",
    );
    const completedKey = canonicalNarrativeMaintenanceWorkKey(completedWork);
    const unfinishedKey = canonicalNarrativeMaintenanceWorkKey(unfinishedWork);
    const cycleSettled = deferred<void>();
    let attemptId: string | null = null;
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "workspace-unavailable",
      reason: "maintenance-workspace-changed-during-cycle",
    });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (receivedAttemptId: string, binding: typeof originalBinding) => {
        attemptId = receivedAttemptId;
        return JSON.stringify({
          status: "open",
          attemptId: receivedAttemptId,
          authorityId: binding.authorityId,
          generation: binding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((receivedAttemptId: string) =>
      cancelNarrativeMaintenanceAttempt.mock.calls.length === 1
        ? "not-json"
        : JSON.stringify({
            schemaVersion: 1,
            attemptId: receivedAttemptId,
            state: "interrupted",
            stopReason: null,
            generation: originalBinding.generation,
            workspaceBinding: originalBinding,
            publishedGeneration: null,
            works: [
              { workKey: completedKey, status: "succeeded" },
              { workKey: unfinishedKey, status: "not-started" },
            ],
            cleanup: { status: "clean" },
            connectionReusable: true,
          }),
    );
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockResolvedValue({ status: "retired" });
    const onWorkspaceBindingMismatch = vi.fn();
    const onCompletionRecoveryAcknowledged = vi.fn();
    const { scheduler } = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        ackNarrativeMaintenanceDelivery,
      },
      vi.fn(),
      {
        onCycleSettled: ({ cycleGeneration }) => {
          if (cycleGeneration === 1) cycleSettled.resolve();
        },
        onWorkspaceBindingMismatch,
        onCompletionRecoveryAcknowledged,
      },
    );

    scheduler.request(completedWork);
    scheduler.request(unfinishedWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await cycleSettled.promise;
    expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();

    currentBinding = replacementBinding;
    await expect(
      scheduler.cancelNarrativeMaintenanceAttempt?.(attemptId!, "closed"),
    ).resolves.toMatchObject({ attemptId, state: "interrupted" });
    expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();
    expect(onCompletionRecoveryAcknowledged).toHaveBeenCalledExactlyOnceWith(
      replacementBinding,
    );
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    await expect(scheduler.dispose()).resolves.toBeUndefined();
  });

  it.each([
    ["immediate fence ACK", false],
    ["delayed fence ACK", true],
  ] as const)(
    "uses recordless delivery fence as no-start proof with an empty Native receipt (%s)",
    async (_label, delayedAck) => {
      const binding = { authorityId: "authority-recordless-fence", generation: 18 };
      const workItem = work(
        "project-recordless-fence",
        "backfill",
        "backfill:v2",
        "opened",
      );
      const cycleSettled = deferred<void>();
      const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
        status: "workspace-unavailable",
        reason: "freshness-recovery-required",
      });
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) =>
          JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          }),
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
        JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: "interrupted",
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: null,
          works: [],
          cleanup: { status: "clean" },
          connectionReusable: true,
        }),
      );
      const resolveNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
        Fenced: { sequence: 1 },
      });
      const ackNarrativeMaintenanceDelivery = vi
        .fn()
        .mockResolvedValueOnce(
          delayedAck ? { status: "pending" } : { status: "retired" },
        )
        .mockResolvedValue({ status: "retired" });
      const { scheduler } = createScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => binding,
          runNarrativeMaintenanceCycle,
          beginNarrativeMaintenanceAttempt,
          cancelNarrativeMaintenanceAttempt,
          resolveNarrativeMaintenanceDelivery,
          ackNarrativeMaintenanceDelivery,
        },
        vi.fn(),
        {
          onCycleSettled: ({ cycleGeneration }) => {
            if (cycleGeneration === 1) cycleSettled.resolve();
          },
        },
      );

      scheduler.request(workItem);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      await cycleSettled.promise;

      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
      expect(
        JSON.parse(cancelNarrativeMaintenanceAttempt.mock.results[0]!.value as string)
          .works,
      ).toEqual([]);
      expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
      expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);
      expect(await ackNarrativeMaintenanceDelivery.mock.results[0]?.value).toEqual(
        delayedAck ? { status: "pending" } : { status: "retired" },
      );
      expect(scheduler.getQuiescenceState?.().queueIdle).toBe(false);
      await expect(scheduler.dispose()).resolves.toBeUndefined();
      expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledTimes(
        delayedAck ? 2 : 1,
      );
      expect(ackNarrativeMaintenanceDelivery).toHaveBeenLastCalledWith(1);
    },
  );

  it("keeps a recordless fence ACK barrier through repeated and concurrent retirement", async () => {
    const binding = { authorityId: "authority-fence-ack-race", generation: 19 };
    const workItem = work(
      "project-fence-ack-race",
      "backfill",
      "backfill:v2",
      "opened",
    );
    const cycleSettled = deferred<void>();
    const cycleRequests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        cycleRequests.push(request);
        return Promise.resolve(
          cycleRequests.length === 1
            ? {
                status: "workspace-unavailable" as const,
                reason: "freshness-recovery-required",
              }
            : acceptedCycle(),
        );
      },
    );
    const attemptBindings = new Map<string, typeof binding>();
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) => {
        attemptBindings.set(attemptId, receivedBinding);
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const receiptBinding = attemptBindings.get(attemptId)!;
      const succeeded = cancelNarrativeMaintenanceAttempt.mock.calls.length > 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: succeeded ? "succeeded" : "interrupted",
        stopReason: succeeded ? null : "closed",
        generation: receiptBinding.generation,
        workspaceBinding: receiptBinding,
        publishedGeneration: succeeded ? receiptBinding.generation : null,
        works: succeeded
          ? [
              {
                workKey: canonicalNarrativeMaintenanceWorkKey(workItem),
                status: "succeeded",
              },
            ]
          : [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const resolveNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
      Fenced: { sequence: 1 },
    });
    const deferredConcurrentAck = deferred<{ status: "retired" }>();
    let sequenceOneAcks = 0;
    const ackNarrativeMaintenanceDelivery = vi.fn(
      async (sequence: number): Promise<{ status: "pending" | "retired" }> => {
        if (sequence !== 1) return { status: "retired" };
        sequenceOneAcks += 1;
        if (sequenceOneAcks <= 3) return { status: "pending" };
        if (sequenceOneAcks === 4) return deferredConcurrentAck.promise;
        return { status: "retired" };
      },
    );
    const { scheduler, warn } = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        resolveNarrativeMaintenanceDelivery,
        ackNarrativeMaintenanceDelivery,
      },
      vi.fn(),
      {
        onCycleSettled: ({ cycleGeneration }) => {
          if (cycleGeneration === 1) cycleSettled.resolve();
        },
      },
    );

    scheduler.request(workItem);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await cycleSettled.promise;
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    try {
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
      expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual([[1], [1], [1]]);
    } catch (error) {
      deferredConcurrentAck.resolve({ status: "retired" });
      throw error;
    }

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    deferredConcurrentAck.resolve({ status: "retired" });
    await vi.advanceTimersByTimeAsync(0);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(cycleRequests[1]?.deliverySequence).toBe(2);
    expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
    expect(renderedWarnings(warn).join("\n")).not.toContain(
      "delivery ACK arrived before terminal result application",
    );
    await expect(scheduler.dispose()).resolves.toBeUndefined();
  });

  it.each([
    ["immediate fence ACK", false],
    ["delayed fence ACK", true],
  ] as const)(
    "preserves no-start proof through sequence-invalid replay and AlreadyFenced (%s)",
    async (_label, delayedAck) => {
      const binding = { authorityId: "authority-completion-fence-retry", generation: 5 };
      const workItem = work(
        "project-completion-fence-retry",
        "backfill",
        "backfill:v2",
        "workspace-open",
      );
      const workKey = canonicalNarrativeMaintenanceWorkKey(workItem);
      const cycleRequests: NarrativeMaintenanceCycleRequest[] = [];
      const workspaceUnavailable = {
        status: "workspace-unavailable" as const,
        reason: "lifecycle-no-workspace",
      };
      const runNarrativeMaintenanceCycle = vi.fn(
        (request: NarrativeMaintenanceCycleRequest) => {
          cycleRequests.push(request);
          return Promise.resolve(
            cycleRequests.length === 1
              ? workspaceUnavailable
              : cycleRequests.length <= 3
                ? {
                    status: "workspace-unavailable" as const,
                    reason: "maintenance-delivery-sequence-invalid",
                  }
                : acceptedCycle(),
          );
        },
      );
      const attemptBindings = new Map<string, typeof binding>();
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) => {
          attemptBindings.set(attemptId, receivedBinding);
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
        const receiptBinding = attemptBindings.get(attemptId)!;
        const first = cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: first ? "interrupted" : "succeeded",
          stopReason: null,
          generation: receiptBinding.generation,
          workspaceBinding: receiptBinding,
          publishedGeneration: first ? null : receiptBinding.generation,
          works: first
            ? []
            : [{ workKey, status: "succeeded" }],
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      });
      const resolveNarrativeMaintenanceDelivery = vi
        .fn()
        .mockRejectedValueOnce(new Error("fence reply was lost after commit"))
        .mockRejectedValueOnce(new Error("resolve failed after sequence-invalid replay"))
        .mockResolvedValue({ AlreadyFenced: { sequence: 1 } });
      let fenceAckCalls = 0;
      const ackNarrativeMaintenanceDelivery = vi.fn(async (sequence: number) => {
        if (sequence !== 1) return { status: "retired" as const };
        fenceAckCalls += 1;
        return delayedAck && fenceAckCalls === 1
          ? { status: "pending" as const }
          : { status: "retired" as const };
      });
      const { scheduler } = createScheduler({
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        resolveNarrativeMaintenanceDelivery,
        ackNarrativeMaintenanceDelivery,
      });

      scheduler.request(workItem);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(cycleRequests[1]).toMatchObject({
        deliverySequence: cycleRequests[0]?.deliverySequence,
        deliveryFingerprint: cycleRequests[0]?.deliveryFingerprint,
        work: cycleRequests[0]?.work,
      });
      expect(resolveNarrativeMaintenanceDelivery.mock.calls).toEqual([[1], [1]]);

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(3);
      expect(cycleRequests[2]).toMatchObject({
        deliverySequence: cycleRequests[0]?.deliverySequence,
        deliveryFingerprint: cycleRequests[0]?.deliveryFingerprint,
        work: cycleRequests[0]?.work,
      });
      expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);

      await vi.advanceTimersByTimeAsync(
        ERROR_RETRY_DELAY_MS + (delayedAck ? BACKLOG_DELAY_MS : 0),
      );
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(4);
      expect(cycleRequests[3]?.deliverySequence).toBe(2);
      expect(cycleRequests[3]?.work).toEqual([
        expect.objectContaining({ workKey: workItem.workKey }),
      ]);
      expect(resolveNarrativeMaintenanceDelivery.mock.calls).toEqual([
        [1],
        [1],
        [1],
      ]);
      expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual(
        delayedAck ? [[1], [1], [2]] : [[1], [2]],
      );
      await expect(scheduler.dispose()).resolves.toBeUndefined();
    },
  );

  it.each([
    ["retired", false],
    ["pending", false],
    ["rejected", false],
    ["pending", true],
  ] as const)(
    "releases an exact accepted retry only after its ordinary ACK (%s, capacity=%s)",
    async (firstAck, capacityBeforeAcceptance) => {
      const binding = { authorityId: "authority-completion-accepted-retry", generation: 7 };
      const originalWork = work(
        "project-completion-accepted-retry",
        "backfill",
        "backfill:v2",
        "workspace-open",
      );
      const laterWork = work(
        "project-completion-accepted-retry",
        "dependency-verify",
        "verify:v2",
        "verify-requested",
      );
      const requests: NarrativeMaintenanceCycleRequest[] = [];
      const runNarrativeMaintenanceCycle = vi.fn(
        (request: NarrativeMaintenanceCycleRequest) => {
          requests.push(request);
          if (requests.length === 1) {
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: "lifecycle-no-workspace",
            });
          }
          if (requests.length === 2 && capacityBeforeAcceptance) {
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: "maintenance-delivery-capacity",
            });
          }
          return Promise.resolve(acceptedCycle());
        },
      );
      const attemptBindings = new Map<string, typeof binding>();
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) => {
          attemptBindings.set(attemptId, receivedBinding);
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
        const receiptBinding = attemptBindings.get(attemptId)!;
        const first = cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
        const request = requests.find((cycle) => cycle.attemptId === attemptId);
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: first ? "interrupted" : "succeeded",
          stopReason: null,
          generation: receiptBinding.generation,
          workspaceBinding: receiptBinding,
          publishedGeneration: first ? null : receiptBinding.generation,
          works: first
            ? []
            : (request?.work ?? []).map((item) => ({
                workKey: canonicalNarrativeMaintenanceWorkKey(item),
                status: "succeeded",
              })),
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      });
      const resolveNarrativeMaintenanceDelivery = vi.fn().mockRejectedValueOnce(
        new Error("resolve rejected before Native admission"),
      );
      let sequenceOneAckCalls = 0;
      const ackNarrativeMaintenanceDelivery = vi.fn(async (sequence: number) => {
        if (sequence !== 1) return { status: "retired" as const };
        sequenceOneAckCalls += 1;
        if (sequenceOneAckCalls === 1 && firstAck === "rejected") {
          throw new Error("ordinary delivery ACK rejected");
        }
        if (sequenceOneAckCalls === 1 && firstAck === "pending") {
          return { status: "pending" as const };
        }
        return { status: "retired" as const };
      });
      const { scheduler } = createScheduler({
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        resolveNarrativeMaintenanceDelivery,
        ackNarrativeMaintenanceDelivery,
      });

      scheduler.request(originalWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      scheduler.request(laterWork);

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      if (capacityBeforeAcceptance) {
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      }
      const acceptedRequestIndex = capacityBeforeAcceptance ? 2 : 1;
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
        acceptedRequestIndex + 1,
      );
      expect(requests[acceptedRequestIndex]).toMatchObject({
        deliverySequence: requests[0]?.deliverySequence,
        deliveryFingerprint: requests[0]?.deliveryFingerprint,
        work: requests[0]?.work,
      });
      if (firstAck !== "retired") {
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
          acceptedRequestIndex + 1,
        );
        expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);
        await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      }
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
        acceptedRequestIndex + 2,
      );
      expect(requests[acceptedRequestIndex + 1]?.deliverySequence).toBe(2);
      expect(requests[acceptedRequestIndex + 1]?.work).toEqual([
        expect.objectContaining({ workKey: laterWork.workKey }),
      ]);
      expect(requests[acceptedRequestIndex + 1]?.work).not.toContainEqual(
        expect.objectContaining({ workKey: originalWork.workKey }),
      );
      expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual(
        firstAck === "retired"
          ? [[1], [2]]
          : [[1], [1], [2]],
      );
      await expect(scheduler.dispose()).resolves.toBeUndefined();
    },
  );

  it.each([
    ["coalesced", "pending", false, false],
    ["coalesced", "rejected", false, false],
    ["coalesced", "pending", false, true],
    ["deferred", "pending", false, false],
    ["deferred", "rejected", false, false],
    ["deferred", "pending", true, false],
    ["deferred", "rejected", true, false],
    ["deferred", "pending", false, true],
    ["ci-terminal-fault-handled", "pending", false, false],
    ["ci-terminal-fault-handled", "rejected", false, false],
  ] as const)(
    "hands an exact %s retry to its owner only after ACK (%s, replacement=%s, capacity=%s)",
    async (status, firstAck, replacementEnqueue, capacityBeforeResult) => {
      const binding = { authorityId: `authority-completion-${status}`, generation: 8 };
      const replacementBinding = {
        authorityId: `authority-completion-${status}-replacement`,
        generation: 9,
      };
      let currentBinding: typeof binding | typeof replacementBinding = binding;
      const originalWork = work(
        `project-completion-${status}`,
        "backfill",
        "backfill:v2",
        "workspace-open",
      );
      const laterWork = work(
        originalWork.projectId,
        "dependency-verify",
        "verify:v2",
        "verify-requested",
      );
      const requests: NarrativeMaintenanceCycleRequest[] = [];
      const runNarrativeMaintenanceCycle = vi.fn(
        (request: NarrativeMaintenanceCycleRequest) => {
          requests.push(request);
          if (requests.length === 1) {
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: "lifecycle-no-workspace",
            });
          }
          if (requests.length === 2 && capacityBeforeResult) {
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: "maintenance-delivery-capacity",
            });
          }
          if (requests.length === (capacityBeforeResult ? 3 : 2)) {
            return Promise.resolve(
              status === "coalesced"
                ? { status: "coalesced" as const, hasMore: true }
                : status === "deferred"
                  ? { status: "deferred" as const, hasMore: false }
                  : {
                      status: "ci-terminal-fault-handled" as const,
                      fault: "contract-violation" as const,
                      runId: "run-completion-fault",
                      authorityId: binding.authorityId,
                      generation: binding.generation,
                    },
            );
          }
          return Promise.resolve(acceptedCycle());
        },
      );
      const attemptBindings = new Map<string, typeof binding>();
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) => {
          attemptBindings.set(attemptId, receivedBinding);
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
        const receivedBinding = attemptBindings.get(attemptId)!;
        const request = requests.find((cycle) => cycle.attemptId === attemptId);
        const interrupted = cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: interrupted ? "interrupted" : "succeeded",
          stopReason: interrupted ? null : null,
          generation: receivedBinding.generation,
          workspaceBinding: receivedBinding,
          publishedGeneration: interrupted ? null : receivedBinding.generation,
          works: interrupted
            ? []
            : (request?.work ?? []).map((item) => ({
                workKey: canonicalNarrativeMaintenanceWorkKey(item),
                status: "succeeded",
              })),
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      });
      const resolveNarrativeMaintenanceDelivery = vi
        .fn()
        .mockRejectedValueOnce(new Error("resolve rejected before Native admission"))
        .mockResolvedValue({
          OutOfOrder: { expected: 2, received: 1 },
        });
      let sequenceOneAckCalls = 0;
      const ackNarrativeMaintenanceDelivery = vi.fn(async (sequence: number) => {
        if (sequence !== 1) return { status: "retired" as const };
        sequenceOneAckCalls += 1;
        if (sequenceOneAckCalls === 1 && firstAck === "rejected") {
          throw new Error("ordinary delivery ACK rejected");
        }
        if (sequenceOneAckCalls === 1 && firstAck === "pending") {
          return { status: "pending" as const };
        }
        return { status: "retired" as const };
      });
      const { scheduler } = createScheduler({
        getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        resolveNarrativeMaintenanceDelivery,
        ackNarrativeMaintenanceDelivery,
      });

      scheduler.request(originalWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      scheduler.request(laterWork);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      if (capacityBeforeResult) {
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      }
      const statusCycleIndex = capacityBeforeResult ? 2 : 1;
      expect(requests).toHaveLength(statusCycleIndex + 1);
      expect(requests[statusCycleIndex]).toMatchObject({
        deliverySequence: requests[0]?.deliverySequence,
        deliveryFingerprint: requests[0]?.deliveryFingerprint,
        work: requests[0]?.work,
      });
      expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
        statusCycleIndex + 1,
      );
      if (status === "deferred") {
        if (replacementEnqueue) {
          currentBinding = replacementBinding;
          scheduler.requestWithBinding(
            { ...originalWork, reason: originalWork.reason },
            replacementBinding,
          );
        } else {
          scheduler.request({ ...originalWork, reason: originalWork.reason });
        }
      }
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

      if (status === "coalesced") {
        const continuationIndex = statusCycleIndex + 1;
        await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
        expect(requests[continuationIndex]?.deliverySequence).toBe(2);
        expect(requests[continuationIndex]?.work).toEqual([
          expect.objectContaining({ workKey: laterWork.workKey }),
        ]);
        await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
        expect(requests[continuationIndex + 1]?.deliverySequence).toBe(3);
        expect(requests[continuationIndex + 1]?.work).toEqual([]);
        expect(requests[continuationIndex + 1]?.wakeProjectIds).toEqual([
          originalWork.projectId,
        ]);
      } else if (status === "deferred") {
        await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
          statusCycleIndex + (replacementEnqueue ? 3 : 2),
        );
        const backlogIndex = statusCycleIndex + 1;
        expect(requests[backlogIndex]?.deliverySequence).toBe(2);
        if (replacementEnqueue) {
          expect(requests[backlogIndex]?.work).toEqual([
            expect.objectContaining({ workKey: laterWork.workKey }),
          ]);
          expect(requests[backlogIndex]?.work).not.toContainEqual(
            expect.objectContaining({ workKey: originalWork.workKey }),
          );
          expect(requests[backlogIndex + 1]?.deliverySequence).toBe(3);
          expect(requests[backlogIndex + 1]?.workspaceBinding).toEqual(replacementBinding);
          expect(requests[backlogIndex + 1]?.work).toEqual([
            expect.objectContaining({
              workKey: originalWork.workKey,
              reasons: [originalWork.reason],
            }),
          ]);
        } else {
          expect(requests[backlogIndex]?.work).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ workKey: laterWork.workKey }),
              expect.objectContaining({
                workKey: originalWork.workKey,
                reasons: [originalWork.reason],
              }),
            ]),
          );
        }
      } else {
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
          statusCycleIndex + 2,
        );
        expect(requests[statusCycleIndex + 1]?.deliverySequence).toBe(2);
        expect(requests[statusCycleIndex + 1]?.work).toEqual([
          expect.objectContaining({ workKey: laterWork.workKey }),
        ]);
        expect(requests[statusCycleIndex + 1]?.work).not.toContainEqual(
          expect.objectContaining({ workKey: originalWork.workKey }),
        );
      }
      await expect(scheduler.dispose()).resolves.toBeUndefined();
    },
  );

  it("retains a proof handoff until a current binding is available after delivery ACK", async () => {
    const originalBinding = { authorityId: "authority-delayed-binding-a", generation: 1 };
    const proofBinding = { authorityId: "authority-delayed-binding-b", generation: 2 };
    const currentBindingC = { authorityId: "authority-delayed-binding-c", generation: 3 };
    let currentBinding: typeof originalBinding | typeof proofBinding | typeof currentBindingC | null = originalBinding;
    const oldWork = work(
      "project-delayed-binding",
      "backfill",
      "backfill:v2",
      "workspace-open",
    );
    const discoveredWork = work(
      "project-delayed-binding",
      "dependency-verify",
      "verify:current",
      "workspace-open",
    );
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1
            ? {
                status: "workspace-unavailable" as const,
                reason: "maintenance-workspace-changed-during-cycle",
              }
            : acceptedCycle(),
        );
      },
    );
    const attemptBindings = new Map<
      string,
      typeof originalBinding | typeof proofBinding | typeof currentBindingC
    >();
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (
        attemptId: string,
        binding: typeof originalBinding | typeof proofBinding | typeof currentBindingC,
      ) => {
        attemptBindings.set(attemptId, binding);
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: binding.authorityId,
          generation: binding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const binding = attemptBindings.get(attemptId)!;
      const call = cancelNarrativeMaintenanceAttempt.mock.calls.length;
      if (call === 1) return "not-json";
      const request = requests.find((cycle) => cycle.attemptId === attemptId);
      const succeeded = call > 2;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: succeeded ? "succeeded" : "interrupted",
        stopReason: succeeded ? null : "closed",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: succeeded ? binding.generation : null,
        works: succeeded
          ? (request?.work ?? []).map((item) => ({
              workKey: canonicalNarrativeMaintenanceWorkKey(item),
              status: "succeeded",
            }))
          : [
              {
                workKey: canonicalNarrativeMaintenanceWorkKey(oldWork),
                status: "not-started",
              },
            ],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    let firstDeliveryAck = true;
    const ackNarrativeMaintenanceDelivery = vi.fn(async (sequence: number) => {
      if (sequence === 1 && firstDeliveryAck) {
        firstDeliveryAck = false;
        return { status: "pending" as const };
      }
      return { status: "retired" as const };
    });
    let scheduler!: ReturnType<typeof createNarrativeMaintenanceScheduler>;
    const onCompletionRecoveryAcknowledged = vi.fn(
      (binding: typeof currentBindingC) => {
        scheduler.requestWithBinding(discoveredWork, binding);
      },
    );
    scheduler = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        ackNarrativeMaintenanceDelivery,
      },
      vi.fn(),
      { onCompletionRecoveryAcknowledged },
    ).scheduler;

    scheduler.requestWithBinding(oldWork, originalBinding);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    const oldAttemptId = requests[0]?.attemptId;
    expect(oldAttemptId).toBeTypeOf("string");

    currentBinding = proofBinding;
    await expect(
      scheduler.cancelNarrativeMaintenanceAttempt?.(oldAttemptId!, "closed"),
    ).resolves.toMatchObject({ attemptId: oldAttemptId, state: "interrupted" });
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);

    currentBinding = null;
    const lease = await scheduler.quiesceForWorkspaceSwitch?.();
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual([[1], [1]]);
    expect(onCompletionRecoveryAcknowledged).not.toHaveBeenCalled();
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    currentBinding = currentBindingC;
    scheduler.requestWithBinding(
      { ...oldWork, reason: "same-key-after-switch" },
      currentBindingC,
    );
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    lease?.resume();
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(onCompletionRecoveryAcknowledged).toHaveBeenCalledExactlyOnceWith(
      currentBindingC,
    );
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(requests[1]?.workspaceBinding).toEqual(currentBindingC);
    expect(requests[1]?.deliverySequence).toBe(2);
    expect(requests[1]?.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workKey: discoveredWork.workKey }),
        expect.objectContaining({
          workKey: oldWork.workKey,
          reasons: ["same-key-after-switch"],
        }),
      ]),
    );
    expect(requests[1]?.work).not.toContainEqual(
      expect.objectContaining({
        workKey: oldWork.workKey,
        reasons: ["workspace-open"],
      }),
    );
    await expect(scheduler.dispose()).resolves.toBeUndefined();
  });

  it.each(["workspace-unavailable", "not-admitted"] as const)(
    "keeps an unproven completion delivery on the same H+1 sequence after %s",
    async (retryStatus) => {
    const binding = { authorityId: "authority-completion-no-fence", generation: 6 };
    const workItem = work(
      "project-completion-no-fence",
      "backfill",
      "backfill:v2",
      "workspace-open",
    );
    const cycleRequests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        cycleRequests.push(request);
        return Promise.resolve(
          cycleRequests.length === 1 || retryStatus === "workspace-unavailable"
            ? {
                status: "workspace-unavailable" as const,
                reason: "lifecycle-no-workspace",
              }
            : { status: "not-admitted" as const, reason: "lifecycle-active" },
        );
      },
    );
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const resolveNarrativeMaintenanceDelivery = vi
      .fn()
      .mockRejectedValueOnce(new Error("resolve failed before admission"))
      .mockResolvedValue({
        OutOfOrder: { expected: 2, received: 1 },
      });
    const ackNarrativeMaintenanceDelivery = vi.fn();
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      resolveNarrativeMaintenanceDelivery,
      ackNarrativeMaintenanceDelivery,
    });

    scheduler.request(workItem);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(3);
    expect(cycleRequests.map((request) => request.deliverySequence)).toEqual([
      1,
      1,
      1,
    ]);
    expect(cycleRequests.map((request) => request.deliveryFingerprint)).toEqual([
      cycleRequests[0]?.deliveryFingerprint,
      cycleRequests[0]?.deliveryFingerprint,
      cycleRequests[0]?.deliveryFingerprint,
    ]);
    expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledTimes(3);
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
    await expect(scheduler.dispose()).rejects.toThrow(
      /TERMINAL_RECEIPT_UNRESOLVED/,
    );
    },
  );

  it.each([
    ["maintenance-workspace-binding-mismatch", "retired", false],
    ["maintenance-workspace-binding-mismatch", "pending", false],
    ["maintenance-workspace-binding-mismatch", "rejected", false],
    ["maintenance-workspace-binding-mismatch", "pending", true],
    ["maintenance-workspace-snapshot-changed", "retired", false],
    ["maintenance-workspace-snapshot-changed", "pending", false],
    ["lifecycle-no-workspace", "none", false],
  ] as const)(
    "hands an exact stale-binding no-start result to B only after ACK (%s, %s, capacity=%s)",
    async (retryReason, firstAck, capacityBeforeMismatch) => {
      const bindingA = { authorityId: "authority-stale-retry-a", generation: 41 };
      const bindingB = { authorityId: "authority-stale-retry-b", generation: 42 };
      let currentBinding: typeof bindingA | typeof bindingB = bindingA;
      const oldWork = work(
        "project-stale-retry",
        "backfill",
        "backfill:v2",
        "workspace-open",
      );
      const newRequest = { ...oldWork, reason: "foreground-after-switch" };
      const discoveredWork = work(
        oldWork.projectId,
        "dependency-verify",
        "verify:binding-b",
        "workspace-open",
      );
      const requests: NarrativeMaintenanceCycleRequest[] = [];
      const runNarrativeMaintenanceCycle = vi.fn(
        (request: NarrativeMaintenanceCycleRequest) => {
          requests.push(request);
          if (requests.length === 1) {
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: "lifecycle-no-workspace",
            });
          }
          if (requests.length === 2 && capacityBeforeMismatch) {
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: "maintenance-delivery-capacity",
            });
          }
          if (requests.length === (capacityBeforeMismatch ? 3 : 2)) {
            return Promise.resolve({
              status: "workspace-unavailable" as const,
              reason: retryReason,
            });
          }
          return Promise.resolve(acceptedCycle());
        },
      );
      const attemptBindings = new Map<
        string,
        typeof bindingA | typeof bindingB
      >();
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, binding: typeof bindingA | typeof bindingB) => {
          attemptBindings.set(attemptId, binding);
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: binding.authorityId,
            generation: binding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
        const binding = attemptBindings.get(attemptId)!;
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: "interrupted",
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: null,
          works: [],
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      });
      const resolveNarrativeMaintenanceDelivery = vi
        .fn()
        .mockRejectedValueOnce(new Error("resolve response lost"))
        .mockResolvedValue({ OutOfOrder: { expected: 2, received: 1 } });
      let sequenceOneAckCalls = 0;
      const ackNarrativeMaintenanceDelivery = vi.fn(async (sequence: number) => {
        if (sequence !== 1) return { status: "retired" as const };
        sequenceOneAckCalls += 1;
        if (firstAck === "none") return { status: "retired" as const };
        if (sequenceOneAckCalls === 1 && firstAck === "pending") {
          return { status: "pending" as const };
        }
        if (sequenceOneAckCalls === 1 && firstAck === "rejected") {
          throw new Error("ordinary ACK response lost");
        }
        return { status: "retired" as const };
      });
      let scheduler!: ReturnType<typeof createNarrativeMaintenanceScheduler>;
      const onCompletionRecoveryAcknowledged = vi.fn((binding) => {
        scheduler.requestWithBinding(discoveredWork, binding);
      });
      const warn = vi.fn();
      scheduler = createNarrativeMaintenanceScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
          runNarrativeMaintenanceCycle,
          beginNarrativeMaintenanceAttempt,
          cancelNarrativeMaintenanceAttempt,
          resolveNarrativeMaintenanceDelivery,
          ackNarrativeMaintenanceDelivery,
        },
        { warn, onCompletionRecoveryAcknowledged },
      );
      schedulers.push(scheduler);

      scheduler.requestWithBinding(oldWork, bindingA);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      currentBinding = bindingB;
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      if (capacityBeforeMismatch) {
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      }
      const proofRequestIndex = capacityBeforeMismatch ? 2 : 1;
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
        proofRequestIndex + 1,
      );
      expect(
        requests.map((request) => request.deliverySequence),
      ).toEqual(Array.from({ length: proofRequestIndex + 1 }, () => 1));
      expect(requests[proofRequestIndex]?.workspaceBinding).toEqual(bindingA);
      expect(resolveNarrativeMaintenanceDelivery.mock.calls).toEqual([[1], [1]]);

      const exactNoStartReason =
        retryReason === "maintenance-workspace-binding-mismatch" ||
        retryReason === "maintenance-workspace-snapshot-changed";
      if (!exactNoStartReason) {
        expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
        scheduler.requestWithBinding(newRequest, bindingB);
        expect(onCompletionRecoveryAcknowledged).not.toHaveBeenCalled();
        await expect(scheduler.dispose()).rejects.toThrow(
          /TERMINAL_RECEIPT_UNRESOLVED/,
        );
        return;
      }
      if (firstAck !== "retired") {
        expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
        expect(onCompletionRecoveryAcknowledged).not.toHaveBeenCalled();
      }
      scheduler.requestWithBinding(newRequest, bindingB);
      if (firstAck !== "retired") {
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
          proofRequestIndex + 1,
        );
        await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      }
      expect(onCompletionRecoveryAcknowledged).toHaveBeenCalledExactlyOnceWith(
        bindingB,
      );
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + BACKLOG_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
        proofRequestIndex + 2,
      );
      expect(requests[proofRequestIndex + 1]?.deliverySequence).toBe(2);
      expect(requests[proofRequestIndex + 1]?.workspaceBinding).toEqual(bindingB);
      expect(requests[proofRequestIndex + 1]?.work).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workKey: newRequest.workKey,
            reasons: [newRequest.reason],
          }),
          expect.objectContaining({ workKey: discoveredWork.workKey }),
        ]),
      );
      expect(requests[proofRequestIndex + 1]?.work).not.toContainEqual(
        expect.objectContaining({
          workKey: oldWork.workKey,
          reasons: [oldWork.reason],
        }),
      );
      expect(scheduler.getQuiescenceState?.().queueIdle).toBe(false);
      await expect(scheduler.dispose()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("TERMINAL_RECEIPT_UNRESOLVED"),
      );
    },
  );

  it.each([
    "retired",
    "duplicate-retired",
    "rejected",
    "drain-rejects-first",
  ] as const)(
    "does not resurrect ordinary ACK ownership after concurrent recovery drain (%s timer response)",
    async (timerResponse) => {
    const failedBinding = { authorityId: "authority-replay-recovery", generation: 31 };
    const recoveredBinding = { authorityId: "authority-replay-recovery-new", generation: 32 };
    let currentBinding = failedBinding;
    const workItem = work(
      "project-replay-recovery",
      "backfill",
      "backfill:v2",
      "workspace-open",
    );
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          return Promise.resolve({
            status: "workspace-unavailable" as const,
            reason: "maintenance-recovery-required",
            descriptorId: 41,
          });
        }
        return Promise.resolve(
          request.deliverySequence === 1
            ? {
                status: "workspace-unavailable" as const,
                reason: "maintenance-delivery-replay-pending",
              }
            : acceptedCycle(),
        );
      },
    );
    const attemptBindings = new Map<string, typeof failedBinding>();
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, binding: typeof failedBinding) => {
        attemptBindings.set(attemptId, binding);
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: binding.authorityId,
          generation: binding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const receiptBinding = attemptBindings.get(attemptId)!;
      const first = cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
      const request = requests.find((cycle) => cycle.attemptId === attemptId);
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: first ? "interrupted" : "succeeded",
        stopReason: first ? "closed" : null,
        generation: receiptBinding.generation,
        workspaceBinding: receiptBinding,
        publishedGeneration: first ? null : receiptBinding.generation,
        works: first
          ? []
          : (request?.work ?? []).map((item) => ({
              workKey: canonicalNarrativeMaintenanceWorkKey(item),
              status: "succeeded",
            })),
        cleanup: first
          ? { status: "failed", error: "rollback failed" }
          : { status: "clean" },
        connectionReusable: !first,
      });
    });
    const resolveNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
      OutOfOrder: { expected: 2, received: 1 },
    });
    let recoveryAcknowledged = false;
    const reconcileNarrativeMaintenanceRecovery = vi.fn(async () =>
      reconcileNarrativeMaintenanceRecovery.mock.calls.length === 1 ||
      recoveryAcknowledged
        ? { status: "none" as const }
        : {
            status: "reconciled" as const,
            descriptorId: 41,
            reason: "maintenance-recovery-complete",
            recoveredBinding: failedBinding,
            activeBinding: recoveredBinding,
            reboundBinding: recoveredBinding,
          },
    );
    let recoveryAckCalls = 0;
    const ackNarrativeMaintenanceRecovery = vi.fn(async () => {
      recoveryAckCalls += 1;
      recoveryAcknowledged = true;
      if (recoveryAckCalls === 1) {
        throw new Error("recovery ACK response lost after Native retirement");
      }
      return {
        status: "acknowledged",
        descriptorId: 41,
        acknowledged: true,
      };
    });
    const timerAck = deferred<{ status: "retired" }>();
    const drainAck = deferred<{ status: "retired" }>();
    let deliveryAckCalls = 0;
    const ackNarrativeMaintenanceDelivery = vi.fn(async (sequence: number) => {
      if (sequence !== 1) return { status: "retired" as const };
      deliveryAckCalls += 1;
      if (deliveryAckCalls === 1) throw new Error("delivery ACK unavailable");
      if (deliveryAckCalls === 2) return timerAck.promise;
      if (deliveryAckCalls === 3) return drainAck.promise;
      throw new Error("subsequent delivery ACK unavailable");
    });
    let scheduler!: ReturnType<typeof createNarrativeMaintenanceScheduler>;
    const onCompletionRecoveryAcknowledged = vi.fn((binding) => {
      scheduler.requestWithBinding(workItem, binding);
    });
    const warn = vi.fn();
    scheduler = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        resolveNarrativeMaintenanceDelivery,
        reconcileNarrativeMaintenanceRecovery,
        ackNarrativeMaintenanceRecovery,
        ackNarrativeMaintenanceDelivery,
      },
      warn,
      { onCompletionRecoveryAcknowledged },
    ).scheduler;

    scheduler.requestWithBinding(workItem, failedBinding);
    expect(scheduler.getQuiescenceState?.().queueIdle).toBe(false);
    scheduler.start();
    expect(scheduler.getQuiescenceState?.().timerScheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(requests[0]?.deliverySequence).toBe(1);
    expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);

    const lease = await scheduler.quiesceForWorkspaceSwitch?.();
    currentBinding = recoveredBinding;
    await expect(
      scheduler.reconcileRecoveryBeforeWorkspaceOpen?.("/workspace/recovered"),
    ).rejects.toThrow(/RECOVERY_ACK_PENDING/);
    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    lease?.resume();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(ackNarrativeMaintenanceRecovery.mock.calls).toEqual([
      ["41"],
      ["41"],
    ]);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(ackNarrativeMaintenanceDelivery.mock.calls.slice(0, 2)).toEqual([
      [1],
      [1],
    ]);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    const leaseAgain = await scheduler.quiesceForWorkspaceSwitch?.();
    const draining = scheduler.reconcileRecoveryBeforeWorkspaceOpen?.(
      "/workspace/recovered",
    );
    await vi.waitFor(() => {
      expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledTimes(3);
    });
    if (timerResponse === "drain-rejects-first") {
      drainAck.reject(new Error("recovery drain ACK response lost"));
      await draining;
      timerAck.resolve({ status: "retired" });
    } else if (timerResponse !== "rejected") {
      timerAck.resolve({ status: "retired" });
      await Promise.resolve();
      await Promise.resolve();
      if (timerResponse === "retired") {
        drainAck.reject(new Error("late recovery ACK response lost"));
      } else {
        drainAck.resolve({ status: "retired" });
      }
    } else {
      drainAck.resolve({ status: "retired" });
      await draining;
      timerAck.reject(new Error("late timer ACK response lost"));
    }
    await draining;
    await Promise.resolve();
    await Promise.resolve();
    if (timerResponse === "drain-rejects-first") {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      const sequenceOneAcks = ackNarrativeMaintenanceDelivery.mock.calls.filter(
        ([sequence]) => sequence === 1,
      );
      expect(sequenceOneAcks).toHaveLength(3);
    }
    leaseAgain?.resume();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(requests[1]?.deliverySequence).toBe(2);
    expect(requests[1]?.deliveryFingerprint).not.toBe(
      requests[0]?.deliveryFingerprint,
    );
    expect(onCompletionRecoveryAcknowledged).toHaveBeenCalledExactlyOnceWith(
      recoveredBinding,
    );
    expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
    expect(
      renderedWarnings(warn).some((message) =>
        message.includes("retaining delivery ACK sequence 1 for retry"),
      ),
    ).toBe(false);
    await expect(scheduler.dispose()).resolves.toBeUndefined();
    if (timerResponse === "drain-rejects-first") {
      expect(
        ackNarrativeMaintenanceDelivery.mock.calls.filter(
          ([sequence]) => sequence === 1,
        ),
      ).toHaveLength(3);
    }
  });

  it("replays the exact delivery when fence resolution fails before Native commits", async () => {
    const binding = { authorityId: "authority-uncommitted-fence", generation: 4 };
    const firstWork = work(
      "project-uncommitted-fence",
      "backfill",
      "backfill:v2",
      "first",
    );
    const laterWork = work(
      "project-uncommitted-fence",
      "dependency-verify",
      "verify:v2",
      "later",
    );
    const cycleRequests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        cycleRequests.push(request);
        return cycleRequests.length === 1
          ? Promise.reject(new Error("lost before Native delivery admission"))
          : Promise.resolve(acceptedCycle());
      },
    );
    const attemptBindings = new Map<string, typeof binding>();
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) => {
        attemptBindings.set(attemptId, receivedBinding);
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const receiptBinding = attemptBindings.get(attemptId)!;
      const succeeded = cancelNarrativeMaintenanceAttempt.mock.calls.length > 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: succeeded ? "succeeded" : "interrupted",
        stopReason: succeeded ? null : "closed",
        generation: receiptBinding.generation,
        workspaceBinding: receiptBinding,
        publishedGeneration: succeeded ? receiptBinding.generation : null,
        works: succeeded
          ? cycleRequests[cycleRequests.length - 1]!.work.map((item) => ({
              workKey: canonicalNarrativeMaintenanceWorkKey(item),
              status: "succeeded",
            }))
          : [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const resolveNarrativeMaintenanceDelivery = vi
      .fn()
      .mockRejectedValueOnce(new Error("resolve failed before fence commit"))
      .mockResolvedValue({ status: "fenced" });
    const ackNarrativeMaintenanceDelivery = vi.fn(
      async (): Promise<{ status: "pending" | "retired" }> =>
        cycleRequests.length === 1
          ? { status: "pending" }
          : { status: "retired" },
    );
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      resolveNarrativeMaintenanceDelivery,
      ackNarrativeMaintenanceDelivery,
    });

    scheduler.request(firstWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(resolveNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();

    scheduler.request(laterWork);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(cycleRequests[1]).toMatchObject({
      deliverySequence: cycleRequests[0]?.deliverySequence,
      deliveryFingerprint: cycleRequests[0]?.deliveryFingerprint,
      work: cycleRequests[0]?.work,
    });
    expect(cycleRequests[1]?.deliverySequence).toBe(1);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledExactlyOnceWith(1);

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(3);
    expect(cycleRequests[2]?.deliverySequence).toBe(2);
    expect(cycleRequests[2]?.work).toEqual([
      expect.objectContaining({ workKey: laterWork.workKey }),
    ]);
    await expect(scheduler.dispose()).resolves.toBeUndefined();
  });

  it("retries the exact H+1 delivery after Native capacity frees", async () => {
    const binding = { authorityId: "authority-capacity", generation: 3 };
    const originalWork = work(
      "project-capacity",
      "backfill",
      "backfill:v2",
      "capacity-retry",
    );
    const canonicalWorkKey = canonicalNarrativeMaintenanceWorkKey(originalWork);
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "maintenance-delivery-capacity",
      })
      .mockResolvedValueOnce(acceptedCycle());
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockResolvedValue({ status: "retired" });
    const resolveNarrativeMaintenanceDelivery = vi.fn();
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const interrupted =
        cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: interrupted ? "interrupted" : "succeeded",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: interrupted ? null : binding.generation,
        works: [
          {
            workKey: canonicalWorkKey,
            status: interrupted ? "interrupted" : "succeeded",
          },
        ],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const { scheduler, warn } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      ackNarrativeMaintenanceDelivery,
      resolveNarrativeMaintenanceDelivery,
    });

    scheduler.request(originalWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    const firstRequest = runNarrativeMaintenanceCycle.mock.calls[0]?.[0];
    expect(firstRequest?.deliverySequence).toBe(1);
    expect(firstRequest?.deliveryFingerprint).toBeTypeOf("string");
    expect(firstRequest?.attemptId).toBeTypeOf("string");
    expect(resolveNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("delivery capacity is full"),
    );

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
    const retryRequest = runNarrativeMaintenanceCycle.mock.calls[1]?.[0];
    expect(retryRequest).toEqual({
      ...firstRequest,
      attemptId: expect.any(String),
    });
    expect(retryRequest?.attemptId).toBeTypeOf("string");
    expect(retryRequest?.attemptId).not.toBe(firstRequest?.attemptId);
    expect(resolveNarrativeMaintenanceDelivery).not.toHaveBeenCalled();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledTimes(1);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenLastCalledWith(1);
  });

  it("applies a rebound proof to a capacity-blocked delivery before retrying it", async () => {
    const before = { authorityId: "authority-capacity-before", generation: 1 };
    const after = { authorityId: "authority-capacity-after", generation: 2 };
    const originalWork = work(
      "project-capacity-recovery",
      "backfill",
      "backfill:v2",
      "capacity-recovery",
    );
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "maintenance-delivery-capacity",
      })
      .mockResolvedValue(acceptedCycle());
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "none" })
      .mockResolvedValueOnce({
        status: "reconciled",
        descriptorId: 71,
        reason: "maintenance-recovery-complete",
        recoveredBinding: before,
        activeBinding: after,
        reboundBinding: after,
      })
      .mockResolvedValue({ status: "none" });
    const ackNarrativeMaintenanceRecovery = vi.fn().mockResolvedValue({
      status: "acknowledged",
      descriptorId: 71,
      acknowledged: true,
    });
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockResolvedValue({ status: "retired" });
    const scheduler = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => after,
      reconcileNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceDelivery,
      runNarrativeMaintenanceCycle,
    }).scheduler;

    scheduler.requestWithBinding(originalWork, before);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    const firstRequest = runNarrativeMaintenanceCycle.mock.calls[0]?.[0];
    expect(firstRequest?.workspaceBinding).toEqual(before);
    expect(firstRequest?.deliverySequence).toBe(1);

    // The first retry consumes the proof and keeps the exact capacity-owned
    // sequence parked. The following retry must send that owner with the
    // replacement binding rather than the stale one.
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    const retryRequest = runNarrativeMaintenanceCycle.mock.calls[1]?.[0];
    expect(retryRequest?.workspaceBinding).toEqual(after);
    expect(retryRequest?.deliverySequence).toBe(firstRequest?.deliverySequence);
    expect(retryRequest?.deliveryFingerprint).toBe(
      firstRequest?.deliveryFingerprint,
    );
    expect(ackNarrativeMaintenanceRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      runNarrativeMaintenanceCycle.mock.invocationCallOrder[1]!,
    );
  });

  it("keeps a capacity retry cancellable during workspace quiescence", async () => {
    const binding = {
      authorityId: "authority-capacity-quiesce",
      generation: 4,
    };
    const originalWork = work(
      "project-capacity-quiesce",
      "backfill",
      "backfill:v2",
      "capacity-retry",
    );
    const canonicalWorkKey = canonicalNarrativeMaintenanceWorkKey(originalWork);
    const retry = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "maintenance-delivery-capacity",
      })
      .mockReturnValueOnce(retry.promise);
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const workspaceStop =
        cancelNarrativeMaintenanceAttempt.mock.calls.length > 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: workspaceStop ? "workspace-generation-changed" : null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [{ workKey: canonicalWorkKey, status: "interrupted" }],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(originalWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();

    const quiescing = scheduler.quiesceForWorkspaceSwitch?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);

    let quiescenceSettled = false;
    void quiescing?.then(() => {
      quiescenceSettled = true;
    });
    await Promise.resolve();
    expect(quiescenceSettled).toBe(false);

    retry.resolve(acceptedCycle());
    const lease = await quiescing;
    expect(lease).toBeDefined();
    lease?.resume(true);
  });

  it("releases partial project claims before waiting on a capacity retry", async () => {
    const firstProjectWork = work(
      "project-capacity-first",
      "backfill",
      "backfill:v2",
      "capacity-retry",
    );
    const blockedProjectWork = work(
      "project-capacity-blocked",
      "dependency-verify",
      "verify:v2",
      "capacity-retry",
    );
    const runOwner = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "maintenance-delivery-capacity",
      })
      .mockResolvedValue(acceptedCycle());
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockResolvedValue({ status: "retired" });
    const { scheduler: owner } = createScheduler({
      runNarrativeMaintenanceCycle: runOwner,
      ackNarrativeMaintenanceDelivery,
    });

    owner.request(firstProjectWork);
    owner.request(blockedProjectWork);
    owner.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runOwner).toHaveBeenCalledOnce();

    const competingRun = deferred<NarrativeMaintenanceCycleResult>();
    const runCompeting = vi.fn().mockReturnValue(competingRun.promise);
    const { scheduler: competing } = createScheduler({
      runNarrativeMaintenanceCycle: runCompeting,
    });
    competing.request(blockedProjectWork);
    competing.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runCompeting).toHaveBeenCalledOnce();

    // The owner can claim project-capacity-first, but the competing scheduler
    // still owns project-capacity-blocked. It must release its partial claim
    // before waiting, or the next wake will see its own stale claim.
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runOwner).toHaveBeenCalledOnce();

    competingRun.resolve(acceptedCycle());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runOwner).toHaveBeenCalledTimes(2);
    expect(runOwner.mock.calls[1]?.[0]).toEqual(runOwner.mock.calls[0]?.[0]);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledOnce();
  });

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

  it("retries an exact lifecycle-no-workspace rejection with delivery APIs and no binding", async () => {
    let binding: { authorityId: string; generation: number } | null = null;
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "workspace-unavailable",
        reason: "lifecycle-no-workspace",
      })
      .mockResolvedValue(acceptedCycle());
    const ackNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
      status: "retired",
    });
    const beginNarrativeMaintenanceAttempt = vi.fn();
    const cancelNarrativeMaintenanceAttempt = vi.fn();
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      ackNarrativeMaintenanceDelivery,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(
      work("project-no-workspace", "backfill", "backfill:v2", "opened"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    binding = { authorityId: "authority-restored", generation: 9 };
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(beginNarrativeMaintenanceAttempt).not.toHaveBeenCalled();
    expect(cancelNarrativeMaintenanceAttempt).not.toHaveBeenCalled();
    expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual([[1], [2]]);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].deliverySequence).toBe(
      2,
    );
    await expect(scheduler.dispose()).resolves.toBeUndefined();
  });

  it("keeps legacy workspace-unavailable retries when lifecycle begin falls back locally", async () => {
    const binding = { authorityId: "authority-local-attempt-fallback", generation: 19 };
    const workItem = work(
      "project-local-attempt-fallback",
      "backfill",
      "backfill:v2",
      "opened",
    );
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1
            ? { status: "workspace-unavailable" as const }
            : acceptedCycle(),
        );
      },
    );
    const beginNarrativeMaintenanceAttempt = vi.fn().mockResolvedValue(undefined);
    const cancelNarrativeMaintenanceAttempt = vi.fn();
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(workItem);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
    expect(cancelNarrativeMaintenanceAttempt).not.toHaveBeenCalled();
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(requests[1]?.work).toEqual(requests[0]?.work);
    await expect(scheduler.dispose()).resolves.toBeUndefined();
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

  it("uses bounded delivery retry for a generic Native error with an interrupted receipt", async () => {
    const binding = { authorityId: "authority-sqlite-full", generation: 1 };
    const canonicalWorkKey =
      "narrative-maintenance:v1/backfill/project-sqlite-full/backfill:v2";
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [
          {
            workKey: canonicalWorkKey,
            status: "failed",
            error: "SQLITE_FULL: database or disk is full",
          },
        ],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const recordNarrativeMaintenanceDeliveryFailure = vi
      .fn()
      .mockResolvedValue({
        status: "accepted",
        receiptId: "sqlite-full-delivery-failure",
      });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      recordNarrativeMaintenanceDeliveryFailure,
    });

    scheduler.request(
      work("project-sqlite-full", "backfill", "backfill:v2", "open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    // An interrupted terminal receipt from cleanup must not become the 10 ms
    // cancellation loop when the Native operation itself failed.
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(recordNarrativeMaintenanceDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-sqlite-full",
        workspaceBinding: binding,
        error: expect.stringContaining("SQLITE_FULL"),
      }),
    );
  });

  it("keeps an explicit preemption result on the bounded cancellation path", async () => {
    const binding = { authorityId: "authority-preempted", generation: 2 };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "accepted",
        hasMore: true,
        preempted: true,
      })
      .mockResolvedValue(acceptedCycle());
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    let cancelCount = 0;
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      cancelCount += 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: cancelCount === 1 ? "interrupted" : "succeeded",
        stopReason: null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration:
          cancelCount === 1 ? null : binding.generation,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(
      work("project-preempted", "backfill", "backfill:v2", "open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
  });

  it("requeues only interrupted work from a complete effective Native receipt", async () => {
    const binding = { authorityId: "authority-selective-requeue", generation: 3 };
    const firstWork = work(
      "project-selective-requeue",
      "backfill",
      "backfill:first",
      "open",
    );
    const secondWork = work(
      "project-selective-requeue",
      "backfill",
      "backfill:second",
      "open",
    );
    const effectiveKey = (item: NarrativeMaintenanceRequest): string =>
      canonicalNarrativeMaintenanceWorkKey({
        ...item,
        semanticEpochId: "epoch-effective",
      });
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "accepted",
        hasMore: false,
        preempted: true,
      })
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    let cancelCount = 0;
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      cancelCount += 1;
      const interrupted = cancelCount === 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: interrupted ? "interrupted" : "succeeded",
        stopReason: interrupted ? "foreground-preempted" : null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: interrupted ? null : binding.generation,
        works: interrupted
          ? [
              { workKey: effectiveKey(firstWork), status: "succeeded" },
              { workKey: effectiveKey(secondWork), status: "interrupted" },
            ]
          : [{ workKey: effectiveKey(secondWork), status: "succeeded" }],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(firstWork);
    scheduler.request(secondWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].work).toEqual([
      expect.objectContaining({
        projectId: secondWork.projectId,
        runKind: secondWork.runKind,
        workKey: secondWork.workKey,
        semanticEpochId: null,
      }),
    ]);
    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
  });

  it("reconstructs a dynamic effective follow-up from an interrupted receipt", async () => {
    const binding = { authorityId: "authority-dynamic-requeue", generation: 4 };
    const initialWork = work(
      "project-dynamic-requeue",
      "dependency-verify",
      "dependency-verify:epoch-effective",
      "verify-requested",
    );
    const dynamicWork: NarrativeMaintenanceRequest = {
      projectId: initialWork.projectId,
      runKind: "semantic-index-rebuild",
      workKey: "dependency-rebuild-derived",
      semanticEpochId: "epoch-effective",
      reason: "native-maintenance-interrupted",
    };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "accepted",
        hasMore: false,
        preempted: true,
      })
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
    );
    let cancelCount = 0;
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      cancelCount += 1;
      const interrupted = cancelCount === 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: interrupted ? "interrupted" : "succeeded",
        stopReason: interrupted ? "foreground-preempted" : null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: interrupted ? null : binding.generation,
        works: interrupted
          ? [
              {
                workKey: canonicalNarrativeMaintenanceWorkKey(initialWork),
                status: "succeeded",
              },
              {
                workKey: canonicalNarrativeMaintenanceWorkKey(dynamicWork),
                status: "not-started",
              },
            ]
          : [
              {
                workKey: canonicalNarrativeMaintenanceWorkKey(dynamicWork),
                status: "succeeded",
              },
            ],
        cleanup: { status: "clean" },
        connectionReusable: true,
      });
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
    });

    scheduler.request(initialWork);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].work).toEqual([
      expect.objectContaining({
        projectId: dynamicWork.projectId,
        runKind: dynamicWork.runKind,
        workKey: dynamicWork.workKey,
        semanticEpochId: dynamicWork.semanticEpochId,
        reasons: ["native-maintenance-interrupted"],
      }),
    ]);
  });

  it.each(["resolved", "rejected"] as const)(
    "uses the controller receipt adopted by quiesce before the cycle is %s",
    async (cycleOutcome) => {
      const binding = {
        authorityId: `authority-adopted-race-${cycleOutcome}`,
        generation: 5,
      };
      const firstWork = work(
        `project-adopted-race-a-${cycleOutcome}`,
        "backfill",
        "legacy-dependency-backfill:v3",
        "open",
      );
      const secondWork = work(
        `project-adopted-race-b-${cycleOutcome}`,
        "backfill",
        "legacy-dependency-backfill:v3",
        "open",
      );
      const effectiveKey = (item: NarrativeMaintenanceRequest): string =>
        canonicalNarrativeMaintenanceWorkKey({
          ...item,
          semanticEpochId: "epoch-adopted-race",
        });
      const firstCycle = deferred<NarrativeMaintenanceCycleResult>();
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockImplementationOnce(() => firstCycle.promise)
        .mockResolvedValue({ status: "accepted", hasMore: false });
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) =>
          JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          }),
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
        const firstCancellation =
          cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: firstCancellation ? "interrupted" : "succeeded",
          stopReason: firstCancellation ? "workspace-generation-changed" : null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: firstCancellation ? null : binding.generation,
          works: firstCancellation
            ? [
                { workKey: effectiveKey(firstWork), status: "succeeded" },
                { workKey: effectiveKey(secondWork), status: "interrupted" },
              ]
            : [{ workKey: effectiveKey(secondWork), status: "succeeded" }],
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      });
      const { scheduler } = createScheduler({
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
      });

      scheduler.request(firstWork);
      scheduler.request(secondWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

      const quiescing = scheduler.quiesceForWorkspaceSwitch?.();
      for (
        let turn = 0;
        turn < 6 && cancelNarrativeMaintenanceAttempt.mock.calls.length === 0;
        turn += 1
      ) {
        await Promise.resolve();
      }
      expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();

      if (cycleOutcome === "resolved") {
        firstCycle.resolve(acceptedCycle());
      } else {
        firstCycle.reject(new Error("cycle rejected after receipt adoption"));
      }
      const lease = await quiescing;
      lease?.resume();
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].work).toEqual([
        expect.objectContaining({
          projectId: secondWork.projectId,
          runKind: secondWork.runKind,
          workKey: secondWork.workKey,
          semanticEpochId: null,
        }),
      ]);
      expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["resolved", "rejected"] as const)(
    "does not requeue a cycle after quiesce adopts a succeeded receipt before the cycle is %s",
    async (cycleOutcome) => {
      const binding = {
        authorityId: `authority-adopted-success-${cycleOutcome}`,
        generation: 6,
      };
      const firstWork = work(
        `project-adopted-success-a-${cycleOutcome}`,
        "backfill",
        "legacy-dependency-backfill:v3",
        "open",
      );
      const secondWork = work(
        `project-adopted-success-b-${cycleOutcome}`,
        "backfill",
        "legacy-dependency-backfill:v3",
        "open",
      );
      const effectiveKey = (item: NarrativeMaintenanceRequest): string =>
        canonicalNarrativeMaintenanceWorkKey({
          ...item,
          semanticEpochId: "epoch-adopted-success",
        });
      const firstCycle = deferred<NarrativeMaintenanceCycleResult>();
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockImplementationOnce(() => firstCycle.promise)
        .mockResolvedValue({ status: "accepted", hasMore: false });
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) =>
          JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          }),
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
        JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: "succeeded",
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: binding.generation,
          works: [
            { workKey: effectiveKey(firstWork), status: "succeeded" },
            { workKey: effectiveKey(secondWork), status: "succeeded" },
          ],
          cleanup: { status: "clean" },
          connectionReusable: true,
        }),
      );
      const { scheduler } = createScheduler({
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
      });

      scheduler.request(firstWork);
      scheduler.request(secondWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

      const quiescing = scheduler.quiesceForWorkspaceSwitch?.();
      for (
        let turn = 0;
        turn < 6 && cancelNarrativeMaintenanceAttempt.mock.calls.length === 0;
        turn += 1
      ) {
        await Promise.resolve();
      }
      expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();

      if (cycleOutcome === "resolved") {
        firstCycle.resolve(acceptedCycle());
      } else {
        firstCycle.reject(new Error("cycle rejected after success receipt adoption"));
      }
      const lease = await quiescing;
      lease?.resume();
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
      await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS);

      // The adopted Native success already crossed the durable completion
      // boundary. A late cycle response must not make the claimed batch run
      // again on the resumed lease.
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    },
  );

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
    const firstReceipt = await cancellation;
    expect(firstReceipt).toMatchObject({
      attemptId: "attempt-direct-cancel",
      state: "interrupted",
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      "attempt-direct-cancel",
      "closed",
    );
    const secondReceipt = await scheduler.cancelNarrativeMaintenanceAttempt?.(
      "attempt-direct-cancel",
      "closed",
    );
    expect(secondReceipt).toBe(firstReceipt);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shares one Native cancel when cycle completion races workspace quiescence", async () => {
    const binding = { authorityId: "authority-cancel-race", generation: 16 };
    const cancelReceipt = deferred<string>();
    const begin = vi.fn((attemptId: string) =>
      JSON.stringify({
        status: "open",
        attemptId,
        authorityId: binding.authorityId,
        generation: binding.generation,
      }),
    );
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(acceptedCycle());
    const cancel = vi.fn((_attemptId: string) => cancelReceipt.promise);
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt: begin,
      cancelNarrativeMaintenanceAttempt: cancel,
    });
    scheduler.request(
      work("project-cancel-race", "backfill", "backfill:v2", "open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();

    const quiescing = scheduler.quiesceForWorkspaceSwitch?.();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();

    const attemptId = cancel.mock.calls[0]?.[0];
    cancelReceipt.resolve(
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
    await expect(quiescing).resolves.toBeDefined();
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
    // The failed receipt is terminal evidence. Workspace-switch quiescence
    // may reuse the same receipt, but ordinary maintenance must not retry the
    // quarantined attempt in a hot loop.
    expect(cancel.mock.calls.length).toBe(1);
  });

  it("allows a successful workspace swap to discard a failed cleanup receipt", async () => {
    const binding = { authorityId: "authority-swap-after-failure", generation: 3 };
    const begin = vi.fn((attemptId: string) =>
      JSON.stringify({
        status: "open",
        attemptId,
        authorityId: binding.authorityId,
        generation: binding.generation,
      }),
    );
    const cancel = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "workspace-generation-changed",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "failed", error: "rollback failed" },
        connectionReusable: false,
      }),
    );
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: begin,
      cancelNarrativeMaintenanceAttempt: cancel,
    });

    await scheduler.beginNarrativeMaintenanceAttempt?.("manual-failed", binding);
    await expect(
      scheduler.cancelNarrativeMaintenanceAttempt?.(
        "manual-failed",
        "workspace-generation-changed",
      ),
    ).resolves.toMatchObject({
      state: "interrupted",
      connectionReusable: false,
    });

    const lease = await scheduler.quiesceForWorkspaceSwitch?.();
    expect(lease).toBeDefined();
    lease?.resume(true);
    await expect(scheduler.dispose()).resolves.toBeUndefined();
  });

  it("retires the failed delivery only after recovery proof is acknowledged", async () => {
    const failedBinding = {
      authorityId: "authority-failed-delivery",
      generation: 7,
    };
    const recoveredBinding = {
      authorityId: "authority-recovered-delivery",
      generation: 8,
    };
    const workItem = work(
      "project-failed-delivery",
      "backfill",
      "backfill:v2",
      "open",
    );
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "workspace-unavailable",
    });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, binding: typeof failedBinding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: binding.authorityId,
          generation: binding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "closed",
        generation: failedBinding.generation,
        workspaceBinding: failedBinding,
        publishedGeneration: null,
        works: [
          {
            workKey: canonicalNarrativeMaintenanceWorkKey(workItem),
            status: "failed",
            error: "rollback failed",
          },
        ],
        cleanup: { status: "failed", error: "rollback failed" },
        connectionReusable: false,
      }),
    );
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "none" })
      .mockResolvedValue({
        status: "reconciled",
        descriptorId: 91,
        reason: "maintenance-recovery-complete",
        recoveredBinding: failedBinding,
        activeBinding: recoveredBinding,
        reboundBinding: recoveredBinding,
      });
    const ackNarrativeMaintenanceRecovery = vi.fn().mockResolvedValue({
      status: "acknowledged",
      descriptorId: 91,
      acknowledged: true,
    });
    const ackNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
      status: "retired",
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => recoveredBinding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      reconcileNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceDelivery,
    });

    scheduler.requestWithBinding(workItem, failedBinding);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);
    expect(
      ackNarrativeMaintenanceRecovery.mock.invocationCallOrder[0],
    ).toBeLessThan(ackNarrativeMaintenanceDelivery.mock.invocationCallOrder[0]!);
  });

  it("retains failed-delivery ownership when the recovery ACK must be retried", async () => {
    const failedBinding = {
      authorityId: "authority-recovery-ack-retry",
      generation: 11,
    };
    const recoveredBinding = {
      authorityId: "authority-recovery-ack-retry-new",
      generation: 12,
    };
    const workItem = work(
      "project-recovery-ack-retry",
      "backfill",
      "backfill:v2",
      "open",
    );
    const rediscoveredWork = {
      ...workItem,
      reason: "rediscovered-after-recovery",
    };
    const cycleRequests: NarrativeMaintenanceCycleRequest[] = [];
    const runNarrativeMaintenanceCycle = vi.fn(
      (request: NarrativeMaintenanceCycleRequest) => {
        cycleRequests.push(request);
        return Promise.resolve(
          cycleRequests.length === 1
            ? {
                status: "workspace-unavailable" as const,
                reason: "maintenance-workspace-changed-during-cycle",
              }
            : acceptedCycle(),
        );
      },
    );
    const attemptBindings = new Map<string, typeof failedBinding>();
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, binding: typeof failedBinding) => {
        attemptBindings.set(attemptId, binding);
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: binding.authorityId,
          generation: binding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const binding = attemptBindings.get(attemptId)!;
      const failedCleanup = cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: failedCleanup ? "interrupted" : "succeeded",
        stopReason: failedCleanup ? "closed" : null,
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: failedCleanup ? null : binding.generation,
        works: failedCleanup
          ? []
          : [
              {
                workKey: canonicalNarrativeMaintenanceWorkKey(rediscoveredWork),
                status: "succeeded",
              },
            ],
        cleanup: failedCleanup
          ? { status: "failed", error: "rollback failed" }
          : { status: "clean" },
        connectionReusable: !failedCleanup,
      });
    });
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "none" })
      .mockResolvedValueOnce({
        status: "reconciled",
        descriptorId: 92,
        reason: "maintenance-recovery-complete",
        recoveredBinding: failedBinding,
        activeBinding: recoveredBinding,
        reboundBinding: recoveredBinding,
      })
      .mockResolvedValueOnce({
        status: "reconciled",
        descriptorId: 92,
        reason: "maintenance-recovery-complete",
        recoveredBinding: failedBinding,
        activeBinding: recoveredBinding,
        reboundBinding: recoveredBinding,
      })
      .mockResolvedValue({ status: "none" });
    const ackNarrativeMaintenanceRecovery = vi
      .fn()
      .mockRejectedValueOnce(new Error("recovery ACK temporarily unavailable"))
      .mockResolvedValue({
        status: "acknowledged",
        descriptorId: 92,
        acknowledged: true,
      });
    const ackNarrativeMaintenanceDelivery = vi.fn().mockResolvedValue({
      status: "retired",
    });
    let scheduler!: ReturnType<typeof createNarrativeMaintenanceScheduler>;
    const onWorkspaceBindingMismatch = vi.fn();
    const onCompletionRecoveryAcknowledged = vi.fn((currentBinding) => {
      scheduler.requestWithBinding(rediscoveredWork, currentBinding);
    });
    scheduler = createScheduler(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => recoveredBinding,
        runNarrativeMaintenanceCycle,
        beginNarrativeMaintenanceAttempt,
        cancelNarrativeMaintenanceAttempt,
        reconcileNarrativeMaintenanceRecovery,
        ackNarrativeMaintenanceRecovery,
        ackNarrativeMaintenanceDelivery,
      },
      vi.fn(),
      { onWorkspaceBindingMismatch, onCompletionRecoveryAcknowledged },
    ).scheduler;

    scheduler.requestWithBinding(workItem, failedBinding);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(ackNarrativeMaintenanceRecovery).not.toHaveBeenCalled();
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledTimes(2);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledWith(1);
    expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();
    expect(onCompletionRecoveryAcknowledged).toHaveBeenCalledExactlyOnceWith(
      recoveredBinding,
    );
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(cycleRequests[1]?.workspaceBinding).toEqual(recoveredBinding);
    expect(cycleRequests[1]?.work).toEqual([
      expect.objectContaining({
        workKey: rediscoveredWork.workKey,
        reasons: [rediscoveredWork.reason],
      }),
    ]);
  });

  it.each(["pump", "target-open"])("clears %s recovery ownership after a later retry retires the old delivery", async (recoveryPath) => {
    const failedBinding = {
      authorityId: "authority-delivery-ack-retry",
      generation: 21,
    };
    const recoveredBinding = {
      authorityId: "authority-delivery-ack-retry-new",
      generation: 22,
    };
    const workItem = work(
      "project-delivery-ack-retry",
      "backfill",
      "backfill:v2",
      "open",
    );
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "workspace-unavailable",
    });
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, binding: typeof failedBinding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: binding.authorityId,
          generation: binding.generation,
        }),
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "closed",
        generation: failedBinding.generation,
        workspaceBinding: failedBinding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "failed", error: "rollback failed" },
        connectionReusable: false,
      }),
    );
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "none" })
      .mockResolvedValueOnce({
        status: "reconciled",
        descriptorId: 93,
        reason: "maintenance-recovery-complete",
        recoveredBinding: failedBinding,
        activeBinding: recoveredBinding,
        reboundBinding: recoveredBinding,
      })
      .mockResolvedValue({ status: "none" });
    const ackNarrativeMaintenanceRecovery = vi.fn().mockResolvedValue({
      status: "acknowledged",
      descriptorId: 93,
      acknowledged: true,
    });
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "retired" });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => recoveredBinding,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      reconcileNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceDelivery,
    });

    scheduler.requestWithBinding(workItem, failedBinding);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    if (recoveryPath === "target-open") {
      await scheduler.quiesceForWorkspaceSwitch?.();
      await scheduler.reconcileRecoveryBeforeWorkspaceOpen?.("/target");
      expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenLastCalledWith("/target");
    } else {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledOnce();

    // The recovery proof is already ACKed, but the old delivery ACK failed.
    // dispose() must retry that exact sequence and release the marker only
    // after the transport record is retired.
    await expect(scheduler.dispose()).resolves.toBeUndefined();
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledTimes(2);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenLastCalledWith(1);
  });

  it("shares admission between a manual attempt and the automatic queue", async () => {
    const binding = { authorityId: "authority-shared-admission", generation: 4 };
    const begin = vi.fn((attemptId: string) =>
      JSON.stringify({
        status: "open",
        attemptId,
        authorityId: binding.authorityId,
        generation: binding.generation,
      }),
    );
    const cancel = vi.fn((attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "cancelled",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: begin,
      cancelNarrativeMaintenanceAttempt: cancel,
      runNarrativeMaintenanceCycle,
    });

    await scheduler.beginNarrativeMaintenanceAttempt?.(
      "manual-held",
      binding,
    );
    scheduler.request(
      work("project-shared-admission", "backfill", "auto-work", "timer"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
    expect(scheduler.getQuiescenceState?.().queueIdle).toBe(false);
    expect(scheduler.getQuiescenceState?.().inFlight).toBe(true);

    await scheduler.cancelNarrativeMaintenanceAttempt?.(
      "manual-held",
      "cancelled",
    );
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toEqual([
      expect.objectContaining({
        projectId: "project-shared-admission",
        workKey: "auto-work",
      }),
    ]);
    expect(cancel).toHaveBeenCalledWith(
      "manual-held",
      "cancelled",
    );
    expect(cancel).toHaveBeenCalledWith(
      expect.any(String),
      "closed",
    );
  });

  it("reschedules the automatic queue after a pending manual begin rejects", async () => {
    const binding = { authorityId: "authority-begin-retry", generation: 6 };
    const manualBegin = deferred<string>();
    const begin = vi
      .fn()
      .mockImplementationOnce(() => manualBegin.promise)
      .mockImplementation((attemptId: string, receivedBinding: typeof binding) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        }),
      );
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
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: begin,
      cancelNarrativeMaintenanceAttempt: cancel,
      runNarrativeMaintenanceCycle,
    });

    const manualRegistration = scheduler.beginNarrativeMaintenanceAttempt?.(
      "manual-begin-retry",
      binding,
    );
    scheduler.request(
      work("project-begin-retry", "backfill", "auto-work", "timer"),
    );
    scheduler.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();

    manualBegin.reject(new Error("injected begin rejection"));
    await expect(manualRegistration).rejects.toThrow("injected begin rejection");

    // The timer fired while the manual registration was pending.  No new
    // enqueue or external wake is allowed to be required for the retained
    // automatic work to resume.
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toEqual([
      expect.objectContaining({
        projectId: "project-begin-retry",
        workKey: "auto-work",
      }),
    ]);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a manual attempt while scheduler admission is quiescing", async () => {
    const binding = { authorityId: "authority-quiescing-admission", generation: 5 };
    const begin = vi.fn((attemptId: string) =>
      JSON.stringify({
        status: "open",
        attemptId,
        authorityId: binding.authorityId,
        generation: binding.generation,
      }),
    );
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: begin,
    });

    const lease = await scheduler.quiesceForWorkspaceSwitch?.();
    expect(lease).toBeDefined();
    await expect(
      scheduler.beginNarrativeMaintenanceAttempt?.(
        "manual-during-quiesce",
        binding,
      ),
    ).rejects.toThrow(/NEX_MAINTENANCE_ATTEMPT_ADMISSION_CLOSED/);
    lease?.resume();
    expect(begin).not.toHaveBeenCalled();
  });
});
