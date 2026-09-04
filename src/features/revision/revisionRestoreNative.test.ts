import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
const recorderMocks = vi.hoisted(() => ({
  flushStrict: vi.fn(() => Promise.resolve()),
  acquireTimelapseReplacementFence: vi.fn(() => ({
    commit: vi.fn(),
    release: vi.fn(),
  })),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/timelapse/recorder", () => recorderMocks);

import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { _resetTimelapseGenesisBarriersForTests } from "@/features/timelapse/genesisBarrier";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { restoreSceneRevisionNative } from "./revisionRestoreNative";

describe("restoreSceneRevisionNative", () => {
  beforeEach(() => {
    _resetTimelapseGenesisBarriersForTests();
    publishCurrentProjectId("project-1");
    setCurrentWorkspaceIdentity({
      path: "/workspace/revision-restore-native.test.gdx",
      openRevision: 1,
    });

    recorderMocks.flushStrict.mockClear();
    recorderMocks.acquireTimelapseReplacementFence.mockClear();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({
      sceneId: "scene-1",
      version: 5,
    });
  });

  it("passes the immutable restore authority tuple through one typed command", async () => {
    const payload = {
      requestId: "request-1",
      sessionId: "session-1",
      projectId: "project-1",
      entityType: "scene" as const,
      entityId: "scene-1",
      revisionId: "revision-1",
      content: '{"type":"doc"}',
      currentContent: '{"type":"doc","content":[]}',
      expectedVersion: 4,
      charCount: 0,
      placedBeatPreview: null,
    };

    await restoreSceneRevisionNative(payload);

    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "revision_scene_restore",
      { payload },
    );
  });
});
