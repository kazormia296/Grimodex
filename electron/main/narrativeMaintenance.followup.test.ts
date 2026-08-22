import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceScheduler,
  type NarrativeMaintenanceRequest,
} from "./narrativeMaintenance.js";

const INITIAL_DELAY_MS = 250;
const BACKLOG_DELAY_MS = 10;

function work(reason: string): NarrativeMaintenanceRequest {
  return {
    projectId: "project-followup",
    runKind: "dependency-verify",
    workKey: "dependency-verify:epoch-followup",
    semanticEpochId: "epoch-followup",
    reason,
  };
}

describe("narrative maintenance deferred contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parks a typed deferred cycle without treating it as an ACK", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "deferred",
      hasMore: true,
    });
    const warn = vi.fn();
    const scheduler = createNarrativeMaintenanceScheduler(
      { runNarrativeMaintenanceCycle },
      { warn },
    );

    scheduler.request(work("verify-requested"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS * 10);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();

    scheduler.request(work("phase-join-opened"));
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toMatchObject({
      work: [
        expect.objectContaining({
          reasons: ["verify-requested", "phase-join-opened"],
        }),
      ],
      wakeProjectIds: [],
    });

    scheduler.dispose();
  });
});
