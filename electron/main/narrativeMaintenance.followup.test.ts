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

  it("dispatches mixed work together once the native lane accepts all automatic kinds", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request({
      ...work("verify-requested"),
      projectId: "project-a",
    });
    scheduler.request({
      projectId: "project-b",
      runKind: "backfill",
      workKey: "legacy-dependency-backfill:v3",
      reason: "workspace-opened",
    });
    scheduler.request({
      projectId: "project-a",
      runKind: "backfill",
      workKey: "legacy-dependency-backfill:v3",
      reason: "workspace-opened",
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    const firstRequest = runNarrativeMaintenanceCycle.mock.calls[0]?.[0];
    expect(firstRequest?.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "project-a",
          runKind: "backfill",
        }),
        expect.objectContaining({
          projectId: "project-b",
          runKind: "backfill",
        }),
      ]),
    );
    expect(firstRequest?.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "project-a",
          runKind: "dependency-verify",
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
});
