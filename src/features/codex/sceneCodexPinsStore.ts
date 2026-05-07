import { create } from "zustand";
import { listPinsForScene, addPin, removePin } from "./sceneCodexPinsApi";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCodexStore } from "./codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { capturePinDeletion } from "@/features/trash-bin/captureHooks";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";

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

      // Trash 連携: pin の解除をゴミ箱にキャプチャ。
      // 表示用に削除時点の scene title / entry name / icon をスナップショット。
      const tree = useTreeStore.getState();
      const codex = useCodexStore.getState();
      const sceneNode = tree.nodes.find((n) => n.id === sceneId);
      const entry = codex.entries.find((e) => e.id === entryId);
      const projectId = sceneNode?.projectId ?? tree.projectId;
      const trashTempId = `trash-pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sceneId}-${entryId}`;
      capturePinDeletion({
        projectId,
        sceneId,
        entryId,
        sceneTitleHint: sceneNode?.title ?? null,
        entryNameHint: entry?.name ?? null,
        entryIconHint: entry?.icon ?? null,
        tempId: trashTempId,
      });

      useGlobalHistoryStore.getState().push({
        kind: "pins",
        label: "ピン解除",
        async undo() {
          // 1500ms 以内 Ctrl+Z 吸収: trash 保留を cancel
          useTrashBinStore.getState().cancelPending({ tempId: trashTempId });
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
