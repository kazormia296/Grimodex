import { create } from "zustand";

export interface Scene {
  id: string;
  title: string;
  content: string;
}

interface SceneState {
  scenes: Scene[];
  activeSceneId: string;
  createScene: () => void;
  deleteScene: (id: string) => void;
  renameScene: (id: string, title: string) => void;
  setActiveScene: (id: string) => void;
  updateSceneContent: (id: string, content: string) => void;
}

function makeScene(title: string): Scene {
  return {
    id: crypto.randomUUID(),
    title,
    content: "",
  };
}

const initialScene = makeScene("シーン 1");

export const useSceneStore = create<SceneState>()((set, get) => ({
  scenes: [initialScene],
  activeSceneId: initialScene.id,

  createScene: () => {
    const { scenes } = get();
    const scene = makeScene(`シーン ${scenes.length + 1}`);
    set({ scenes: [...scenes, scene] });
  },

  deleteScene: (id) => {
    const { scenes, activeSceneId } = get();
    if (scenes.length <= 1) return;
    const remaining = scenes.filter((s) => s.id !== id);
    const newActive = activeSceneId === id ? remaining[0].id : activeSceneId;
    set({ scenes: remaining, activeSceneId: newActive });
  },

  renameScene: (id, title) => {
    set((state) => ({
      scenes: state.scenes.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  },

  setActiveScene: (id) => {
    set({ activeSceneId: id });
  },

  updateSceneContent: (id, content) => {
    set((state) => ({
      scenes: state.scenes.map((s) => (s.id === id ? { ...s, content } : s)),
    }));
  },
}));
