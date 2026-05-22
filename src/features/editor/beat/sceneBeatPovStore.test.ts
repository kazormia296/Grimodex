import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSceneBeatPovStore } from "./sceneBeatPovStore";

vi.mock("./beatPovCacheApi", () => ({
  listAllBeatPovForProject: vi.fn(),
}));

import { listAllBeatPovForProject } from "./beatPovCacheApi";

const mockListAllBeatPovForProject = vi.mocked(listAllBeatPovForProject);

describe("sceneBeatPovStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSceneBeatPovStore.setState({
      povIdsByScene: {},
      bulkLoadedProjectId: null,
    });
  });

  it("groups beat POV ids by scene on loadAllForProject", async () => {
    mockListAllBeatPovForProject.mockResolvedValue([
      { sceneId: "s1", povCharacterId: "c1" },
      { sceneId: "s1", povCharacterId: "c2" },
      { sceneId: "s2", povCharacterId: "c3" },
    ]);

    await useSceneBeatPovStore.getState().loadAllForProject("proj-1");

    expect(useSceneBeatPovStore.getState().bulkLoadedProjectId).toBe("proj-1");
    expect(useSceneBeatPovStore.getState().povIdsByScene).toEqual({
      s1: ["c1", "c2"],
      s2: ["c3"],
    });
  });
});
