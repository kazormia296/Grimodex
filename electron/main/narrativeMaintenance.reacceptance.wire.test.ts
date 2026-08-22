import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceScheduler,
  type NarrativeMaintenanceRequest,
} from "./narrativeMaintenance.js";

const INITIAL_DELAY_MS = 250;
const BACKLOG_DELAY_MS = 10;

function backfill(projectId: string): NarrativeMaintenanceRequest {
  return {
    projectId,
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    reason: "wire-contract",
  };
}

describe("narrative maintenance strict wire boundary", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the authority binding at cycle top-level, never inside work items", async () => {
    const binding = { authorityId: "authority-wire", generation: 7 };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const scheduler = createNarrativeMaintenanceScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill("wire-project"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    const payload = runNarrativeMaintenanceCycle.mock.calls[0]?.[0];
    expect(payload.workspaceBinding).toEqual(binding);
    expect(payload.work[0]).not.toHaveProperty("workspaceBinding");
    scheduler.dispose();
  });

  it("round-trips a native JSON binding through the typed scheduler request", async () => {
    const binding = {
      authorityId: "workspace:wire-roundtrip",
      generation: Number.MAX_SAFE_INTEGER,
    };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const scheduler = createNarrativeMaintenanceScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => JSON.stringify(binding),
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill("wire-roundtrip-project"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].workspaceBinding).toEqual(
      binding,
    );
    scheduler.dispose();
  });

  it("bounds a durable wake batch to the same 32-project cycle limit", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "accepted", hasMore: true });
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    for (let index = 0; index < 33; index += 1) {
      scheduler.request(backfill(`wake-project-${index}`));
    }
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    const wakeCall = runNarrativeMaintenanceCycle.mock.calls[2]?.[0];
    expect(wakeCall.work).toHaveLength(0);
    expect(wakeCall.wakeProjectIds).toHaveLength(32);
    scheduler.dispose();
  });
});
