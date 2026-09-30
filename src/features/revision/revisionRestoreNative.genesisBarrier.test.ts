import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentProjectId: "project-1",
}));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/application/project/currentProjectAuthority", () => ({
  getCurrentProjectId: () => mocks.currentProjectId,
}));

import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "@/features/timelapse/genesisBarrier";
import {
  restoreSceneRevisionNative,
  type RestoreSceneRevisionPayload,
} from "./revisionRestoreNative";

const payload: RestoreSceneRevisionPayload = {
  requestId: "request-1",
  sessionId: "session-1",
  projectId: "project-1",
  entityType: "scene",
  entityId: "scene-1",
  revisionId: "revision-1",
  content: '{"type":"doc","content":[]}',
  currentContent: '{"type":"doc","content":[{"type":"paragraph"}]}',
  expectedVersion: 4,
  charCount: 0,
  placedBeatPreview: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetTimelapseGenesisBarriersForTests();
  mocks.currentProjectId = "project-1";
  mocks.invoke.mockResolvedValue({
    sceneId: "scene-1",
    revisionId: "revision-1",
    safetyRevisionId: "safety-1",
    version: 5,
    updatedAt: "2026-08-31T00:00:00.000Z",
    changeEventUid: "change-1",
    canonicalSequence: 1,
    maintenanceTransactionId: "maintenance-1",
    replayed: false,
  });
});

describe("restoreSceneRevisionNative genesis barrier", () => {
  it("does not invoke the Native restore while genesis is pending", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const restore = restoreSceneRevisionNative(payload);

    await Promise.resolve();
    const callsBeforeRelease = mocks.invoke.mock.calls.length;
    genesis.complete();
    await restore;

    expect(callsBeforeRelease).toBe(0);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "revision_scene_restore",
      { payload },
    );
  });

  it("fails closed without invoking Native after genesis failure", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const failure = new Error("genesis E1");
    genesis.fail(failure);

    await expect(restoreSceneRevisionNative(payload)).rejects.toMatchObject({
      name: "TimelapseGenesisBarrierError",
      cause: failure,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
