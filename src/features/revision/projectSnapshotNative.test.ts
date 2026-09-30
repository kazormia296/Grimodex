import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));

import { applyNativeProjectSnapshotRestore } from "./projectSnapshotNative";

describe("applyNativeProjectSnapshotRestore", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({
      canonicalSequence: 12,
      changeEventUid: "change-1",
      maintenanceTransactionId: "maintenance-1",
    });
  });

  it("keeps one request/session authority tuple on the Native aggregate", async () => {
    const payload = {
      requestId: "snapshot-restore-request-1",
      sessionId: "session-1",
      projectId: "project-1",
      snapshotId: "snapshot-1",
      scopes: ["body" as const],
      inserts: [
        {
          table: "tree_nodes" as const,
          row: { id: "scene-1", project_id: "project-1" },
          mode: "insert" as const,
        },
      ],
    };

    await expect(applyNativeProjectSnapshotRestore(payload)).resolves.toEqual({
      canonicalSequence: 12,
      changeEventUid: "change-1",
      maintenanceTransactionId: "maintenance-1",
    });

    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "project_snapshot_apply_restore",
      { payload },
    );
  });
});
