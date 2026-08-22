import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS,
  type NarrativeMaintenanceRequest,
} from "./narrativeMaintenance.js";

function backfill(reason = "workspace-open"): NarrativeMaintenanceRequest {
  return {
    projectId: "phase1-project",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    reason,
  };
}

describe("C2-5B Phase 1 main-only integration behavior", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers an automatic workspace wake as a typed main cycle", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledWith({
      work: [
        {
          projectId: "phase1-project",
          runKind: "backfill",
          workKey: "legacy-dependency-backfill:v2",
          semanticEpochId: null,
          reasons: ["workspace-open"],
        },
      ],
      wakeProjectIds: [],
    });
    scheduler.dispose();
  });

  it("rejects a human-only Repair wake at the executable scheduler boundary", () => {
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle: vi.fn(),
    });

    expect(() =>
      scheduler.request({
        ...backfill("must-not-repair"),
        runKind: "dependency-repair" as NarrativeMaintenanceRequest["runKind"],
      }),
    ).toThrow(/automatic|Repair|runKind/i);
    scheduler.dispose();
  });
});
