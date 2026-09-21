import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_MAX_RETRIES,
  type NarrativeMaintenanceCycleResult,
  type NarrativeMaintenanceRequest,
} from "./narrativeMaintenance.js";

const INITIAL_DELAY_MS = 250;
const BACKLOG_DELAY_MS = 10;
const ERROR_RETRY_DELAY_MS = 1_000;

function backfill(
  projectId: string,
  suffix: string,
): NarrativeMaintenanceRequest {
  return {
    projectId,
    runKind: "backfill",
    workKey: `legacy-dependency-backfill:${suffix}`,
    reason: "reacceptance-test",
  };
}

function verify(
  projectId: string,
  suffix: string,
): NarrativeMaintenanceRequest {
  return {
    projectId,
    runKind: "dependency-verify",
    workKey: `dependency-verify:${suffix}`,
    semanticEpochId: `epoch-${suffix}`,
    reason: "reacceptance-test",
  };
}

function accepted(hasMore = false): NarrativeMaintenanceCycleResult {
  return { status: "accepted", hasMore };
}

function acceptedFailureReceiptBackend() {
  return {
    recordNarrativeMaintenanceDeliveryFailure: vi.fn().mockResolvedValue({
      status: "accepted",
      receiptId: "reacceptance-delivery-failure-test",
    }),
  };
}

