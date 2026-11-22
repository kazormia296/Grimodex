import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));

import {
  applyNativeProjectSnapshotRestore,
  loadNativeProjectSnapshotRestoreContext,
} from "./projectSnapshotNative";

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

// DR-SRX-10: the response grows an optional list of what a restore does not
// give back. The wrappers hand the response on as it is, so a screen written
// before the list existed reads a response with it, and a screen written after
// reads a response without it (an older Native build, a stored retry).
describe("restore loss notices on the Native responses", () => {
  const base = {
    structural: true,
    liveTables: [],
    treeRows: [],
    codexRows: [],
    snippetRows: [],
    auxRows: [],
    contentRows: [],
    liveCodexIds: [],
    liveCodexPhaseIds: [],
    liveTreeNodeIds: [],
    liveSnippetIds: [],
    liveEventIds: [],
    liveCodexTagIds: [],
  };

  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("hands the context on with and without the notices", async () => {
    mocks.invoke.mockResolvedValueOnce({
      ...base,
      lossNotices: [{ kind: "event_participants", count: 2 }],
    });
    const withNotices = await loadNativeProjectSnapshotRestoreContext(
      "project-1",
      "snapshot-1",
      new Set(["codex" as const]),
    );
    expect(withNotices.lossNotices).toEqual([
      { kind: "event_participants", count: 2 },
    ]);

    mocks.invoke.mockResolvedValueOnce(base);
    const without = await loadNativeProjectSnapshotRestoreContext(
      "project-1",
      "snapshot-1",
      new Set(["codex" as const]),
    );
    expect(without.lossNotices).toBeUndefined();
    expect(without.liveCodexTagIds).toEqual([]);
  });

  it("hands the restore result on with and without what was dropped", async () => {
    const payload = {
      requestId: "r1",
      sessionId: "s1",
      projectId: "project-1",
      snapshotId: "snapshot-1",
      scopes: ["body" as const],
      inserts: [],
    };
    mocks.invoke.mockResolvedValueOnce({
      canonicalSequence: 3,
      noOp: false,
      dropped: [{ kind: "ai_scene_proposals", count: 1 }],
    });
    await expect(applyNativeProjectSnapshotRestore(payload)).resolves.toEqual({
      canonicalSequence: 3,
      noOp: false,
      dropped: [{ kind: "ai_scene_proposals", count: 1 }],
    });

    mocks.invoke.mockResolvedValueOnce({ canonicalSequence: 3, noOp: true });
    const stored = await applyNativeProjectSnapshotRestore(payload);
    expect(stored.dropped).toBeUndefined();
  });
});
