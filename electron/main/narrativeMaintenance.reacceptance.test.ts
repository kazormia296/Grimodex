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

function backfill(projectId: string, suffix: string): NarrativeMaintenanceRequest {
  return {
    projectId,
    runKind: "backfill",
    workKey: `legacy-dependency-backfill:${suffix}`,
    reason: "reacceptance-test",
  };
}

function verify(projectId: string, suffix: string): NarrativeMaintenanceRequest {
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

function binding(authorityId: string, generation: number) {
  return { authorityId, generation };
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

  it("binds enqueue and redispatch to the latest authority snapshot", async () => {
    let binding = { authorityId: "authority-one", generation: 1 };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(accepted());
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
    });
    const work = backfill("same-project", "same-key");

    scheduler.requestWithBinding(work, binding("authority-a", 1));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    // Keep A's failed work pending while the replacement authority arrives.
    scheduler.requestWithBinding(work, binding("authority-b", 2));
    await vi.advanceTimersByTimeAsync(
      ERROR_RETRY_DELAY_MS * (NARRATIVE_MAINTENANCE_MAX_RETRIES + 1),
    );

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
    const runNarrativeMaintenanceCycle = vi.fn().mockImplementation(
      async (payload: { workspaceBinding?: { authorityId: string }; work: readonly unknown[] }) => {
        if (payload.work.length > 0) return accepted(true);
        throw new Error("temporary durable wake failure");
      },
    );
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });
    const work = backfill("same-project", "same-key");

    scheduler.requestWithBinding(work, binding("authority-a", 1));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    // A hasMore response creates an A-scoped durable wake. Let it fail once,
    // then enqueue the same durable key from the replacement authority.
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    scheduler.requestWithBinding(work, binding("authority-b", 2));
    await vi.advanceTimersByTimeAsync(
      ERROR_RETRY_DELAY_MS * (NARRATIVE_MAINTENANCE_MAX_RETRIES + 1) +
        BACKLOG_DELAY_MS * 4,
    );

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
});
