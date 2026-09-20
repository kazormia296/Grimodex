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
});
