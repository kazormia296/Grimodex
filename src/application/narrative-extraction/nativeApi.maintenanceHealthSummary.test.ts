import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { narrativeMaintenanceHealthSummary } from "./nativeApi";

const summary = {
  proposalsChecked: 6,
  proposalsStale: 3,
  staleBreakdown: {
    stale: 1,
    "source-missing": 1,
    "anchor-mismatch": 0,
    "read-set-drift": 0,
    unknown: 1,
  },
  maintenanceStopped: 2,
  unrecognized: 4,
};

describe("narrativeMaintenanceHealthSummary", () => {
  beforeEach(() => invokeMock.mockReset());

  it("reads by project and returns the validated summary", async () => {
    invokeMock.mockResolvedValue(summary);
    await expect(
      narrativeMaintenanceHealthSummary({ projectId: "project-1" }),
    ).resolves.toEqual(summary);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "narrative_maintenance_health_summary",
      { payload: { projectId: "project-1" } },
    );
  });

  it.each([
    null,
    [],
    {},
    { ...summary, proposalsChecked: -1 },
    { ...summary, proposalsStale: 1.5 },
    { ...summary, proposalsStale: Number.MAX_SAFE_INTEGER + 1 },
    { ...summary, maintenanceStopped: -1 },
    { ...summary, unrecognized: "4" },
    { ...summary, staleBreakdown: undefined },
    {
      ...summary,
      staleBreakdown: { ...summary.staleBreakdown, unknown: -1 },
    },
    {
      ...summary,
      staleBreakdown: {
        stale: 1,
        "source-missing": 1,
        "anchor-mismatch": 0,
        "read-set-drift": 0,
      },
    },
    {
      ...summary,
      staleBreakdown: {
        ...summary.staleBreakdown,
        unknown: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ])("rejects an invalid native response: %j", async (response) => {
    invokeMock.mockResolvedValue(response);
    await expect(
      narrativeMaintenanceHealthSummary({ projectId: "project-1" }),
    ).rejects.toThrow("narrative_maintenance_health_summary");
  });

  it("does not catch invoke failures", async () => {
    invokeMock.mockRejectedValueOnce(new Error("native failed"));
    await expect(
      narrativeMaintenanceHealthSummary({ projectId: "project-1" }),
    ).rejects.toThrow("native failed");
  });
});
