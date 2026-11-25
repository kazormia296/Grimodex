import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { narrativeMaintenanceStaleProposalCount } from "./nativeApi";

describe("narrativeMaintenanceStaleProposalCount", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes with projectId and returns count", async () => {
    invokeMock.mockResolvedValue({ count: 3 });
    await expect(
      narrativeMaintenanceStaleProposalCount({ projectId: "project-1" }),
    ).resolves.toBe(3);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "narrative_maintenance_stale_proposal_count",
      { payload: { projectId: "project-1" } },
    );
  });

  it.each([
    null,
    [],
    { count: -1 },
    { count: 1.5 },
    { count: "3" },
    { count: Number.MAX_SAFE_INTEGER + 1 },
    {},
  ])("rejects an invalid count response: %j", async (response) => {
    invokeMock.mockResolvedValue(response);
    await expect(
      narrativeMaintenanceStaleProposalCount({ projectId: "p" }),
    ).rejects.toThrow(/expected a non-negative safe integer count/);
  });

  it("does not catch invoke failures", async () => {
    invokeMock.mockRejectedValueOnce(new Error("native failed"));
    await expect(
      narrativeMaintenanceStaleProposalCount({ projectId: "p" }),
    ).rejects.toThrow("native failed");
  });
});