function binding(authorityId: string, generation: number) {
  return { authorityId, generation };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("narrative maintenance reacceptance boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([33, 65])(
    "chunks %i pending work before project claim and retains unsent work",
    async (count) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValue(accepted());
      const scheduler = createNarrativeMaintenanceScheduler({
        runNarrativeMaintenanceCycle,
      });

      for (let index = 0; index < count; index += 1) {
        scheduler.request(backfill("chunk-project", String(index)));
      }
      scheduler.start();

      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toHaveLength(
        32,
      );
      expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workKey: `legacy-dependency-backfill:32` }),
        ]),
      );

      for (let sent = 32; sent < count; sent += 32) {
        await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
        expect(
          runNarrativeMaintenanceCycle.mock.calls[sent / 32]?.[0].work.length,
        ).toBe(Math.min(32, count - sent));
      }
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
        Math.ceil(count / 32),
      );
      scheduler.dispose();
    },
  );

  it("runs descriptor recovery preflight before begin or delivery admission", async () => {
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "reconciled" })
      .mockResolvedValue({ status: "none" });
    const beginNarrativeMaintenanceAttempt = vi.fn();
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      reconcileNarrativeMaintenanceRecovery,
      beginNarrativeMaintenanceAttempt,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill("recovery-preflight", "first"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    expect(beginNarrativeMaintenanceAttempt).not.toHaveBeenCalled();
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("starts the descriptor recovery pump even when ordinary delivery is idle", async () => {
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValue({ status: "none" });
    const scheduler = createNarrativeMaintenanceScheduler({
      reconcileNarrativeMaintenanceRecovery,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("drains a recovery descriptor before disposing for Native shutdown", async () => {
    const recoveredBinding = {
      authorityId: "authority-shutdown-recovery",
      generation: 4,
    };
    const activeBinding = {
      authorityId: "authority-shutdown-recovery-reopened",
      generation: 5,
    };
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({
        status: "reconciled",
        descriptorId: 104,
        reason: "maintenance-recovery-complete",
        recoveredBinding,
        activeBinding,
        reboundBinding: activeBinding,
      })
      .mockResolvedValue({ status: "none" });
    const ackNarrativeMaintenanceRecovery = vi.fn().mockResolvedValue({
      status: "acknowledged",
      descriptorId: 104,
      acknowledged: true,
    });
    const scheduler = createNarrativeMaintenanceScheduler({
      reconcileNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceRecovery,
    });

    await expect(scheduler.dispose()).resolves.toBeUndefined();
    expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledTimes(2);
    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledWith("104");
  });

  it("reschedules work enqueued during an idle recovery preflight", async () => {
    const preflight = deferred<{ status: "none" }>();
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockReturnValueOnce(preflight.promise)
      .mockResolvedValue({ status: "none" });
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      reconcileNarrativeMaintenanceRecovery,
      runNarrativeMaintenanceCycle,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();

    // The idle cycle still owns its slot while the preflight is pending, so
    // this request cannot schedule a competing timer.  The cycle's release
    // path must notice it after `none` is returned.
    scheduler.request(backfill("idle-preflight-enqueue", "queued"));
    preflight.resolve({ status: "none" });
    await vi.advanceTimersByTimeAsync(0);
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toEqual([
      expect.objectContaining({
        projectId: "idle-preflight-enqueue",
        workKey: "legacy-dependency-backfill:queued",
      }),
    ]);
    scheduler.dispose();
  });

  it("serializes Open target drains and keeps a failed target from poisoning the next", async () => {
    const firstRecovery = deferred<{ status: "none" }>();
    const reconcileNarrativeMaintenanceRecovery = vi.fn()
      .mockReturnValueOnce(firstRecovery.promise)
      .mockResolvedValue({ status: "none" });
    const scheduler = createNarrativeMaintenanceScheduler({ reconcileNarrativeMaintenanceRecovery });
    const lease = await scheduler.quiesceForWorkspaceSwitch?.();
    const first = scheduler.reconcileRecoveryBeforeWorkspaceOpen?.("/W1");
    const firstRejected = expect(first).rejects.toThrow("W1 unavailable");
    const second = scheduler.reconcileRecoveryBeforeWorkspaceOpen?.("/W2");
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileNarrativeMaintenanceRecovery.mock.calls).toEqual([["/W1"]]);
    firstRecovery.reject(new Error("W1 unavailable"));
    await firstRejected;
    await expect(second).resolves.toBeUndefined();
    expect(reconcileNarrativeMaintenanceRecovery.mock.calls).toEqual([["/W1"], ["/W2"]]);
    lease?.resume(false);
  });

  it("rediscovers the binding after descriptor reconciliation before retrying work", async () => {
    let currentBinding = binding("authority-before-recovery", 1);
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({
        status: "reconciled",
        descriptorId: 40,
        reason: "maintenance-recovery-complete",
        recoveredBinding: currentBinding,
        activeBinding: binding("authority-after-recovery", 2),
        reboundBinding: binding("authority-after-recovery", 2),
      })
      .mockResolvedValue({ status: "none" });
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
      reconcileNarrativeMaintenanceRecovery,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill("recovery-binding", "same-key"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    currentBinding = binding("authority-after-recovery", 2);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toMatchObject({
      workspaceBinding: currentBinding,
    });
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it.each([
    ["reboundBinding", (value: Record<string, unknown>) => delete value.reboundBinding],
    ["activeBinding", (value: Record<string, unknown>) => delete value.activeBinding],
    ["descriptorId", (value: Record<string, unknown>) => delete value.descriptorId],
    ["invalid descriptorId", (value: Record<string, unknown>) => { value.descriptorId = -1; }],
  ])(
    "keeps a completion receipt with missing %s replayable",
    async (_missingField, removeField) => {
      const w1 = binding("authority-before-incomplete-proof", 1);
      const w2 = binding("authority-after-incomplete-proof", 2);
      const recovery: Record<string, unknown> = {
        status: "reconciled",
        descriptorId: 43,
        reason: "maintenance-recovery-complete",
        recoveredBinding: w1,
        activeBinding: w2,
        reboundBinding: null,
      };
      removeField(recovery);
      const reconcileNarrativeMaintenanceRecovery = vi
        .fn()
        .mockResolvedValueOnce(recovery)
        .mockResolvedValueOnce(recovery)
        .mockResolvedValue({ status: "none" });
      const ackNarrativeMaintenanceRecovery = vi.fn();
      const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
      const scheduler = createNarrativeMaintenanceScheduler({
        reconcileNarrativeMaintenanceRecovery,
        ackNarrativeMaintenanceRecovery,
        runNarrativeMaintenanceCycle,
      });

      scheduler.requestWithBinding(
        backfill("incomplete-recovery-proof", String(_missingField)),
        w1,
      );
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

      expect(ackNarrativeMaintenanceRecovery).not.toHaveBeenCalled();
      expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
      expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledTimes(2);
      await expect(scheduler.dispose()).resolves.toBeUndefined();
      expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledTimes(3);
    },
  );

  it("applies recovery proof to unclaimed retained work before ACK", async () => {
    const w1 = binding("authority-before-recovery", 1);
    const w2 = binding("authority-after-recovery", 2);
    const blockedCompletion = deferred<NarrativeMaintenanceCycleResult>();
    const blockedRun = vi.fn().mockReturnValue(blockedCompletion.promise);
    const blockedScheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle: blockedRun,
    });
    blockedScheduler.requestWithBinding(
      backfill("recovery-partial-claim", "blocker"),
      w1,
    );
    blockedScheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(blockedRun).toHaveBeenCalledOnce();

    const events: string[] = [];
    const ackNarrativeMaintenanceRecovery = vi.fn().mockImplementation(() => {
      events.push("ack");
      return { status: "acknowledged", descriptorId: 41, acknowledged: true };
    });
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("reconcile");
        return {
          status: "reconciled",
          descriptorId: 41,
          reason: "maintenance-recovery-complete",
          recoveredBinding: w1,
          activeBinding: w2,
          reboundBinding: w2,
        };
      })
      .mockResolvedValue({ status: "none" });
    const runNarrativeMaintenanceCycle = vi.fn().mockImplementation(() => {
      events.push("run");
      return Promise.resolve(accepted());
    });
    const scheduler = createNarrativeMaintenanceScheduler({
      reconcileNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceRecovery,
      runNarrativeMaintenanceCycle,
    });
    scheduler.requestManyWithBinding(
      [
        backfill("recovery-partial-claim", "blocked-retained"),
        backfill("recovery-partial-claim-free", "free-retained"),
      ],
      w1,
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    // The first scheduler owns the shared project, so this scheduler can
    // claim only the free project. Recovery must still rebind both retained
    // entries before the Native receipt is acknowledged.
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
    expect(events).toEqual(["reconcile", "ack"]);
    expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce();

    blockedCompletion.resolve(accepted());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toMatchObject({
      workspaceBinding: w2,
      work: expect.arrayContaining([
        expect.objectContaining({
          projectId: "recovery-partial-claim-free",
        }),
        expect.objectContaining({
          projectId: "recovery-partial-claim",
        }),
      ]),
    });
    expect(events.indexOf("ack")).toBeLessThan(events.indexOf("run"));

    await blockedScheduler.dispose();
    await scheduler.dispose();
  });

  it("rebinding retained work precedes ACK in the cleanup-failed recovery pump", async () => {
    const w1 = binding("authority-before-cleanup-failure", 1);
    const w2 = binding("authority-after-cleanup-recovery", 2);
    const events: string[] = [];
    const attempts = new Map<string, typeof w1>();
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof w1) => {
        attempts.set(attemptId, receivedBinding);
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: receivedBinding.authorityId,
          generation: receivedBinding.generation,
        });
      },
    );
    const cancelNarrativeMaintenanceAttempt = vi.fn((attemptId: string) => {
      const receivedBinding = attempts.get(attemptId) ?? w1;
      const cleanupFailed = cancelNarrativeMaintenanceAttempt.mock.calls.length === 1;
      return JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: cleanupFailed ? "interrupted" : "succeeded",
        stopReason: cleanupFailed ? "closed" : null,
        generation: receivedBinding.generation,
        workspaceBinding: receivedBinding,
        publishedGeneration: null,
        works: [],
        cleanup: cleanupFailed
          ? { status: "failed", error: "rollback failed" }
          : { status: "clean" },
        connectionReusable: !cleanupFailed,
      });
    });
    let scheduler!: ReturnType<typeof createNarrativeMaintenanceScheduler>;
    const reconcileNarrativeMaintenanceRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "none" })
      .mockImplementationOnce(() => {
        events.push("reconcile");
        return {
          status: "reconciled",
          descriptorId: 52,
          reason: "maintenance-recovery-complete",
          recoveredBinding: w1,
          activeBinding: w2,
          reboundBinding: w2,
        };
      })
      .mockResolvedValue({ status: "none" });
    const ackNarrativeMaintenanceRecovery = vi.fn().mockImplementation(() => {
      events.push("ack");
      return { status: "acknowledged", descriptorId: 52, acknowledged: true };
    });
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("run-1");
        scheduler.requestWithBinding(
          backfill("cleanup-recovery-retained", "queued-during-run"),
          w1,
        );
        return Promise.resolve(accepted());
      })
      .mockImplementation(() => {
        events.push("run-2");
        return Promise.resolve(accepted());
      });
    scheduler = createNarrativeMaintenanceScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => w1,
      reconcileNarrativeMaintenanceRecovery,
      ackNarrativeMaintenanceRecovery,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt,
      runNarrativeMaintenanceCycle,
    });
    scheduler.requestWithBinding(
      backfill("cleanup-recovery-initial", "initial"),
      w1,
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(events).toEqual(["run-1"]);

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(events).toEqual(["run-1", "reconcile", "ack"]);

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toMatchObject({
      workspaceBinding: w2,
      work: expect.arrayContaining([
        expect.objectContaining({
          projectId: "cleanup-recovery-retained",
          workKey: "legacy-dependency-backfill:queued-during-run",
        }),
      ]),
    });
    expect(events.indexOf("ack")).toBeLessThan(events.indexOf("run-2"));
    await scheduler.dispose();
  });

  it("keeps deferred work parked while an enabled item continues forward", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({ status: "deferred", hasMore: true })
      .mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    for (let index = 0; index < 32; index += 1) {
      scheduler.request(verify("deferred-project", String(index)));
    }
    scheduler.request(backfill("enabled-project", "forward"));
    scheduler.start();

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toHaveLength(
      32,
    );
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].work).toEqual([
      expect.objectContaining({
        projectId: "enabled-project",
        runKind: "backfill",
      }),
    ]);
    scheduler.dispose();
  });

  it("does not mix a durable wake with ordinary work", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(accepted(true))
      .mockResolvedValue(accepted(false));
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill("project-a", "has-more"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    scheduler.request(backfill("project-b", "arrived-before-wake"));
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toMatchObject({
      work: [expect.objectContaining({ projectId: "project-b" })],
      wakeProjectIds: [],
    });

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[2]?.[0]).toMatchObject({
      work: [],
      wakeProjectIds: ["project-a"],
    });
    scheduler.dispose();
  });

  it.each([null, 42])(
    "treats a present non-string status (%s) as malformed instead of legacy accepted",
    async (status) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce({ status, hasMore: false })
        .mockResolvedValue(accepted());
      const scheduler = createNarrativeMaintenanceScheduler({
        runNarrativeMaintenanceCycle,
      });

      scheduler.request(backfill("malformed-status", String(status)));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      scheduler.dispose();
    },
  );

  it("keeps replacement-authority work bound to its captured snapshot", async () => {
    let binding = { authorityId: "authority-one", generation: 1 };
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    });
    const request = backfill("bound-project", "same-key");

    scheduler.request(request);
    binding = { authorityId: "authority-two", generation: 2 };
    scheduler.request(request);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toMatchObject({
      workspaceBinding: { authorityId: "authority-one", generation: 1 },
    });
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toMatchObject({
      workspaceBinding: binding,
    });
    scheduler.dispose();
  });

  it("gives a replacement authority a fresh work retry budget for the same key", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(new Error("temporary A/B failure"));
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
      ...acceptedFailureReceiptBackend(),
    });
    const work = backfill("same-project", "same-key");

    scheduler.requestWithBinding(work, binding("authority-a", 1));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    // Keep A's failed work pending while the replacement authority arrives.
    scheduler.requestWithBinding(work, binding("authority-b", 2));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    const callsFor = (authorityId: string) =>
      runNarrativeMaintenanceCycle.mock.calls.filter(
        ([payload]) => payload.workspaceBinding?.authorityId === authorityId,
      );
    expect(callsFor("authority-a")).toHaveLength(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(callsFor("authority-b")).toHaveLength(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(callsFor("authority-b")[0]?.[0].workspaceBinding).toEqual(
      binding("authority-b", 2),
    );
    scheduler.dispose();
  });

  it("gives a replacement authority a fresh durable-wake retry budget for the same project", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockImplementation(
        async (payload: {
          workspaceBinding?: { authorityId: string };
          work: readonly unknown[];
        }) => {
          if (payload.work.length > 0) return accepted(true);
          throw new Error("temporary durable wake failure");
        },
      );
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
      ...acceptedFailureReceiptBackend(),
    });
    const work = backfill("same-project", "same-key");

    scheduler.requestWithBinding(work, binding("authority-a", 1));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    // A hasMore response creates an A-scoped durable wake. Let it fail once,
    // then enqueue the same durable key from the replacement authority.
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    scheduler.requestWithBinding(work, binding("authority-b", 2));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    const wakeCallsFor = (authorityId: string) =>
      runNarrativeMaintenanceCycle.mock.calls.filter(
        ([payload]) =>
          payload.workspaceBinding?.authorityId === authorityId &&
          payload.work.length === 0,
      );
    expect(wakeCallsFor("authority-a")).toHaveLength(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(wakeCallsFor("authority-b")).toHaveLength(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    scheduler.dispose();
  });

  it("keeps replacement work retry state when an old in-flight attempt fails", async () => {
    const oldCompletion = deferred<NarrativeMaintenanceCycleResult>();
    let authorityACalls = 0;
    const runNarrativeMaintenanceCycle = vi.fn(
      async (payload: { workspaceBinding?: { authorityId: string } }) => {
        if (payload.workspaceBinding?.authorityId === "authority-a") {
          authorityACalls += 1;
          if (authorityACalls === 2) {
            return oldCompletion.promise;
          }
        }
        throw new Error("replacement work failure");
      },
    );
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
      ...acceptedFailureReceiptBackend(),
    });
    const work = backfill("same-project", "in-flight-work-failure");
    scheduler.requestWithBinding(work, binding("authority-a", 1));
    scheduler.start();

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    scheduler.requestWithBinding(work, binding("authority-b", 2));
    oldCompletion.reject(new Error("old authority failed"));
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }
    const callsFor = (authorityId: string) =>
      runNarrativeMaintenanceCycle.mock.calls.filter(
        ([payload]) => payload.workspaceBinding?.authorityId === authorityId,
      );
    expect(callsFor("authority-a")).toHaveLength(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(callsFor("authority-b")).toHaveLength(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    scheduler.dispose();
  });

  it("retries a failed Native delivery ACK without redispatching the batch", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(accepted());
    let ackCalls = 0;
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockImplementation(async (sequence: number) => {
        ackCalls += 1;
        if (ackCalls === 1) {
          throw new Error("temporary ACK transport failure");
        }
        return { status: "retired", sequence };
      });
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
      ackNarrativeMaintenanceDelivery,
    });

    scheduler.request(backfill("ack-retry", "same-occurrence"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(1);
    const firstSequence = runNarrativeMaintenanceCycle.mock.calls[0]?.[0]
      .deliverySequence;
    expect(firstSequence).toBe(1);

    // The ACK-only timer wakes even though the ordinary queue is empty. It
    // retries the exact sequence and never calls Native cycle again.
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(ackNarrativeMaintenanceDelivery).toHaveBeenCalledTimes(2);
    expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual([
      [firstSequence],
      [firstSequence],
    ]);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(1);
    await scheduler.dispose();
  });

  it("assigns a new sequence to a new occurrence while the prior ACK is pending", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(accepted());
    let firstAckPending = true;
    const ackNarrativeMaintenanceDelivery = vi
      .fn()
      .mockImplementation(async (sequence: number) => {
        if (sequence === 1 && firstAckPending) {
          firstAckPending = false;
          throw new Error("temporary ACK transport failure");
        }
        return { status: "retired", sequence };
      });
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
      ackNarrativeMaintenanceDelivery,
    });
    const occurrence = backfill("ack-pending-new-occurrence", "same-key");

    scheduler.request(occurrence);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].deliverySequence).toBe(
      1,
    );

    // A new occurrence arrives before the ACK-only retry. It must receive a
    // fresh sequence and remain an independently dispatched queue item.
    scheduler.request(occurrence);
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].deliverySequence).toBe(
      2,
    );
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0].work).toHaveLength(
      1,
    );

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(ackNarrativeMaintenanceDelivery.mock.calls).toEqual([
      [1],
      [2],
      [1],
    ]);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    await scheduler.dispose();
  });
});
