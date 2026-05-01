import { create } from "zustand";
import { listPinsForScene, addPin, removePin } from "./sceneCodexPinsApi";

interface SceneCodexPinsState {
  // Map from sceneId to array of entryIds (sorted by createdAt asc)
  pinsByScene: Record<string, string[]>;

  loadPinsForScene: (sceneId: string) => Promise<void>;
  addPin: (sceneId: string, entryId: string) => Promise<void>;
  removePin: (sceneId: string, entryId: string) => Promise<void>;
}

export const useSceneCodexPinsStore = create<SceneCodexPinsState>()(
  (set, get) => ({
    pinsByScene: {},

    loadPinsForScene: async (sceneId) => {
      const rows = await listPinsForScene(sceneId);
      set((s) => ({
        pinsByScene: {
          ...s.pinsByScene,
          [sceneId]: rows.map((r) => r.entryId),
        },
      }));
    },

    addPin: async (sceneId, entryId) => {
      // Optimistic update
      set((s) => ({
        pinsByScene: {
          ...s.pinsByScene,
          [sceneId]: [...new Set([...(s.pinsByScene[sceneId] ?? []), entryId])],
        },
      }));
      try {
        await addPin(sceneId, entryId);
      } catch {
        // Rollback
        set((s) => ({
          pinsByScene: {
            ...s.pinsByScene,
            [sceneId]: (s.pinsByScene[sceneId] ?? []).filter(
              (id) => id !== entryId,
            ),
          },
        }));
      }
    },

    removePin: async (sceneId, entryId) => {
      const prev = get().pinsByScene[sceneId] ?? [];
      // Optimistic update
      set((s) => ({
        pinsByScene: {
          ...s.pinsByScene,
          [sceneId]: (s.pinsByScene[sceneId] ?? []).filter(
            (id) => id !== entryId,
          ),
        },
      }));
      try {
        await removePin(sceneId, entryId);
      } catch {
        // Rollback
        set((s) => ({
          pinsByScene: { ...s.pinsByScene, [sceneId]: prev },
        }));
      }
    },
  }),
);
