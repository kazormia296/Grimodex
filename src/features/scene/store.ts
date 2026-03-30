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
  loadScenes: (chapterId: number) => Promise<void>;
  createScene: () => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  renameScene: (id: string, title: string) => Promise<void>;
  setActiveScene: (id: string) => void;
}

const TEMP_CHAPTER_ID = 1;

export const useSceneStore = create<SceneState>()((set, get) => ({
  scenes: [],
  activeSceneId: "",
  isLoading: false,

  loadScenes: async (chapterId: number) => {
    set({ isLoading: true });
    const rows = await api.listScenes(chapterId);
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
    const { scenes } = get();
    const id = crypto.randomUUID();
    const sortOrder = scenes.length;
    const title = `シーン ${scenes.length + 1}`;
    const created = await api.createScene({
      id,
      chapterId: TEMP_CHAPTER_ID,
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
    await api.deleteScene(id);
    const remaining = scenes.filter((s) => s.id !== id);
    const newActive = activeSceneId === id ? remaining[0].id : activeSceneId;
    set({ scenes: remaining, activeSceneId: newActive });
  },

  renameScene: async (id, title) => {
    await api.updateScene(id, { title });
    set((state) => ({
      scenes: state.scenes.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  },

  setActiveScene: (id) => {
    set({ activeSceneId: id });
  },
}));
