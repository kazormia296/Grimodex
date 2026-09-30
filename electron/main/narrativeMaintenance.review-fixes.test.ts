import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNarrativeMaintenanceScheduler } from "./narrativeMaintenance.js";
import {
  createNarrativeMaintenanceQuitFinalizer,
  runIndependentShutdownCleanups,
} from "./narrativeMaintenanceShutdown.js";

describe("PR600 independent shutdown cleanup", () => {
  it("attempts every teardown before fatal exit after permanent maintenance failure", async () => {
    const calls: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { entered = resolve; });
    const cleanupClosed = new Promise<void>((resolve) => { release = resolve; });
    const finalizer = createNarrativeMaintenanceQuitFinalizer({
      dispose: () => { calls.push("maintenance"); throw new Error("quarantined"); },
      complete: () => runIndependentShutdownCleanups([
        () => { calls.push("first"); throw new Error("first cleanup failed"); },
        async () => { calls.push("last"); entered(); await cleanupClosed; calls.push("closed"); },
      ]),
      quit: () => { calls.push("quit"); },
      exit: (code) => { calls.push(`exit:${code}`); },
      maxAttempts: 3,
    });
    const flight = finalizer({ preventDefault: vi.fn() });
    await cleanupStarted;
    expect(calls).toEqual(["maintenance", "maintenance", "maintenance", "first", "last"]);
    release();
    await flight;
    expect(calls).toEqual(["maintenance", "maintenance", "maintenance", "first", "last", "closed", "exit:1"]);
  });
});

describe("PR600 overlapping workspace switches", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([[0, 1], [1, 0]])(
    "retains admission until the last lease releases, order %s then %s",
    async (first, last) => {
      const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({ status: "accepted", hasMore: false });
      const scheduler = createNarrativeMaintenanceScheduler({ runNarrativeMaintenanceCycle });
      try {
        scheduler.request({
          projectId: "project-review-fixes", runKind: "backfill",
          workKey: "legacy-dependency-backfill:v3", reason: "workspace-opened",
        });
        scheduler.start();
        const leases = await Promise.all([
          scheduler.quiesceForWorkspaceSwitch?.(),
          scheduler.quiesceForWorkspaceSwitch?.(),
        ]);
        expect(leases[0]).toBeDefined();
        expect(leases[1]).toBeDefined();
        leases[first]?.resume();
        leases[first]?.resume();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
        expect(scheduler.getQuiescenceState?.().timerScheduled).toBe(false);
        scheduler.request({
          projectId: "project-review-fixes", runKind: "backfill",
          workKey: "legacy-dependency-backfill:v3", reason: "another-wake",
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
        leases[last]?.resume();
        await vi.advanceTimersByTimeAsync(10);
        expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      } finally {
        await scheduler.dispose();
      }
    },
  );
});
