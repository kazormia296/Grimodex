import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { narrativeMaintenanceStaleProposalScenes } from "./nativeApi";

describe("narrativeMaintenanceStaleProposalScenes", () => {
  beforeEach(() => invokeMock.mockReset());

  it("passes the page request and returns a validated page", async () => {
    const response = {
      scenes: [
        { sceneId: "scene-a", proposalCount: 2 },
        { sceneId: "scene-b", proposalCount: 1 },
      ],
      withoutSceneCount: 3,
      nextCursor: "scene-b",
    };
    invokeMock.mockResolvedValue(response);
    await expect(
      narrativeMaintenanceStaleProposalScenes({
        projectId: "project-1",
        cursor: "scene-0",
        limit: 20,
      }),
    ).resolves.toEqual(response);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "narrative_maintenance_stale_proposal_scenes",
      {
        payload: { projectId: "project-1", cursor: "scene-0", limit: 20 },
      },
    );
  });

  it.each([
    null,
    [],
    {},
    { scenes: [], withoutSceneCount: -1 },
    { scenes: [], withoutSceneCount: 1.5 },
    { scenes: "scene-a", withoutSceneCount: 0 },
    {
      scenes: [{ sceneId: "scene-a", proposalCount: 0 }],
      withoutSceneCount: 0,
    },
    {
      scenes: [{ sceneId: "scene-a", proposalCount: "1" }],
      withoutSceneCount: 0,
    },
    { scenes: [], withoutSceneCount: 0, nextCursor: "" },
  ])(
    "throws when the native response has an invalid shape: %j",
    async (response) => {
      invokeMock.mockResolvedValue(response);
      await expect(
        narrativeMaintenanceStaleProposalScenes({ projectId: "project-1" }),
      ).rejects.toThrow(/narrative_maintenance_stale_proposal_scenes/);
    },
  );

  it("does not catch invoke failures", async () => {
    invokeMock.mockRejectedValueOnce(new Error("native failed"));
    await expect(
      narrativeMaintenanceStaleProposalScenes({ projectId: "project-1" }),
    ).rejects.toThrow("native failed");
  });
});
