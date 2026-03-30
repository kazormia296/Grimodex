import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSceneStore } from "./store";

vi.mock("./api", () => ({
  listScenes: vi.fn().mockResolvedValue([
    {
      id: "scene-1",
      chapterId: 1,
      title: "シーン 1",
      sortOrder: 0,
      synopsis: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    },
  ]),
  createScene: vi.fn().mockImplementation((data) =>
    Promise.resolve({
      ...data,
      synopsis: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    }),
  ),
  deleteScene: vi.fn().mockResolvedValue(undefined),
  updateScene: vi.fn().mockImplementation((id, data) =>
    Promise.resolve({
      id,
      chapterId: 1,
      ...data,
      sortOrder: 0,
      synopsis: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    }),
  ),
  renameSceneContent: vi.fn().mockResolvedValue(undefined),
}));

function resetStore() {
  useSceneStore.setState({
    scenes: [],
    activeSceneId: "",
    isLoading: false,
  });
}

describe("useSceneStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe("loadScenes", () => {
    it("loads scenes from API and sets first as active", async () => {
      await useSceneStore.getState().loadScenes(1);
      const { scenes, activeSceneId, isLoading } = useSceneStore.getState();
      expect(scenes).toHaveLength(1);
      expect(scenes[0].title).toBe("シーン 1");
      expect(activeSceneId).toBe("scene-1");
      expect(isLoading).toBe(false);
    });
  });

  describe("createScene", () => {
    it("adds a new scene via API", async () => {
      await useSceneStore.getState().loadScenes(1);
      await useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      expect(scenes).toHaveLength(2);
      expect(scenes[1].title).toBe("シーン 2");
    });

    it("assigns a unique id to each scene", async () => {
      await useSceneStore.getState().loadScenes(1);
      await useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      expect(scenes[0].id).not.toBe(scenes[1].id);
    });
  });

  describe("deleteScene", () => {
    it("removes the specified scene via API", async () => {
      await useSceneStore.getState().loadScenes(1);
      await useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      await useSceneStore.getState().deleteScene(scenes[1].id);
      expect(useSceneStore.getState().scenes).toHaveLength(1);
    });

    it("does not delete the last remaining scene", async () => {
      await useSceneStore.getState().loadScenes(1);
      await useSceneStore.getState().deleteScene("scene-1");
      expect(useSceneStore.getState().scenes).toHaveLength(1);
    });

    it("switches activeSceneId when active scene is deleted", async () => {
      await useSceneStore.getState().loadScenes(1);
      await useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      const firstId = scenes[0].id;
      const secondId = scenes[1].id;
      useSceneStore.getState().setActiveScene(firstId);
      await useSceneStore.getState().deleteScene(firstId);
      expect(useSceneStore.getState().activeSceneId).toBe(secondId);
    });
  });

  describe("renameScene", () => {
    it("updates the title of the specified scene via API", async () => {
      await useSceneStore.getState().loadScenes(1);
      await useSceneStore.getState().renameScene("scene-1", "プロローグ");
      expect(useSceneStore.getState().scenes[0].title).toBe("プロローグ");
    });
  });

  describe("setActiveScene", () => {
    it("switches the active scene", async () => {
      await useSceneStore.getState().loadScenes(1);
      await useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      const secondId = scenes[1].id;
      useSceneStore.getState().setActiveScene(secondId);
      expect(useSceneStore.getState().activeSceneId).toBe(secondId);
    });
  });
});
