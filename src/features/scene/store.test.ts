import { describe, it, expect, beforeEach } from "vitest";
import { useSceneStore } from "./store";

function resetStore() {
  useSceneStore.setState(useSceneStore.getInitialState());
}

describe("useSceneStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("starts with one default scene", () => {
      const { scenes } = useSceneStore.getState();
      expect(scenes).toHaveLength(1);
      expect(scenes[0].title).toBe("シーン 1");
    });

    it("selects the first scene by default", () => {
      const { scenes, activeSceneId } = useSceneStore.getState();
      expect(activeSceneId).toBe(scenes[0].id);
    });
  });

  describe("createScene", () => {
    it("adds a new scene with default title", () => {
      useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      expect(scenes).toHaveLength(2);
      expect(scenes[1].title).toBe("シーン 2");
    });

    it("assigns a unique id to each scene", () => {
      useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      expect(scenes[0].id).not.toBe(scenes[1].id);
    });

    it("initializes new scene with empty content", () => {
      useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      expect(scenes[1].content).toBe("");
    });
  });

  describe("deleteScene", () => {
    it("removes the specified scene", () => {
      useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      const idToDelete = scenes[1].id;
      useSceneStore.getState().deleteScene(idToDelete);
      expect(useSceneStore.getState().scenes).toHaveLength(1);
    });

    it("does not delete the last remaining scene", () => {
      const { scenes } = useSceneStore.getState();
      useSceneStore.getState().deleteScene(scenes[0].id);
      expect(useSceneStore.getState().scenes).toHaveLength(1);
    });

    it("switches activeSceneId when active scene is deleted", () => {
      useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      const firstId = scenes[0].id;
      const secondId = scenes[1].id;
      useSceneStore.getState().setActiveScene(firstId);
      useSceneStore.getState().deleteScene(firstId);
      expect(useSceneStore.getState().activeSceneId).toBe(secondId);
    });
  });

  describe("renameScene", () => {
    it("updates the title of the specified scene", () => {
      const { scenes } = useSceneStore.getState();
      useSceneStore.getState().renameScene(scenes[0].id, "プロローグ");
      expect(useSceneStore.getState().scenes[0].title).toBe("プロローグ");
    });

    it("does nothing for a non-existent scene id", () => {
      useSceneStore.getState().renameScene("nonexistent", "test");
      expect(useSceneStore.getState().scenes[0].title).toBe("シーン 1");
    });
  });

  describe("setActiveScene", () => {
    it("switches the active scene", () => {
      useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      const secondId = scenes[1].id;
      useSceneStore.getState().setActiveScene(secondId);
      expect(useSceneStore.getState().activeSceneId).toBe(secondId);
    });
  });

  describe("updateSceneContent", () => {
    it("updates content for the specified scene", () => {
      const { scenes } = useSceneStore.getState();
      useSceneStore.getState().updateSceneContent(scenes[0].id, "本文テスト");
      expect(useSceneStore.getState().scenes[0].content).toBe("本文テスト");
    });

    it("preserves content of other scenes", () => {
      useSceneStore.getState().createScene();
      const { scenes } = useSceneStore.getState();
      useSceneStore
        .getState()
        .updateSceneContent(scenes[0].id, "シーン1の内容");
      useSceneStore
        .getState()
        .updateSceneContent(scenes[1].id, "シーン2の内容");
      const updated = useSceneStore.getState().scenes;
      expect(updated[0].content).toBe("シーン1の内容");
      expect(updated[1].content).toBe("シーン2の内容");
    });
  });

  describe("getActiveScene selector", () => {
    it("returns the currently active scene", () => {
      const state = useSceneStore.getState();
      const active = state.scenes.find((s) => s.id === state.activeSceneId);
      expect(active).toBeDefined();
      expect(active?.title).toBe("シーン 1");
    });
  });
});
