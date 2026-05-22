import { create } from "zustand";
import {
  listPinsForScene,
  listAllPinsForProject,
  addPin,
  removePin,
} from "./sceneCodexPinsApi";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

interface SceneCodexPinsState {
  // Map from sceneId to array of entryIds (sorted by createdAt asc)
  pinsByScene: Record<string, string[]>;
  /** loadAllForProject 完了済みの projectId。未設定時のみ per-scene フォールバック。 */
  bulkLoadedProjectId: string | null;

  loadPinsForScene: (sceneId: string) => Promise<void>;
  loadAllForProject: (projectId: string) => Promise<void>;
  addPin: (sceneId: string, entryId: string) => Promise<void>;
  removePin: (sceneId: string, entryId: string) => Promise<void>;
}

function groupPinsByScene(
  rows: Array<{ sceneId: string; entryId: string }>,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    grouped[row.sceneId] ??= [];
    grouped[row.sceneId].push(row.entryId);
  }
  return grouped;
}

export const useSceneCodexPinsStore = create<SceneCodexPinsState>()(
  (set, get) => ({
    pinsByScene: {},
    bulkLoadedProjectId: null,

    loadAllForProject: async (projectId) => {
      const rows = await listAllPinsForProject(projectId);
      set({
        pinsByScene: groupPinsByScene(rows),
        bulkLoadedProjectId: projectId,
      });
    },

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
      const wasAlreadyPinned = (get().pinsByScene[sceneId] ?? []).includes(
        entryId,
      );
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
        return;
      }

      if (wasAlreadyPinned) return;
      if (useGlobalHistoryStore.getState().isReplaying) return;

      useGlobalHistoryStore.getState().push({
        kind: "pins",
        label: "ピン追加",
        async undo() {
          await removePin(sceneId, entryId);
          set((s) => ({
            pinsByScene: {
              ...s.pinsByScene,
              [sceneId]: (s.pinsByScene[sceneId] ?? []).filter(
                (id) => id !== entryId,
              ),
            },
          }));
        },
        async redo() {
          await addPin(sceneId, entryId);
          set((s) => ({
            pinsByScene: {
              ...s.pinsByScene,
              [sceneId]: [
                ...new Set([...(s.pinsByScene[sceneId] ?? []), entryId]),
              ],
            },
          }));
        },
      });
    },

    removePin: async (sceneId, entryId) => {
      const prev = get().pinsByScene[sceneId] ?? [];
      const wasPinned = prev.includes(entryId);
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
        return;
      }

      if (!wasPinned) return;
      if (useGlobalHistoryStore.getState().isReplaying) return;

      // pin はゴミ箱対象外 (再作成が安価で trash 価値が薄いため)。
      // Global Undo (Ctrl+Z) のみで復元する。
      useGlobalHistoryStore.getState().push({
        kind: "pins",
        label: "ピン解除",
        async undo() {
          await addPin(sceneId, entryId);
          set((s) => ({
            pinsByScene: {
              ...s.pinsByScene,
              [sceneId]: [
                ...new Set([...(s.pinsByScene[sceneId] ?? []), entryId]),
              ],
            },
          }));
        },
        async redo() {
          await removePin(sceneId, entryId);
          set((s) => ({
            pinsByScene: {
              ...s.pinsByScene,
              [sceneId]: (s.pinsByScene[sceneId] ?? []).filter(
                (id) => id !== entryId,
              ),
            },
          }));
        },
      });
    },
  }),
);
