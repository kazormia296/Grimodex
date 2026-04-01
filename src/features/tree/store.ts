import { create } from "zustand";
import * as api from "./api";

export interface SceneMeta {
  id: string;
  title: string;
  sortOrder: number;
}

interface SceneState {
  scenes: SceneMeta[];
  activeSceneId: string;
  isLoading: boolean;
  projectId: string;
  chapterId: string;
  loadScenes: (projectId: string, chapterId: string) => Promise<void>;
  createScene: () => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  renameScene: (id: string, title: string) => Promise<void>;
  setActiveScene: (id: string) => void;
}

export const useSceneStore = create<SceneState>()((set, get) => ({
  scenes: [],
  activeSceneId: "",
  isLoading: false,
  projectId: "default-project",
  chapterId: "default-chapter",

  loadScenes: async (projectId: string, chapterId: string) => {
    set({ isLoading: true, projectId, chapterId });
    let rows = await api.listNodes(projectId, chapterId);
    // Filter to scene nodes only
    rows = rows.filter((r) => r.nodeType === "scene");
    if (rows.length === 0) {
      const id = crypto.randomUUID();
      const created = await api.createNode({
        id,
        projectId,
        parentId: chapterId,
        nodeType: "scene",
        title: "シーン 1",
        sortOrder: 0,
      });
      rows = [created];
    }
    const scenes: SceneMeta[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      sortOrder: r.sortOrder,
    }));
    set({
      scenes,
      activeSceneId: scenes[0]?.id ?? "",
      isLoading: false,
    });
  },

  createScene: async () => {
    const { scenes, projectId, chapterId } = get();
    const id = crypto.randomUUID();
    const sortOrder = scenes.length;
    const title = `シー��� ${scenes.length + 1}`;
    const created = await api.createNode({
      id,
      projectId,
      parentId: chapterId,
      nodeType: "scene",
      title,
      sortOrder,
    });
    set({
      scenes: [
        ...scenes,
        { id: created.id, title: created.title, sortOrder: created.sortOrder },
      ],
    });
  },

  deleteScene: async (id) => {
    const { scenes, activeSceneId } = get();
    if (scenes.length <= 1) return;
    await api.deleteNode(id);
    const remaining = scenes.filter((s) => s.id !== id);
    const newActive = activeSceneId === id ? remaining[0].id : activeSceneId;
    set({ scenes: remaining, activeSceneId: newActive });
  },

  renameScene: async (id, title) => {
    await api.updateNode(id, { title });
    const scene = get().scenes.find((s) => s.id === id);
    if (scene) {
      const { chapterId } = get();
      // Get parent sort order for file naming
      const parent = await api.getNode(chapterId);
      const chapterOrder = Math.round(parent?.sortOrder ?? 0);
      await api.renameSceneContent(id, title, chapterOrder, scene.sortOrder);
    }
    set((state) => ({
      scenes: state.scenes.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  },

  setActiveScene: (id) => {
    set({ activeSceneId: id });
  },
}));
