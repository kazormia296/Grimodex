import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runTreeTopologyMutation: vi.fn(),
  loadContext: vi.fn(),
  createSnapshot: vi.fn(),
  applyRestore: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("@/application/tree/treeTopologyMutationRegistry", () => ({
  runTreeTopologyMutation: mocks.runTreeTopologyMutation,
}));
vi.mock("./projectSnapshotNative", () => ({
  loadNativeProjectSnapshotRestoreContext: mocks.loadContext,
  createNativeProjectSnapshot: mocks.createSnapshot,
  applyNativeProjectSnapshotRestore: mocks.applyRestore,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "session-1",
  flushStrict: () => Promise.resolve(),
  acquireTimelapseReplacementFence: () => ({
    commit() {},
    release() {},
  }),
}));

import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "@/features/timelapse/genesisBarrier";
import { restoreProjectSnapshot } from "./projectSnapshotApi";

beforeEach(() => {
  vi.clearAllMocks();
  _resetTimelapseGenesisBarriersForTests();
});

describe("project snapshot structural restore genesis barrier", () => {
  it("waits before topology dispatch, Native reads, or safety writes", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const restore = restoreProjectSnapshot("snapshot-1", "checkpoint");

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.runTreeTopologyMutation).not.toHaveBeenCalled();
    expect(mocks.loadContext).not.toHaveBeenCalled();
    expect(mocks.createSnapshot).not.toHaveBeenCalled();
    expect(mocks.applyRestore).not.toHaveBeenCalled();

    genesis.fail(new Error("stop pending restore"));
    await expect(restore).rejects.toMatchObject({
      name: "TimelapseGenesisBarrierError",
    });
  });

  it("fails closed without any restore side effect after genesis failure", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    genesis.fail(new Error("genesis failed"));

    await expect(
      restoreProjectSnapshot("snapshot-1", "checkpoint"),
    ).rejects.toMatchObject({ name: "TimelapseGenesisBarrierError" });
    expect(mocks.runTreeTopologyMutation).not.toHaveBeenCalled();
    expect(mocks.loadContext).not.toHaveBeenCalled();
    expect(mocks.createSnapshot).not.toHaveBeenCalled();
    expect(mocks.applyRestore).not.toHaveBeenCalled();
  });
});
