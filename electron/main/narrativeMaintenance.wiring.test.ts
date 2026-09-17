import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS,
  type NarrativeMaintenanceCycleResult,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";

const ERROR_RETRY_DELAY_MS = 1_000;

type WorkspaceBinding = { authorityId: string; generation: number };

type WiringScheduler = NarrativeMaintenanceScheduler & {
  requestWithBinding(
    work: NarrativeMaintenanceRequest,
    binding: WorkspaceBinding,
  ): void;
};

function backfill(projectId = "project-1"): NarrativeMaintenanceRequest {
  return {
    projectId,
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v3",
    reason: "workspace-opened",
  };
}

function accepted(): NarrativeMaintenanceCycleResult {
  return { status: "accepted", hasMore: false };
}

describe("narrative maintenance main-only wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the discovery binding instead of reacquiring a binding at enqueue time", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => ({
        authorityId: "reacquired",
        generation: 99,
      }),
      runNarrativeMaintenanceCycle,
    }) as WiringScheduler;
    const binding = { authorityId: "pinned", generation: 7 };

    scheduler.requestWithBinding(backfill(), binding);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledWith({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "legacy-dependency-backfill:v3",
          semanticEpochId: null,
          reasons: ["workspace-opened"],
        },
      ],
      wakeProjectIds: [],
      workspaceBinding: binding,
    });
    scheduler.dispose();
  });

  it("allows Verify and Rebuild items to receive an accepted cycle", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const warn = vi.fn();
    const scheduler = createNarrativeMaintenanceScheduler(
      { runNarrativeMaintenanceCycle },
      { warn },
    );

    scheduler.request({
      projectId: "project-1",
      runKind: "dependency-verify",
      workKey: "dependency-verify:epoch-1",
      semanticEpochId: "epoch-1",
      reason: "restore-completed",
    });
    scheduler.request({
      projectId: "project-1",
      runKind: "semantic-index-rebuild",
      workKey: "dependency-rebuild-derived",
      semanticEpochId: "epoch-1",
      reason: "verify-required-rebuild",
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("dispatches a mixed Backfill, Verify, and Rebuild batch without parking enabled kinds", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill("project-mixed"));
    scheduler.request({
      projectId: "project-mixed",
      runKind: "dependency-verify",
      workKey: "dependency-verify:epoch-mixed",
      semanticEpochId: "epoch-mixed",
      reason: "backfill-completed",
    });
    scheduler.request({
      projectId: "project-mixed",
      runKind: "semantic-index-rebuild",
      workKey: "dependency-rebuild-derived",
      semanticEpochId: "epoch-mixed",
      reason: "verify-required-rebuild",
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toHaveLength(
      3,
    );
    scheduler.dispose();
  });

  it("validates a complete exact-binding discovery batch before mutating the queue", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });
    const binding = { authorityId: "pinned", generation: 7 };

    expect(() =>
      scheduler.requestManyWithBinding(
        [
          backfill("project-atomic"),
          {
            projectId: "project-atomic",
            runKind: "repair" as never,
            workKey: "repair",
            semanticEpochId: null,
            reason: "forged",
          },
        ],
        binding,
      ),
    ).toThrow();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
    expect(() =>
      scheduler.requestWithBinding(backfill("project-null"), null as never),
    ).toThrow();
    scheduler.dispose();
  });

  it("notifies the coordinator to rediscover after an authority mismatch without consuming retry budget", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "workspace-unavailable",
      reason: "maintenance-workspace-binding-mismatch",
    });
    const onWorkspaceBindingMismatch = vi.fn();
    const scheduler = createNarrativeMaintenanceScheduler(
      { runNarrativeMaintenanceCycle },
      { onWorkspaceBindingMismatch, warn: vi.fn() } as never,
    );

    scheduler.request(backfill());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it.each([
    [
      "a rejected begin binding",
      (_attemptId: string) =>
        new Error("NEX_MAINTENANCE_ATTEMPT_BINDING_MISMATCH: stale workspace"),
    ],
    [
      "a stale begin receipt",
      (attemptId: string) =>
        JSON.stringify({
          status: "open",
          attemptId,
          authorityId: "authority-stale",
          generation: 99,
        }),
    ],
  ])(
    "parks a durable wake and rediscoveries after %s",
    async (_label, staleBegin) => {
      const binding = { authorityId: "authority-current", generation: 3 };
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce({ status: "accepted", hasMore: true })
        .mockResolvedValue(accepted());
      let beginCount = 0;
      const beginNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string, receivedBinding: typeof binding) => {
          beginCount += 1;
          if (beginCount === 2) {
            const stale = staleBegin(attemptId);
            if (stale instanceof Error) return Promise.reject(stale);
            return stale;
          }
          return JSON.stringify({
            status: "open",
            attemptId,
            authorityId: receivedBinding.authorityId,
            generation: receivedBinding.generation,
          });
        },
      );
      const cancelNarrativeMaintenanceAttempt = vi.fn(
        (attemptId: string) =>
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
      const onWorkspaceBindingMismatch = vi.fn();
      const scheduler = createNarrativeMaintenanceScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => binding,
          runNarrativeMaintenanceCycle,
          beginNarrativeMaintenanceAttempt,
          cancelNarrativeMaintenanceAttempt,
        },
        { onWorkspaceBindingMismatch, warn: vi.fn() },
      ) as WiringScheduler;

      scheduler.requestWithBinding(
        backfill("project-stale-begin"),
        binding,
      );
      scheduler.start();
      await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);
      await vi.advanceTimersByTimeAsync(10);

      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();
      expect(scheduler.getQuiescenceState?.().timerScheduled).toBe(false);

      // The stale durable wake is parked with the old binding; it must not
      // block forever behind the generic retry timer while rediscovery runs.
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      await scheduler.dispose();
    },
  );

  it.each(["requestWithBinding", "requestManyWithBinding"] as const)(
    "%s cannot reopen admission during workspace quiescence",
    async (method) => {
      const binding = { authorityId: "authority-quiescing", generation: 4 };
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValue(accepted());
      const scheduler = createNarrativeMaintenanceScheduler({
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle,
      }) as WiringScheduler;
      const queued = backfill("project-quiescing");

      scheduler.request(queued);
      scheduler.start();
      const lease = await scheduler.quiesceForWorkspaceSwitch?.();

      if (method === "requestWithBinding") {
        scheduler.requestWithBinding(queued, binding);
      } else {
        scheduler.requestManyWithBinding([queued], binding);
      }
      expect(scheduler.getQuiescenceState?.().timerScheduled).toBe(false);
      await vi.advanceTimersByTimeAsync(
        NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS + ERROR_RETRY_DELAY_MS,
      );
      expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();

      lease?.resume();
      expect(scheduler.getQuiescenceState?.().timerScheduled).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      await scheduler.dispose();
    },
  );
});
