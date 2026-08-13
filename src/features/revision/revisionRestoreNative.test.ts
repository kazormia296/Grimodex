import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));

import { restoreSceneRevisionNative } from "./revisionRestoreNative";

describe("restoreSceneRevisionNative", () => {
  beforeEach(() => {
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
